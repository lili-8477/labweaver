// The memory share kind: a user's memory, frozen into snapshot_meta on
// submit and inserted as an org memory (username ORG_USER) on approve.

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Domain } from "./memory-domain.js";
import { insertMemoryRow } from "./distiller-repo.js";
import { contentHash } from "./content-hash.js";
import { appendAudit } from "./memory-audit.js";
import type { SubmitArgs, SubmitResult, ShareRow } from "./share-repo.js";
import { ORG_USER } from "./memory-dirs.js";

// Memory branch of submitShareRequest. Exported on its own because it needs
// no filesystem settings, so automatic promotion (experience-promotion.ts)
// can call it directly.
export async function submitMemoryShareRequest(
  args: Pick<SubmitArgs, "pool" | "managers" | "requester" | "ref" | "note">,
): Promise<SubmitResult> {
  if (args.managers.length === 0) {
    return { ok: false, reason: "no_manager" };
  }

  // Single-query ownership check + snapshot fetch. Folding these into one
  // round-trip both shrinks the race window between checking ownership and
  // freezing the body, AND turns "not owned / soft-deleted" into "no rows"
  // — same code path as the source not existing, so we don't leak which.
  const snap = await args.pool.query<{
    name:        string;
    description: string;
    body:        string;
    type:        string;
    source:      string;
    hit_count:   number;
    last_hit_at: Date | null;
    dir_key:       string;
    domain:        Domain;
    success_count: number;
    failure_count: number;
    access_class:  string;
    facets:      Record<string, string[]>;
  }>(
    `SELECT m.name, m.description, m.body, m.type, m.source, m.domain, m.access_class,
            m.hit_count, m.last_hit_at, m.dir_key, m.success_count, m.failure_count,
            COALESCE((SELECT jsonb_object_agg(key, vals)
                        FROM (
                          SELECT key,
                                 jsonb_agg(value ORDER BY value COLLATE "C") AS vals
                            FROM memory_facets
                           WHERE memory_id = m.memory_id
                           GROUP BY key
                        ) g), '{}'::jsonb) AS facets
       FROM memories m
      WHERE m.memory_id = $1
        AND m.username  = $2
        AND m.deleted_at IS NULL`,
    [args.ref, args.requester],
  );
  if ((snap.rowCount ?? 0) === 0) {
    return { ok: false, reason: "forbidden" };
  }
  const s = snap.rows[0]!;
  const snapshot_meta: Record<string, unknown> = {
    name:        s.name,
    description: s.description,
    body:        s.body,
    type:        s.type,
    source:      s.source,
    hit_count:   s.hit_count,
    last_hit_at: s.last_hit_at ? s.last_hit_at.toISOString() : null,
    dir_key:       s.dir_key,
    domain:        s.domain,
    success_count: s.success_count,
    failure_count: s.failure_count,
    access_class:  s.access_class,
    facets:      s.facets,
  };

  const share_id = randomUUID();
  await args.pool.query(
    `INSERT INTO share_requests
       (share_id, artifact_kind, artifact_ref, snapshot_meta,
        requester, reviewer, requester_note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      share_id,
      "memory",
      args.ref,
      snapshot_meta,
      args.requester,
      args.managers[0],
      args.note ?? null,
    ],
  );
  return { ok: true, share_id };
}

export type ApproveResult =
  | { ok: true; promotion_result: Record<string, unknown> }
  | { ok: false; reason: "promotion_failed"; detail?: string };

/** Promote an approved memory share into org memory, inside the caller's
 *  transaction. A content-hash match with an existing org memory dedups. */
export async function approveMemoryShareRequest(
  client:  PoolClient,
  row:     ShareRow,
  shareId: string,
): Promise<ApproveResult> {
  // Validate snapshot shape before trusting the cast. Older rows or
  // future externally-written snapshots could land here malformed; we'd
  // rather emit promotion_failed (auditable, recoverable) than crash
  // deep inside insertMemoryRow against a NOT NULL constraint.
  const rawSnap = row.snapshot_meta as Record<string, unknown>;
  if (
    typeof rawSnap.name        !== "string" ||
    typeof rawSnap.description !== "string" ||
    typeof rawSnap.body        !== "string" ||
    typeof rawSnap.type        !== "string" ||
    typeof rawSnap.facets      !== "object" || rawSnap.facets === null
  ) {
    return {
      ok:     false,
      reason: "promotion_failed",
      detail: "snapshot_meta is missing required string fields (name/description/body/type/facets)",
    };
  }
  const snap = rawSnap as {
    name:        string;
    description: string;
    body:        string;
    type:        string;
    dir_key?:    string;      // absent in snapshots taken before phase 4
    domain?:     Domain;      // absent in snapshots taken before the memory domain
    access_class?: string;    // absent in older snapshots; the column default applies
    facets:      Record<string, string[] | undefined>;
  };

  const hash = contentHash({ body: `${snap.name}\n${snap.body}`, promptVersion: 0 });

  const promotedId = await insertMemoryRow(client, {
    username:          ORG_USER,
    project_dir:       null,
    source:            "user",
    type:              snap.type,
    source_session_id: null,
    name:              snap.name,
    description:       snap.description,
    body:              snap.body,
    facets:            snap.facets,
    content_hash:      hash,
    // Experience is promoted as experience whatever its type; everything
    // else is filed by type (memory-dirs.ts defaultDir).
    dir_key:           snap.dir_key?.endsWith("/experience") ? "org/experience" : undefined,
    domain:            snap.domain ?? "lab",
    science:           { access_class: snap.access_class },
  });

  let promotion_result: Record<string, unknown>;

  if (promotedId !== null) {
    await appendAudit(client, {
      memory_id: promotedId,
      actor:     ORG_USER,
      action:    "write",
      before:    null,
      after:     {
        via:            "share_promotion",
        share_id:       shareId,
        promoted_from:  row.artifact_ref,
      },
    });
    promotion_result = { promoted_memory_id: promotedId, deduped: false };
  } else {
    // Dedup hit: look up the existing org row with same content_hash.
    const existing = await client.query<{ memory_id: string }>(
      `SELECT memory_id FROM memories
        WHERE username = $3 AND project_dir IS NULL
          AND type = $1 AND content_hash = $2`,
      [snap.type, hash, ORG_USER],
    );
    const existing_memory_id = (existing.rowCount ?? 0) > 0
      ? existing.rows[0]!.memory_id
      : null;
    promotion_result = { deduped: true, existing_memory_id, promoted_memory_id: null };
  }

  return { ok: true, promotion_result };
}

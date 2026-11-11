import type { Pool } from "pg";
import { submitMemoryShareRequest, approveMemoryShareRequest } from "./share-repo-memory.js";
import {
  submitSkillShareRequest,
  approveSkillShareRequest,
  submitSkillUpdateShareRequest,
  approveSkillUpdateShareRequest,   // NEW
} from "./share-repo-skill.js";
import {
  submitFolderShareRequest,
  approveFolderShareRequest,
} from "./share-repo-folder.js";

export type ArtifactKind = "memory" | "skill" | "folder" | "skill_update";
export type ShareStatus = "pending" | "approved" | "rejected" | "withdrawn" | "auto_rejected";

export interface ShareRequest {
  share_id:         string;
  artifact_kind:    ArtifactKind;
  artifact_ref:     string;
  snapshot_meta:    Record<string, unknown>;
  requester:        string;
  reviewer:         string;
  status:           ShareStatus;
  requester_note:   string | null;
  review_comment:   string | null;
  promotion_result: Record<string, unknown> | null;
  created_at:       string; // ISO
  decided_at:       string | null;
}

export { submitMemoryShareRequest };

// ─── row type returned directly from PG ────────────────────────────────────

export interface ShareRow {
  share_id:         string;
  artifact_kind:    string;
  artifact_ref:     string;
  snapshot_meta:    Record<string, unknown>;
  requester:        string;
  reviewer:         string;
  status:           string;
  requester_note:   string | null;
  review_comment:   string | null;
  promotion_result: Record<string, unknown> | null;
  created_at:       Date;
  decided_at:       Date | null;
}

function mapRow(r: ShareRow): ShareRequest {
  return {
    share_id:         r.share_id,
    artifact_kind:    r.artifact_kind as ArtifactKind,
    artifact_ref:     r.artifact_ref,
    snapshot_meta:    r.snapshot_meta,
    requester:        r.requester,
    reviewer:         r.reviewer,
    status:           r.status as ShareStatus,
    requester_note:   r.requester_note,
    review_comment:   r.review_comment,
    promotion_result: r.promotion_result,
    created_at:       r.created_at.toISOString(),
    decided_at:       r.decided_at ? r.decided_at.toISOString() : null,
  };
}

// ─── 1. submitShareRequest ──────────────────────────────────────────────────

export interface SubmitArgs {
  pool:               Pool;
  managers:           string[];
  requester:          string;
  kind:               ArtifactKind;
  ref:                string;
  note?:              string;
  // Phase 2: required for the skill branch. Memory branch ignores them.
  workspacesRoot:     string;        // e.g. "/workspaces"
  shareSnapshotsDir:  string;        // e.g. "/workspaces/shared/.share-snapshots"
  // Phase 3: required for the folder branch. Other branches ignore it.
  maxFolderBytes:     number;        // e.g. 100 * 1024 * 1024
}

export type SubmitResult =
  | { ok: true; share_id: string }
  | { ok: false; reason:
        | "no_manager"
        | "not_implemented"
        | "forbidden"
        | "invalid_ref"
        | "source_not_found"
        | "missing_manifest"
        | "snapshot_failed"
        | "oversize"
        | "target_not_found";
      detail?: string };

export async function submitShareRequest(args: SubmitArgs): Promise<SubmitResult> {
  if (args.managers.length === 0) {
    return { ok: false, reason: "no_manager" };
  }
  if (args.kind === "skill") {
    return await submitSkillShareRequest(args);
  }
  if (args.kind === "folder") {
    return await submitFolderShareRequest(args);
  }
  if (args.kind === "skill_update") {
    return await submitSkillUpdateShareRequest(args);
  }
  if (args.kind !== "memory") {
    return { ok: false, reason: "not_implemented" };
  }
  return await submitMemoryShareRequest(args);
}

// ─── 2. listShareRequests ───────────────────────────────────────────────────

export interface ListArgs {
  pool:     Pool;
  actor:    string;
  managers: string[];
  role:     "outbox" | "inbox" | "all";
  status?: ShareStatus;
  limit?:  number;
  cursor?: string; // ISO created_at; rows with created_at < cursor
}

export interface ListResult {
  items:       ShareRequest[];
  next_cursor: string | null;
}

export async function listShareRequests(args: ListArgs): Promise<ListResult> {
  const limit = Math.min(args.limit ?? 50, 200);

  // inbox: only managers see the inbox
  if (args.role === "inbox") {
    if (!args.managers.includes(args.actor)) {
      return { items: [], next_cursor: null };
    }
  }

  const conditions: string[] = [];
  const params: unknown[] = [];

  // Role filter
  if (args.role === "outbox") {
    params.push(args.actor);
    conditions.push(`requester = $${params.length}`);
  } else if (args.role === "inbox") {
    // Multi-manager: any manager sees every pending request. The `reviewer`
    // column is informational (stamped with managers[0] at submit time).
    conditions.push(`status = 'pending'`);
  } else {
    // all
    params.push(args.actor);
    conditions.push(`(requester = $${params.length} OR reviewer = $${params.length})`);
  }

  if (args.status !== undefined) {
    params.push(args.status);
    conditions.push(`status = $${params.length}`);
  }

  // Cursor format is "ISO|share_id" so two rows sharing created_at to
  // microsecond precision (same-transaction inserts, deterministic seeders)
  // can still page deterministically by the share_id tiebreaker. Plain ISO
  // cursors from older clients fall back to created_at-only filtering.
  if (args.cursor !== undefined) {
    const [cursorTs, cursorId] = args.cursor.includes("|")
      ? args.cursor.split("|", 2) as [string, string]
      : [args.cursor, null];
    if (cursorId === null) {
      params.push(cursorTs);
      conditions.push(`created_at < $${params.length}::timestamptz`);
    } else {
      params.push(cursorTs);
      params.push(cursorId);
      conditions.push(
        `(created_at, share_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit + 1);
  const sql = `SELECT * FROM share_requests ${where}
                ORDER BY created_at DESC, share_id DESC
                LIMIT $${params.length}`;

  const result = await args.pool.query<ShareRow>(sql, params);
  const rows = result.rows;

  let next_cursor: string | null = null;
  if (rows.length > limit) {
    rows.splice(limit);
    const tail = rows[rows.length - 1]!;
    next_cursor = `${tail.created_at.toISOString()}|${tail.share_id}`;
  }

  return { items: rows.map(mapRow), next_cursor };
}

// ─── 3. getShareRequest ─────────────────────────────────────────────────────

export async function getShareRequest(args: {
  pool:     Pool;
  actor:    string;
  shareId:  string;
  managers: string[];
}): Promise<ShareRequest | { error: "not_found" | "forbidden" }> {
  const r = await args.pool.query<ShareRow>(
    `SELECT * FROM share_requests WHERE share_id = $1`,
    [args.shareId],
  );
  if ((r.rowCount ?? 0) === 0) {
    return { error: "not_found" };
  }
  const row = r.rows[0]!;
  if (row.requester !== args.actor && !args.managers.includes(args.actor)) {
    return { error: "forbidden" };
  }
  return mapRow(row);
}

// ─── 4. decideShareRequest ──────────────────────────────────────────────────

export interface DecideArgs {
  pool:               Pool;
  actor:              string;
  managers:           string[];
  shareId:            string;
  decision:           "approve" | "reject";
  comment?:           string;
  // Phase 2: required for the skill approve branch.
  workspacesRoot:     string;
  shareSnapshotsDir:  string;
}

export type DecideResult =
  | { ok: true; status: ShareStatus; promotion_result?: Record<string, unknown> }
  | { ok: false;
      reason:
        | "not_found"
        | "forbidden"
        | "already_decided"
        | "promotion_failed"
        | "collision"
        | "target_not_found";        // NEW
      detail?: string };

export async function decideShareRequest(args: DecideArgs): Promise<DecideResult> {
  if (!args.managers.includes(args.actor)) {
    return { ok: false, reason: "forbidden" };
  }

  const client = await args.pool.connect();
  try {
    await client.query("BEGIN");

    const r = await client.query<ShareRow>(
      `SELECT * FROM share_requests WHERE share_id = $1 FOR UPDATE`,
      [args.shareId],
    );
    if ((r.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    const row = r.rows[0]!;

    if (row.status !== "pending") {
      await client.query("ROLLBACK");
      return { ok: false, reason: "already_decided", detail: row.status };
    }

    if (args.decision === "reject") {
      await client.query(
        `UPDATE share_requests
            SET status = 'rejected', decided_at = now(), review_comment = $1
          WHERE share_id = $2`,
        [args.comment ?? null, args.shareId],
      );
      await client.query("COMMIT");
      return { ok: true, status: "rejected" };
    }

    // approve path
    if (row.artifact_kind === "skill") {
      const result = await approveSkillShareRequest({
        row,
        workspacesRoot:    args.workspacesRoot,
        shareSnapshotsDir: args.shareSnapshotsDir,
      });
      if (!result.ok) {
        await client.query("ROLLBACK");
        return result;
      }
      // FS op (extractSkillTarball) ran inside the row-lock window — acceptable
      // for small skills. The lock is released by COMMIT below.
      await client.query(
        `UPDATE share_requests
            SET status = 'approved', decided_at = now(),
                review_comment = $1, promotion_result = $2
          WHERE share_id = $3`,
        [args.comment ?? null, result.promotion_result, args.shareId],
      );
      await client.query("COMMIT");
      return { ok: true, status: "approved", promotion_result: result.promotion_result };
    }
    if (row.artifact_kind === "skill_update") {
      const result = await approveSkillUpdateShareRequest({
        row,
        workspacesRoot:    args.workspacesRoot,
        shareSnapshotsDir: args.shareSnapshotsDir,
      });
      if (!result.ok) {
        await client.query("ROLLBACK");
        return result;
      }
      await client.query(
        `UPDATE share_requests
            SET status = 'approved', decided_at = now(),
                review_comment = $1, promotion_result = $2
          WHERE share_id = $3`,
        [args.comment ?? null, result.promotion_result, args.shareId],
      );
      await client.query("COMMIT");
      return { ok: true, status: "approved", promotion_result: result.promotion_result };
    }
    if (row.artifact_kind === "folder") {
      const result = await approveFolderShareRequest({
        row,
        workspacesRoot:    args.workspacesRoot,
        shareSnapshotsDir: args.shareSnapshotsDir,
      });
      if (!result.ok) {
        await client.query("ROLLBACK");
        return result;
      }
      await client.query(
        `UPDATE share_requests
            SET status = 'approved', decided_at = now(),
                review_comment = $1, promotion_result = $2
          WHERE share_id = $3`,
        [args.comment ?? null, result.promotion_result, args.shareId],
      );
      await client.query("COMMIT");
      return { ok: true, status: "approved", promotion_result: result.promotion_result };
    }
    if (row.artifact_kind !== "memory") {
      await client.query("ROLLBACK");
      return {
        ok:     false,
        reason: "promotion_failed",
        detail: `kind '${row.artifact_kind}' not implemented`,
      };
    }

    const result = await approveMemoryShareRequest(client, row, args.shareId);
    if (!result.ok) {
      await client.query("ROLLBACK");
      return result;
    }
    await client.query(
      `UPDATE share_requests
          SET status = 'approved', decided_at = now(),
              review_comment = $1, promotion_result = $2
        WHERE share_id = $3`,
      [args.comment ?? null, result.promotion_result, args.shareId],
    );
    await client.query("COMMIT");
    return { ok: true, status: "approved", promotion_result: result.promotion_result };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ─── 5. withdrawShareRequest ────────────────────────────────────────────────

export async function withdrawShareRequest(args: {
  pool:    Pool;
  actor:   string;
  shareId: string;
}): Promise<{ ok: boolean; reason?: "not_found" | "forbidden" | "already_decided" }> {
  const client = await args.pool.connect();
  try {
    await client.query("BEGIN");

    const r = await client.query<ShareRow>(
      `SELECT * FROM share_requests WHERE share_id = $1 FOR UPDATE`,
      [args.shareId],
    );
    if ((r.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    const row = r.rows[0]!;

    if (row.requester !== args.actor) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "forbidden" };
    }
    if (row.status !== "pending") {
      await client.query("ROLLBACK");
      return { ok: false, reason: "already_decided" };
    }

    await client.query(
      `UPDATE share_requests SET status = 'withdrawn', decided_at = now() WHERE share_id = $1`,
      [args.shareId],
    );
    await client.query("COMMIT");
    return { ok: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ─── 6. getShareCapabilities ────────────────────────────────────────────────

export async function getShareCapabilities(args: {
  pool:     Pool;
  actor:    string;
  managers: string[];
}): Promise<{
  is_manager:           boolean;
  manager_usernames:    string[];
  pending_inbox_count:  number;
  actor_username:       string;
}> {
  const is_manager = args.managers.includes(args.actor);

  let pending_inbox_count = 0;
  if (is_manager) {
    const r = await args.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM share_requests
        WHERE status = 'pending'`,
    );
    pending_inbox_count = parseInt(r.rows[0]!.count, 10);
  }

  return {
    is_manager,
    manager_usernames:   args.managers,
    pending_inbox_count,
    actor_username:      args.actor,
  };
}

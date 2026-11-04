// Evidence and lineage storage (spec §4.3, §4.4). Evidence rows are
// immutable pointers; edges are typed relations between memory rows.
import type { Pool, PoolClient } from "pg";
import { ACCESS_ORDER, type AccessClass } from "./access-classes.js";
import { EDGE_RELS } from "./memory-contract.js";
import { appendAudit } from "./memory-audit.js";
import { visibleSql, type Viewer } from "./memory-access.js";
import { ORG_USER } from "./memory-dirs.js";
import { withTx } from "./tx.js";

export { ACCESS_ORDER, type AccessClass };

export function strictest(classes: AccessClass[], floor: AccessClass = "internal"): AccessClass {
  return classes.reduce<AccessClass>(
    (a, c) => (ACCESS_ORDER.indexOf(c) > ACCESS_ORDER.indexOf(a) ? c : a), floor);
}

export { EDGE_RELS };
export type EdgeRel = (typeof EDGE_RELS)[number];

export type Modality =
  | "transcript" | "tool_output" | "file" | "image" | "video" | "notebook" | "instrument_run" | "table";

const EXT_MODALITY: Array<[RegExp, Modality]> = [
  [/\.ipynb$/i, "notebook"],
  [/\.(png|jpe?g|tiff?|gif|svg|bmp|czi|nd2)$/i, "image"],
  [/\.(mp4|mov|avi|mkv|webm)$/i, "video"],
  [/\.(csv|tsv|xlsx?|parquet|h5ad|loom|feather)$/i, "table"],
];

export function modalityOf(uri: string): Modality {
  if (uri.startsWith("transcript://")) return "transcript";
  if (uri.startsWith("chpc://")) return "instrument_run";
  for (const [re, m] of EXT_MODALITY) if (re.test(uri)) return m;
  return "file";
}

export interface EvidenceInput {
  uri:           string;
  sha256?:       Buffer | null;
  modality?:     Modality;
  locator?:      Record<string, unknown>;
  observed_at?:  string | null;
  actor:         string;
  access_class?: AccessClass;
}

// Insert or find an evidence row. A second sighting of the same (uri, sha256)
// keeps the first row; its access class can only become stricter.
export async function upsertEvidence(
  client: PoolClient | Pool,
  e: EvidenceInput,
): Promise<{ evidence_id: string; access_class: AccessClass }> {
  const r = await client.query<{ evidence_id: string; access_class: AccessClass }>(
    `INSERT INTO evidence_assets (uri, sha256, modality, locator, observed_at, actor, access_class)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
     ON CONFLICT (uri, sha256) DO UPDATE SET access_class =
       CASE WHEN array_position($8::text[], EXCLUDED.access_class)
               > array_position($8::text[], evidence_assets.access_class)
            THEN EXCLUDED.access_class ELSE evidence_assets.access_class END
     RETURNING evidence_id, access_class`,
    [
      e.uri, e.sha256 ?? null, e.modality ?? modalityOf(e.uri), JSON.stringify(e.locator ?? {}),
      e.observed_at ?? null, e.actor, e.access_class ?? "internal", ACCESS_ORDER,
    ],
  );
  return r.rows[0]!;
}

export async function linkEvidence(
  client: PoolClient,
  memory_id: string,
  evidence_id: string,
  role: "source" | "input" | "output" | "qc" = "source",
): Promise<void> {
  await client.query(
    `INSERT INTO memory_evidence (memory_id, evidence_id, role) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [memory_id, evidence_id, role],
  );
}

export interface EdgeInput {
  src_id: string;
  dst_id: string;
  rel:    EdgeRel;
  actor:  string;
  status?: "proposed" | "accepted" | "rejected";
  note?:  string | null;
}

// Write an edge; writing the same (src, dst, rel) again updates its status
// and note. Status effects on dst (superseded/retracted) are applied by
// applyEdgeEffect, in the same transaction.
export async function writeEdge(client: PoolClient, e: EdgeInput): Promise<void> {
  await client.query(
    `INSERT INTO memory_edges (src_id, dst_id, rel, status, actor, note)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (src_id, dst_id, rel) DO UPDATE
       SET status = EXCLUDED.status, actor = EXCLUDED.actor, note = EXCLUDED.note`,
    [e.src_id, e.dst_id, e.rel, e.status ?? "accepted", e.actor, e.note ?? null],
  );
  const status = e.status ?? "accepted";
  if (status === "accepted") await applyEdgeEffect(client, e);
  else if (status === "rejected" && (e.rel === "SUPERSEDES" || e.rel === "RETRACTS")) {
    // Undo a wrong supersession or retraction unless another accepted edge
    // still holds dst down.
    const held = await client.query(
      `SELECT 1 FROM memory_edges WHERE dst_id = $1 AND status = 'accepted'
          AND rel IN ('SUPERSEDES', 'RETRACTS') LIMIT 1`,
      [e.dst_id],
    );
    if (held.rowCount === 0) await setStatus(client, e.dst_id, "active", e.actor);
  }
}

const VALIDATION_ORDER = ["anecdotal", "repeated", "replicated", "reviewed"] as const;

async function applyEdgeEffect(client: PoolClient, e: EdgeInput): Promise<void> {
  if (e.rel === "SUPERSEDES") await setStatus(client, e.dst_id, "superseded", e.actor);
  else if (e.rel === "RETRACTS") await setStatus(client, e.dst_id, "retracted", e.actor);
  else if (e.rel === "VALIDATED_BY" || e.rel === "FAILED_TO_REPLICATE") {
    // Read as English: "claim VALIDATED_BY run" raises the claim (src);
    // "run FAILED_TO_REPLICATE claim" lowers the claim (dst).
    const [target, step] = e.rel === "VALIDATED_BY" ? [e.src_id, 1] : [e.dst_id, -1];
    await client.query(
      `UPDATE memories SET validation_level = ($2::text[])[
         GREATEST(1, LEAST(4, COALESCE(array_position($2::text[], validation_level), 1) + $3))]
       WHERE memory_id = $1`,
      [target, VALIDATION_ORDER, step],
    );
  }
}

// Status is the only mutable column of a claim; every change is audited.
export async function setStatus(
  client: PoolClient,
  memory_id: string,
  status: "active" | "proposed" | "superseded" | "retracted" | "shadowed",
  actor: string,
): Promise<void> {
  const r = await client.query<{ before: string }>(
    `UPDATE memories m SET status = $2
       FROM (SELECT status AS before FROM memories WHERE memory_id = $1 FOR UPDATE) old
      WHERE m.memory_id = $1 AND old.before <> $2
     RETURNING old.before`,
    [memory_id, status],
  );
  if (r.rowCount === 0) return;
  await appendAudit(client, {
    memory_id, actor, action: "status",
    before: { status: r.rows[0]!.before }, after: { status },
  });
}

export interface LineageEdge {
  rel:      EdgeRel;
  dir:      "out" | "in";
  other_id: string;
  status:   string;
}

// 1-hop edges around the given memories, both directions, rejected excluded.
export async function lineageOf(
  pool: Pool,
  memory_ids: string[],
  viewer: Viewer,
): Promise<Map<string, LineageEdge[]>> {
  const out = new Map<string, LineageEdge[]>();
  if (memory_ids.length === 0) return out;
  // Only edges whose other end the viewer can see and that is not deleted.
  const r = await pool.query<{ id: string; rel: EdgeRel; dir: "out" | "in"; other_id: string; status: string }>(
    `SELECT e.id, e.rel, e.dir, e.other_id, e.status
       FROM (SELECT src_id AS id, rel, 'out' AS dir, dst_id AS other_id, status
               FROM memory_edges WHERE src_id = ANY($1::uuid[]) AND status <> 'rejected'
             UNION ALL
             SELECT dst_id AS id, rel, 'in' AS dir, src_id AS other_id, status
               FROM memory_edges WHERE dst_id = ANY($1::uuid[]) AND status <> 'rejected') e
       JOIN memories o ON o.memory_id = e.other_id
      WHERE o.deleted_at IS NULL AND ${visibleSql("o", "$2", "$3")}`,
    [memory_ids, viewer.username, viewer.clearance],
  );
  for (const row of r.rows) {
    const list = out.get(row.id) ?? [];
    list.push({ rel: row.rel, dir: row.dir, other_id: row.other_id, status: row.status });
    out.set(row.id, list);
  }
  return out;
}

// Relations that change dst's status: only dst's owner may write them.
const DST_OWNER_RELS: readonly EdgeRel[] = ["SUPERSEDES", "RETRACTS", "FAILED_TO_REPLICATE"];

// POST /memory/link. The actor must own src; dst must be visible to the
// actor (own or org), and owned by the actor when the edge changes dst.
export async function linkMemories(args: {
  pool:   Pool;
  actor:  string;
  src_id: string;
  dst_id: string;
  rel:    EdgeRel;
  status?: "accepted" | "rejected";
  note?:  string;
}): Promise<{ ok: boolean; reason?: "not_found" | "forbidden" | "self" }> {
  if (args.src_id === args.dst_id) return { ok: false, reason: "self" };
  return await withTx(args.pool, async (client) => {
    const r = await client.query<{ memory_id: string; username: string }>(
      `SELECT memory_id, username FROM memories
        WHERE memory_id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [[args.src_id, args.dst_id]],
    );
    const owner = new Map(r.rows.map((x) => [x.memory_id, x.username]));
    const src = owner.get(args.src_id), dst = owner.get(args.dst_id);
    if (src === undefined || dst === undefined) {
      return { ok: false, reason: "not_found" };
    }
    const dstVisible = dst === args.actor || dst === ORG_USER;
    const dstOk = DST_OWNER_RELS.includes(args.rel) ? dst === args.actor : dstVisible;
    if (src !== args.actor || !dstOk) {
      return { ok: false, reason: "forbidden" };
    }
    await writeEdge(client, {
      src_id: args.src_id, dst_id: args.dst_id, rel: args.rel, actor: args.actor,
      status: args.status ?? "accepted", note: args.note ?? null,
    });
    return { ok: true };
  }, (r) => r.ok);
}

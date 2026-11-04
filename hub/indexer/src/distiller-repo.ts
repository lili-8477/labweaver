import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { DistillationResult, Observation } from "./distiller-prompts.js";
import { contentHash } from "./content-hash.js";
import { appendAudit } from "./memory-audit.js";
import { InvalidDirError, defaultDir, isDirFkViolation, scopeOf } from "./memory-dirs.js";
import { REINFORCE_SQL, embedForMerge, findMergeTarget, vectorLiteral, type WritePolicy } from "./memory-merge.js";

export interface SettledSession {
  session_id:          string;
  username:            string;
  encoded_project_dir: string;
  last_active:         Date;
}

export async function findSettledSessions(
  pool: Pool,
  args: { username: string; cursor: Date; settleSeconds: number; limit: number },
): Promise<SettledSession[]> {
  const r = await pool.query<SettledSession>(
    `SELECT session_id, username, encoded_project_dir, last_active
       FROM sessions
      WHERE username = $1
        AND last_active > $2
        AND last_active < (now() - ($3::int || ' seconds')::interval)
      ORDER BY last_active ASC
      LIMIT $4`,
    [args.username, args.cursor.toISOString(), args.settleSeconds, args.limit],
  );
  return r.rows;
}

export interface SessionMeta {
  username:           string;
  project_dir:        string | null;
  // Nullable because /memory/distill (agent-driven) may not know the session
  // UUID, and user-authored memories elsewhere already pass NULL.
  source_session_id:  string | null;
}

export interface WriteDistillationArgs {
  sessionMeta:    SessionMeta;
  result:         DistillationResult;
  promptVersion:  number;
  policy?:        WritePolicy;   // merge check + directory cap; absent: no merge check
}

export interface InsertMemoryRowArgs {
  username:           string;
  project_dir:        string | null;
  source:             "distilled" | "user";
  type:               string;
  source_session_id:  string | null;
  name:               string;
  description:        string;
  body:               string;
  facets:             Record<string, string[] | undefined>;
  content_hash:       Buffer;
  dir_key?:           string;           // defaults by (scope, type), see memory-dirs.ts
  embedding?:         number[] | null;  // stored on the chunk; else the embedder queue fills it
}

export async function insertMemoryRow(
  client: PoolClient,
  args:   InsertMemoryRowArgs,
): Promise<string | null> {
  const memId = randomUUID();
  const dirKey = args.dir_key ?? defaultDir(scopeOf(args.username, args.project_dir), args.type);
  let ins;
  try {
    ins = await client.query<{ memory_id: string }>(
      `INSERT INTO memories (
         memory_id, username, project_dir, type, source,
         name, description, body, source_session_id, content_hash, dir_key
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (username, project_dir, type, content_hash) DO NOTHING
       RETURNING memory_id`,
      [
        memId, args.username, args.project_dir, args.type, args.source,
        args.name, args.description, args.body, args.source_session_id, args.content_hash, dirKey,
      ],
    );
  } catch (e) {
    if (isDirFkViolation(e)) throw new InvalidDirError(dirKey, scopeOf(args.username, args.project_dir));
    throw e;
  }
  if (ins.rowCount === 0) return null; // dedup; nothing else to write

  const writtenId = ins.rows[0]!.memory_id;
  await insertChunk(client, writtenId, args.body, args.embedding ?? null);
  await insertFacets(client, writtenId, args.facets);
  return writtenId;
}

// The single chunk of a memory. Without an embedding the chunk is queued for
// the embedder worker.
export async function insertChunk(
  client:    PoolClient,
  memoryId:  string,
  body:      string,
  embedding: number[] | null,
): Promise<void> {
  const chunk = await client.query<{ chunk_id: string }>(
    `INSERT INTO memory_chunks (memory_id, chunk_idx, content, embedding)
     VALUES ($1, 0, $2, $3::vector) RETURNING chunk_id`,
    [memoryId, body, embedding ? vectorLiteral(embedding) : null],
  );
  if (embedding) return;
  await client.query(
    `INSERT INTO embedder_queue (chunk_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [chunk.rows[0]!.chunk_id],
  );
}

async function insertFacets(
  client:   PoolClient,
  memoryId: string,
  facets:   Record<string, string[] | undefined>,
): Promise<void> {
  for (const [k, vs] of Object.entries(facets)) {
    if (!vs) continue;
    for (const v of vs) {
      await client.query(
        `INSERT INTO memory_facets (memory_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [memoryId, k, v],
      );
    }
  }
}

export interface StoreResult {
  memory_id: string | null;   // null: an existing row already holds this content
  dir_key:   string;
  merged:    boolean;         // true: folded into the existing row memory_id
}

// Merge-on-write. Exact duplicates (same owner, type and content_hash) are
// dropped as before. Otherwise, given the body's embedding, the closest live
// entry in the same owner's directory at or above `mergeSimilarity` absorbs
// the write: its name/description/body/type are replaced by the newer
// content (the previous version is kept in the 'merge' audit row) and it
// keeps its id, counters and created_at, and is reinforced. A distilled write never overwrites
// a user-authored row; it is dropped instead. A user write into a distilled
// row makes it user-authored. A genuinely new row is inserted.
export async function storeMemory(
  client: PoolClient,
  row:    InsertMemoryRowArgs,
  // The body's embedding (embedForMerge); null skips the merge check.
  embedding: number[] | null,
  policy?:   WritePolicy,
): Promise<StoreResult> {
  const dir_key = row.dir_key ?? defaultDir(scopeOf(row.username, row.project_dir), row.type);
  if (embedding && policy) {
    const dup = await client.query(
      `SELECT 1 FROM memories
        WHERE username = $1 AND project_dir IS NOT DISTINCT FROM $2
          AND type = $3 AND content_hash = $4`,
      [row.username, row.project_dir, row.type, row.content_hash],
    );
    if ((dup.rowCount ?? 0) > 0) return { memory_id: null, dir_key, merged: false };

    const target = await findMergeTarget(client, {
      username: row.username, project_dir: row.project_dir, dir_key,
      embedding, similarity: policy.mergeSimilarity,
    });
    if (target) {
      if (row.source === "distilled" && target.source === "user") {
        return { memory_id: null, dir_key, merged: false };
      }
      await client.query(
        `UPDATE memories
            SET name = $1, description = $2, body = $3, content_hash = $4,
                type = $5, source = $6, updated_at = now(), ${REINFORCE_SQL}
          WHERE memory_id = $7`,
        [row.name, row.description, row.body, row.content_hash, row.type, row.source, target.memory_id],
      );
      await client.query(`DELETE FROM memory_chunks WHERE memory_id = $1`, [target.memory_id]);
      await insertChunk(client, target.memory_id, row.body, embedding);
      await insertFacets(client, target.memory_id, row.facets);
      await appendAudit(client, {
        memory_id: target.memory_id,
        actor:     row.username,
        action:    "merge",
        before:    { type: target.type, source: target.source, name: target.name, description: target.description, body: target.body },
        after:     { type: row.type, source: row.source, name: row.name, description: row.description, body: row.body, sim: target.sim },
      });
      return { memory_id: target.memory_id, dir_key, merged: true };
    }
  }

  const memory_id = await insertMemoryRow(client, { ...row, dir_key, embedding });
  return { memory_id, dir_key, merged: false };
}

// Agent-driven distill: one session_summary row plus the observations, each
// through storeMemory (merge-on-write + directory cap). Returns how many rows
// were inserted and how many were merged into existing ones.
export async function writeDistillation(
  pool: Pool,
  args: WriteDistillationArgs,
): Promise<{ written: number; merged: number }> {
  const rows: Array<{ type: string; payload: Pick<Observation, "name" | "description" | "body" | "facets"> }> = [
    { type: "session_summary", payload: { ...args.result.summary, facets: {} } },
    ...args.result.observations.map((obs) => ({
      type:    obs.type === "user-preference" ? "feedback" : "observation",
      payload: obs,
    })),
  ];
  const embeddings = await embedForMerge(args.policy, rows.map((r) => r.payload.body));
  const counts = { written: 0, merged: 0 };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [i, r] of rows.entries()) {
      const res = await storeMemory(client, {
        username:          args.sessionMeta.username,
        project_dir:       args.sessionMeta.project_dir,
        source:            "distilled",
        type:              r.type,
        source_session_id: args.sessionMeta.source_session_id,
        name:              r.payload.name,
        description:       r.payload.description,
        body:              r.payload.body,
        facets:            r.payload.facets,
        content_hash:      contentHash({ body: `${r.payload.name}\n${r.payload.body}`, promptVersion: args.promptVersion }),
      }, embeddings?.[i] ?? null, args.policy);
      if (res.merged) counts.merged++;
      else if (res.memory_id !== null) counts.written++;
    }
    await client.query("COMMIT");
    return counts;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

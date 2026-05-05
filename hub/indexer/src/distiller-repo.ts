import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { DistillationResult, Observation } from "./distiller-prompts.js";
import { contentHash } from "./content-hash.js";

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
  source_session_id:  string;
}

export interface WriteDistillationArgs {
  sessionMeta:    SessionMeta;
  result:         DistillationResult;
  promptVersion:  number;
}

export async function writeDistillation(
  pool: Pool,
  args: WriteDistillationArgs,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await insertOne(client, args.sessionMeta, "session_summary", {
      name:        args.result.summary.name,
      description: args.result.summary.description,
      body:        args.result.summary.body,
      facets:      {},
    }, args.promptVersion);

    for (const obs of args.result.observations) {
      const memType = obs.type === "user-preference" ? "feedback" : "observation";
      await insertOne(client, args.sessionMeta, memType, obs, args.promptVersion);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function insertOne(
  client:        PoolClient,
  meta:          SessionMeta,
  memType:       string,
  payload:       Pick<Observation, "name" | "description" | "body" | "facets">,
  promptVersion: number,
): Promise<void> {
  const hash = contentHash({ body: `${payload.name}\n${payload.body}`, promptVersion });
  const memId = randomUUID();
  const ins = await client.query<{ memory_id: string }>(
    `INSERT INTO memories (
       memory_id, username, project_dir, type, source,
       name, description, body, source_session_id, content_hash
     ) VALUES ($1, $2, $3, $4, 'distilled', $5, $6, $7, $8, $9)
     ON CONFLICT (username, project_dir, type, content_hash) DO NOTHING
     RETURNING memory_id`,
    [
      memId, meta.username, meta.project_dir, memType,
      payload.name, payload.description, payload.body, meta.source_session_id, hash,
    ],
  );
  if (ins.rowCount === 0) return; // dedup; nothing else to write

  const writtenId = ins.rows[0]!.memory_id;
  const chunk = await client.query<{ chunk_id: string }>(
    `INSERT INTO memory_chunks (memory_id, chunk_idx, content)
     VALUES ($1, 0, $2) RETURNING chunk_id`,
    [writtenId, payload.body],
  );
  await client.query(
    `INSERT INTO embedder_queue (chunk_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [chunk.rows[0]!.chunk_id],
  );
  for (const [k, vs] of Object.entries(payload.facets)) {
    if (!vs) continue;
    for (const v of vs) {
      await client.query(
        `INSERT INTO memory_facets (memory_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [writtenId, k, v],
      );
    }
  }
}

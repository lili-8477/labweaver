import type { Pool } from "pg";
import { logger } from "./config.js";
import { embedTexts, EmbedderError } from "./embedder-client.js";

export interface RunEmbedderOpts {
  embedderUrl: string;
  batchSize:   number;
}

export interface EmbedderSummary {
  embedded: number;
  failed:   number;
}

export async function runEmbedderOnce(pool: Pool, opts: RunEmbedderOpts): Promise<EmbedderSummary> {
  const summary: EmbedderSummary = { embedded: 0, failed: 0 };
  const batch = await pool.query<{ chunk_id: string; content: string }>(
    `SELECT mc.chunk_id, mc.content
       FROM memory_chunks mc JOIN embedder_queue eq USING (chunk_id)
      ORDER BY eq.enqueued_at ASC
      LIMIT $1`,
    [opts.batchSize],
  );
  if (batch.rowCount === 0) return summary;

  const ids   = batch.rows.map((r) => r.chunk_id);
  const texts = batch.rows.map((r) => r.content);

  let vectors: number[][];
  try {
    vectors = await embedTexts({ baseUrl: opts.embedderUrl, texts });
  } catch (e) {
    summary.failed = ids.length;
    const msg = e instanceof EmbedderError ? e.message : String(e);
    await pool.query(
      `UPDATE embedder_queue SET attempts = attempts + 1, last_error = $1
        WHERE chunk_id = ANY($2::bigint[])`,
      [msg.slice(0, 500), ids],
    );
    logger.warn({ count: ids.length, err: msg }, "embedder batch failed; will retry");
    return summary;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < ids.length; i++) {
      const literal = "[" + vectors[i]!.join(",") + "]";
      await client.query(
        `UPDATE memory_chunks SET embedding = $1::vector WHERE chunk_id = $2`,
        [literal, ids[i]],
      );
    }
    await client.query(
      `DELETE FROM embedder_queue WHERE chunk_id = ANY($1::bigint[])`,
      [ids],
    );
    await client.query("COMMIT");
    summary.embedded = ids.length;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return summary;
}

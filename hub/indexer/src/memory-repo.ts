import type { Pool } from "pg";
import { logger } from "./config.js";

export interface SearchMemoriesArgs {
  pool:           Pool;
  embedderClient: { embedTexts: (texts: string[]) => Promise<number[][]> };
  username:       string;
  project_dir:    string | null;
  query:          string;
  limit?:         number;
  types?:         string[];
  since?:         Date;
}

export interface SearchHit {
  memory_id:   string;
  name:        string;
  description: string;
  snippet:     string;
  score:       number;
  scope_tier:  "org" | "user" | "project";
}

const EMBED_DIM = 384;

const SEARCH_SQL = `
WITH q AS (SELECT $1::vector AS qv, plainto_tsquery('english', $2) AS qt),
candidates AS (
  SELECT mc.memory_id,
         mc.content,
         (1 - (mc.embedding <=> q.qv)) AS vec_sim,
         ts_rank(mc.tsv, q.qt) AS fts_score
  FROM memory_chunks mc, q
  WHERE mc.embedding IS NOT NULL OR mc.tsv @@ q.qt
  ORDER BY mc.embedding <=> q.qv
  LIMIT 200
)
SELECT m.memory_id, m.name, m.description,
       LEFT(c.content, 200) AS snippet,
       (c.vec_sim * 0.7 + LEAST(c.fts_score, 1.0) * 0.3) AS base_score,
       (c.vec_sim * 0.7 + LEAST(c.fts_score, 1.0) * 0.3)
         * CASE
             WHEN m.username = '__org__'                              THEN 1.00
             WHEN m.project_dir IS NULL                               THEN 1.10
             ELSE 1.20
           END
         * (1.0 + LN(1 + m.hit_count) * 0.05)
         * EXP(-EXTRACT(EPOCH FROM (now() - m.created_at)) / (86400 * 90))  AS score,
       CASE
         WHEN m.username = '__org__'                              THEN 'org'
         WHEN m.project_dir IS NULL                               THEN 'user'
         ELSE 'project'
       END AS scope_tier
FROM memories m JOIN candidates c USING (memory_id)
WHERE m.deleted_at IS NULL
  AND (m.username = $3 OR m.username = '__org__')
  AND (m.project_dir IS NULL OR m.project_dir = $4)
  AND ($5::text[] IS NULL OR m.type = ANY($5))
  AND ($6::timestamptz IS NULL OR m.created_at >= $6)
ORDER BY score DESC
LIMIT $7
`;

export async function searchMemories(args: SearchMemoriesArgs): Promise<SearchHit[]> {
  const limit = args.limit ?? 10;

  let qVec: number[];
  try {
    const out = await args.embedderClient.embedTexts([args.query]);
    if (!Array.isArray(out) || !Array.isArray(out[0])) {
      throw new Error("embedder returned malformed vectors");
    }
    qVec = out[0];
  } catch (e) {
    logger.warn(
      { err: (e as Error).message },
      "embedder unavailable; falling back to FTS-only search",
    );
    qVec = new Array(EMBED_DIM).fill(0);
  }

  const qLiteral = "[" + qVec.join(",") + "]";
  const types    = args.types && args.types.length > 0 ? args.types : null;
  const since    = args.since ? args.since.toISOString() : null;

  const res = await args.pool.query<{
    memory_id:   string;
    name:        string;
    description: string;
    snippet:     string;
    score:       string;
    scope_tier:  "org" | "user" | "project";
  }>(SEARCH_SQL, [qLiteral, args.query, args.username, args.project_dir, types, since, limit]);

  const hits: SearchHit[] = res.rows.map((r) => ({
    memory_id:   r.memory_id,
    name:        r.name,
    description: r.description,
    snippet:     r.snippet,
    score:       parseFloat(r.score),
    scope_tier:  r.scope_tier,
  }));

  if (hits.length > 0) {
    await args.pool.query(
      `UPDATE memories
          SET hit_count   = hit_count + 1,
              last_hit_at = now()
        WHERE memory_id = ANY($1::uuid[])`,
      [hits.map((h) => h.memory_id)],
    );
  }

  return hits;
}

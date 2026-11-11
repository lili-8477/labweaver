// Hybrid memory search: lexical, facet-exact and vector signals, ranked by
// a query-independent prior (scope, task outcomes, recency).

import type { Pool } from "pg";
import { logger } from "./config.js";
import { normalizeFacets } from "./facets.js";
import type { AccessClass } from "./access-classes.js";
import { DEFAULT_CLEARANCE, visibleSql } from "./memory-access.js";
import type { Domain } from "./memory-domain.js";
import type { SearchHit } from "./memory-contract.js";
import { vectorLiteral, type EmbedderClient } from "./embedder-client.js";
import { withTx } from "./tx.js";

export interface SearchMemoriesArgs {
  pool:           Pool;
  embedderClient: EmbedderClient;
  username:       string;
  project_dir:    string | null;
  query:          string;
  limit?:         number;
  types?:         string[];
  since?:         Date;
  dirs?:          string[];
  // Scientific filters (spec §6.1). Clearance defaults to 'internal'.
  clearance?:     AccessClass;
  conditions?:    Record<string, string[]>;
  strict?:        boolean;
  domain?:        Domain;
}

// Query-independent prior shared by search, context and directory L1:
// scope tier × task outcomes × reinforcement. Outcomes come from POST
// /memory/feedback; a memory that helped tasks succeed ranks up, one that
// preceded failures ranks down. Time is deliberately not in it, so a memory
// never fades, and hit_count plays no part.
export const PRIOR_SCORE_SQL = `
  (CASE m.scope WHEN 'org' THEN 1.00 WHEN 'user' THEN 1.10 ELSE 1.20 END
   * (1.0 + (LN(1 + m.success_count) - LN(1 + m.failure_count)) * 0.05)
   * (1.0 + LN(1 + m.reinforce_count) * 0.05))`;

// Hybrid search. Params: $1 query vector (NULL when the embedder is down),
// $2 query text, $3 username, $4 project_dir, $5 types[], $6 since,
// $7 dirs[], $8 limit, $9 caller clearance, $10 condition filters (jsonb
// {key: [values]}), $11 strict conditions, $12 exact-ID tokens[], $13 domain.
//
// Hard filters (spec §6.1) run inside SEARCH_WHERE_SQL, i.e. before each arm's
// LIMIT 200: status, validity, access class, and conditions. A condition
// excludes rows that carry the key with other values; rows without the key
// stay (flagged unconditioned by the bundle) unless strict.
//
// Candidates come from three arms: nearest vectors, best full-text matches,
// and exact facet matches on ID-like query tokens (gene symbols, sample IDs,
// lots, versions), which embeddings and English stemming both mangle. The
// union is scored 0.55·vec + 0.25·fts + 0.20·exact, times the prior; an
// exact match ranks first. Without a vector the vector arm is dropped.
const SEARCH_WHERE_SQL = `
      m.deleted_at IS NULL
  AND m.status = 'active'
  AND (m.valid_to IS NULL OR m.valid_to > now())
  AND ${visibleSql("m", "$3", "$9", "$13")}
  AND (m.project_dir IS NULL OR m.project_dir = $4)
  AND ($5::text[] IS NULL OR m.type = ANY($5))
  AND ($6::timestamptz IS NULL OR m.created_at >= $6)
  AND ($7::text[] IS NULL OR m.dir_key = ANY($7))
  AND ($10::jsonb IS NULL OR NOT EXISTS (
        SELECT 1 FROM jsonb_each($10::jsonb) c(key, vals)
         WHERE CASE WHEN EXISTS (SELECT 1 FROM memory_facets f
                                  WHERE f.memory_id = m.memory_id AND f.key = c.key)
                    THEN NOT EXISTS (SELECT 1 FROM memory_facets f
                                      WHERE f.memory_id = m.memory_id AND f.key = c.key
                                        AND lower(f.value) IN (SELECT lower(v) FROM jsonb_array_elements_text(c.vals) v))
                    ELSE $11 END))`;

const CHUNK_SIGNALS_SQL = `
  mc.chunk_id, mc.memory_id,
  1 - (mc.embedding <=> q.qv) AS vec_sim,
  CASE WHEN mc.tsv @@ q.qt THEN ts_rank(mc.tsv, q.qt) ELSE 0 END AS fts_score`;

const EXACT_SQL = `EXISTS (SELECT 1 FROM memory_facets f
  WHERE f.memory_id = m.memory_id AND lower(f.value) = ANY($12::text[]))`;

function searchSql(withVector: boolean): string {
  const vecArm = `
vec AS (
  SELECT ${CHUNK_SIGNALS_SQL}
  FROM memory_chunks mc JOIN memories m USING (memory_id), q
  WHERE mc.embedding IS NOT NULL AND ${SEARCH_WHERE_SQL}
  ORDER BY mc.embedding <=> $1::vector
  LIMIT 200
),`;
  return `
WITH q AS (SELECT $1::vector AS qv, plainto_tsquery('english', $2) AS qt),
${withVector ? vecArm : ""}
fts AS (
  SELECT ${CHUNK_SIGNALS_SQL}
  FROM memory_chunks mc JOIN memories m USING (memory_id), q
  WHERE mc.tsv @@ q.qt AND ${SEARCH_WHERE_SQL}
  ORDER BY fts_score DESC
  LIMIT 200
),
ex AS (
  SELECT ${CHUNK_SIGNALS_SQL}
  FROM memory_chunks mc JOIN memories m USING (memory_id), q
  WHERE mc.chunk_idx = 0 AND cardinality($12::text[]) > 0 AND ${EXACT_SQL} AND ${SEARCH_WHERE_SQL}
  LIMIT 200
),
cand AS (
  ${withVector ? "SELECT * FROM vec UNION" : ""} SELECT * FROM fts UNION SELECT * FROM ex
),
best AS (
  SELECT DISTINCT ON (c.memory_id) c.memory_id, c.chunk_id,
         ${EXACT_SQL} AS exact,
         (COALESCE(c.vec_sim, 0) * 0.55 + LEAST(c.fts_score, 1.0) * 0.25
          + CASE WHEN ${EXACT_SQL} THEN 0.20 ELSE 0 END)
           * ${PRIOR_SCORE_SQL} AS score
  FROM cand c JOIN memories m USING (memory_id)
  ORDER BY c.memory_id, score DESC
)
SELECT m.memory_id, m.name, m.description, m.dir_key,
       m.type, m.source, m.created_at, m.updated_at,
       m.hit_count, m.last_hit_at, m.deleted_at,
       LEFT(mc.content, 200) AS snippet,
       b.score, b.exact,
       m.scope AS scope_tier
FROM best b
JOIN memories m USING (memory_id)
JOIN memory_chunks mc ON mc.chunk_id = b.chunk_id
ORDER BY b.exact DESC, b.score DESC, m.memory_id
LIMIT $8
`;
}

// ID-like query tokens for the exact arm: anything with a digit (sample
// IDs, lots, versions, TP53) or an all-caps symbol of 2+ letters (GAPDH).
// Lower-cased to match normalized facet values.
export function exactTokens(query: string): string[] {
  const toks = query.split(/[\s,;:()\[\]{}"'`]+/).map((t) => t.replace(/^[.\-]+|[.\-]+$/g, ""));
  return [...new Set(
    toks.filter((t) => t.length >= 2 && (/\d/.test(t) || /^[A-Z][A-Z0-9-]+$/.test(t))).map((t) => t.toLowerCase()),
  )];
}

export async function searchMemories(args: SearchMemoriesArgs): Promise<SearchHit[]> {
  const limit = args.limit ?? 10;

  let qVec: number[] | null;
  try {
    const out = await args.embedderClient.embedTexts([args.query], "query");
    if (!Array.isArray(out) || !Array.isArray(out[0])) {
      throw new Error("embedder returned malformed vectors");
    }
    qVec = out[0];
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "embedder unavailable; falling back to FTS-only search",
    );
    qVec = null;
  }

  const types = args.types && args.types.length > 0 ? args.types : null;
  const since = args.since ? args.since.toISOString() : null;

  type Row = {
    memory_id:   string;
    name:        string;
    description: string;
    dir_key:     string;
    snippet:     string;
    score:       string;
    scope_tier:  "org" | "user" | "project";
    type:        string;
    source:      "user" | "distilled";
    created_at:  Date;
    updated_at:  Date;
    hit_count:   number;
    last_hit_at: Date | null;
    deleted_at:  Date | null;
    exact:       boolean;
  };

  const dirs = args.dirs && args.dirs.length > 0 ? args.dirs : null;
  const conditions = args.conditions && Object.keys(args.conditions).length > 0
    ? JSON.stringify(normalizeFacets(args.conditions)) : null;
  const params = [
    qVec === null ? null : vectorLiteral(qVec),
    args.query, args.username, args.project_dir, types, since, dirs, limit,
    args.clearance ?? DEFAULT_CLEARANCE, conditions, args.strict ?? false, exactTokens(args.query),
    args.domain ?? null,
  ];

  // The vector arm filters by visibility after the HNSW scan; iterative scan
  // keeps the index walking until 200 visible chunks are found instead of
  // stopping at ef_search raw neighbours (pgvector >= 0.8). SET LOCAL needs
  // a transaction.
  const res = await withTx(args.pool, async (client) => {
    await client.query("SET LOCAL hnsw.iterative_scan = relaxed_order");
    return await client.query<Row>(searchSql(qVec !== null), params);
  });

  const hits: SearchHit[] = res.rows.map((r) => ({
    memory_id:   r.memory_id,
    name:        r.name,
    description: r.description,
    dir_key:     r.dir_key,
    snippet:     r.snippet,
    score:       parseFloat(r.score),
    scope_tier:  r.scope_tier,
    type:        r.type,
    source:      r.source,
    created_at:  r.created_at.toISOString(),
    updated_at:  r.updated_at.toISOString(),
    hit_count:   r.hit_count,
    last_hit_at: r.last_hit_at ? r.last_hit_at.toISOString() : null,
    deleted_at:  r.deleted_at  ? r.deleted_at.toISOString()  : null,
    exact:       r.exact,
  }));

  // Retrieval alone is not a signal (phase 3): hit_count moves only when an
  // agent opens the memory (recordUse).
  return hits;
}

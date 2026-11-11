// Merge-on-write support (phase 2). Before a new memory is inserted, its body
// is embedded and compared with live entries of the same owner in the same
// directory. Near matches are handed back to the agent, which either merges
// them (PUT /memory/:id with merge=true) or re-sends with force_new.
import type { PoolClient } from "pg";
import { logger } from "./config.js";
import type { SimilarMemory } from "./memory-contract.js";
import { vectorLiteral, type EmbedderClient } from "./embedder-client.js";

export interface MergeCheck {
  embedderClient: EmbedderClient;
  similarity:     number;   // cosine similarity at or above which a match is "similar"
}

export type { SimilarMemory } from "./memory-contract.js";

// Embed texts for the similarity check. Returns null when the embedder is
// unavailable: the caller then writes without a check rather than failing.
export async function embedForMerge(check: MergeCheck, texts: string[]): Promise<number[][] | null> {
  try {
    const out = await check.embedderClient.embedTexts(texts);
    if (!Array.isArray(out) || out.length !== texts.length) throw new Error("embedder returned malformed vectors");
    return out;
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "embedder unavailable; writing without merge check",
    );
    return null;
  }
}

export async function findSimilar(
  client: PoolClient,
  args: {
    username:    string;
    project_dir: string | null;
    dir_key:     string;
    embedding:   number[];
    similarity:  number;
    limit?:      number;
  },
): Promise<SimilarMemory[]> {
  const r = await client.query<SimilarMemory>(
    `SELECT m.memory_id, m.name, m.description, m.body,
            MAX(1 - (mc.embedding <=> $1::vector))::float8 AS sim
       FROM memories m JOIN memory_chunks mc USING (memory_id)
      WHERE m.username = $2
        AND m.project_dir IS NOT DISTINCT FROM $3
        AND m.dir_key = $4
        AND m.deleted_at IS NULL
        AND mc.embedding IS NOT NULL
        AND 1 - (mc.embedding <=> $1::vector) >= $5
      GROUP BY m.memory_id
      ORDER BY sim DESC
      LIMIT $6`,
    [
      vectorLiteral(args.embedding),
      args.username, args.project_dir, args.dir_key, args.similarity, args.limit ?? 3,
    ],
  );
  return r.rows;
}

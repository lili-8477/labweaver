// Merge-on-write support. Before a new memory is inserted, its body is
// embedded and compared with the owner's live entries in the same directory;
// the closest match at or above `mergeSimilarity` (cosine) absorbs the write
// instead of a new row being added (distiller-repo.ts storeMemory).
import type { PoolClient } from "pg";
import { logger } from "./config.js";

export interface EmbedderClient {
  embedTexts: (texts: string[]) => Promise<number[][]>;
}

// Knobs for the write path. Without an embedderClient no merge check runs.
export interface WritePolicy {
  embedderClient?: EmbedderClient;
  mergeSimilarity: number;
  dirCap:          number;
}

// Embed texts for the merge check. Returns null when there is no embedder or
// it is unavailable: the caller then writes without a check rather than failing.
export async function embedForMerge(
  policy: WritePolicy | undefined,
  texts: string[],
): Promise<number[][] | null> {
  if (!policy?.embedderClient || texts.length === 0) return null;
  try {
    const out = await policy.embedderClient.embedTexts(texts);
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

export interface MergeTarget {
  memory_id:   string;
  source:      "user" | "distilled";
  type:        string;
  name:        string;
  description: string;
  body:        string;
  sim:         number;
}

export function vectorLiteral(v: number[]): string {
  return "[" + v.join(",") + "]";
}

// The live entry in the owner's directory most similar to `embedding`, if any
// reaches `similarity`.
export async function findMergeTarget(
  client: PoolClient,
  args: {
    username:    string;
    project_dir: string | null;
    dir_key:     string;
    embedding:   number[];
    similarity:  number;
  },
): Promise<MergeTarget | null> {
  const r = await client.query<MergeTarget>(
    `SELECT m.memory_id, m.source, m.type, m.name, m.description, m.body,
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
      LIMIT 1`,
    [vectorLiteral(args.embedding), args.username, args.project_dir, args.dir_key, args.similarity],
  );
  return r.rows[0] ?? null;
}

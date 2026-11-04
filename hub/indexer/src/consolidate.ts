// Consolidation ("System 2", spec §7). A manager starts it; it never runs on
// write. Without a server-side LLM it cannot judge a contradiction, so it:
//   1. proposes SUPPORTS between near-identical active claims that share a
//      condition key (a replication) and have no edge yet;
//   2. reports the other unlinked same-condition pairs for labeling with
//      memory_link (SUPPORTS or CONTRADICTS);
//   3. reports experiences whose source claim was superseded or retracted;
//   4. reports near-identical understandings (any non-claim memory) in one
//      directory, for the agent to fold together with memory_merge. A merge
//      reinforces the survivor (migration 0018), so knowledge that keeps
//      recurring condenses into one stronger memory.
// Every edge it writes has status 'proposed'.
import type { Pool } from "pg";
import { writeEdge } from "./lineage-repo.js";
import { withTx } from "./tx.js";

export interface ConsolidationReport {
  proposed_supports: Array<{ src_id: string; dst_id: string; sim: number }>;
  unlabeled_pairs:   Array<{ a: string; b: string; sim: number | null }>;
  stale_experiences: Array<{ experience_id: string; source_id: string; source_status: string }>;
  similar_understandings: Array<{ a: string; b: string; sim: number }>;
}

export async function consolidate(args: {
  pool:       Pool;
  actor:      string;
  username?:  string;
  similarity: number;
}): Promise<ConsolidationReport> {
  const user = args.username ?? null;
  const pairs = await args.pool.query<{ a: string; b: string; sim: number | null }>(
    `SELECT a.memory_id AS a, b.memory_id AS b,
            (SELECT MAX(1 - (ca.embedding <=> cb.embedding))
               FROM memory_chunks ca, memory_chunks cb
              WHERE ca.memory_id = a.memory_id AND cb.memory_id = b.memory_id
                AND ca.embedding IS NOT NULL AND cb.embedding IS NOT NULL)::float8 AS sim
       FROM memories a JOIN memories b
         ON a.condition_key = b.condition_key AND a.memory_id < b.memory_id
        AND a.username = b.username AND a.project_dir IS NOT DISTINCT FROM b.project_dir
        AND a.claim_kind = b.claim_kind
      WHERE a.type = 'claim' AND b.type = 'claim'
        AND a.status = 'active' AND b.status = 'active'
        AND a.deleted_at IS NULL AND b.deleted_at IS NULL
        AND ($1::text IS NULL OR a.username = $1)
        AND NOT EXISTS (SELECT 1 FROM memory_edges e
                         WHERE (e.src_id = a.memory_id AND e.dst_id = b.memory_id)
                            OR (e.src_id = b.memory_id AND e.dst_id = a.memory_id))
      ORDER BY a.memory_id, b.memory_id
      LIMIT 500`,
    [user],
  );

  const report: ConsolidationReport = {
    proposed_supports: [], unlabeled_pairs: [], stale_experiences: [], similar_understandings: [],
  };
  await withTx(args.pool, async (client) => {
    for (const p of pairs.rows) {
      if (p.sim !== null && p.sim >= args.similarity) {
        // Newer row supports the older one; direction is only for reading.
        await writeEdge(client, { src_id: p.b, dst_id: p.a, rel: "SUPPORTS", actor: args.actor, status: "proposed" });
        report.proposed_supports.push({ src_id: p.b, dst_id: p.a, sim: p.sim });
      } else {
        report.unlabeled_pairs.push(p);
      }
    }
  });

  const stale = await args.pool.query<{ experience_id: string; source_id: string; source_status: string }>(
    `SELECT x.memory_id AS experience_id, c.memory_id AS source_id, c.status AS source_status
       FROM memories x
       JOIN memory_edges e ON e.src_id = x.memory_id AND e.rel = 'DERIVED_FROM' AND e.status <> 'rejected'
       JOIN memories c ON c.memory_id = e.dst_id
      WHERE x.type = 'experience' AND x.status = 'active' AND x.deleted_at IS NULL
        AND c.status IN ('superseded', 'retracted')
        AND ($1::text IS NULL OR x.username = $1)
      ORDER BY x.memory_id`,
    [user],
  );
  report.stale_experiences = stale.rows;

  const similar = await args.pool.query<{ a: string; b: string; sim: number }>(
    `SELECT a.memory_id AS a, b.memory_id AS b, (1 - (ca.embedding <=> cb.embedding))::float8 AS sim
       FROM memories a
       JOIN memories b ON a.memory_id < b.memory_id
        AND a.username = b.username AND a.project_dir IS NOT DISTINCT FROM b.project_dir
        AND a.dir_key = b.dir_key
       JOIN memory_chunks ca ON ca.memory_id = a.memory_id AND ca.chunk_idx = 0
       JOIN memory_chunks cb ON cb.memory_id = b.memory_id AND cb.chunk_idx = 0
      WHERE a.type <> 'claim' AND b.type <> 'claim'
        AND a.status = 'active' AND b.status = 'active'
        AND a.deleted_at IS NULL AND b.deleted_at IS NULL
        AND ca.embedding IS NOT NULL AND cb.embedding IS NOT NULL
        AND 1 - (ca.embedding <=> cb.embedding) >= $2
        AND ($1::text IS NULL OR a.username = $1)
      ORDER BY sim DESC
      LIMIT 100`,
    [user, args.similarity],
  );
  report.similar_understandings = similar.rows;
  return report;
}

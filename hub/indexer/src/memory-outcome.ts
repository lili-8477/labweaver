// The outcome loop (GLOSSARY.md): which memories a task used, and whether
// the task succeeded, feeding search ranking and promotion.

import type { Pool } from "pg";
import type { AccessClass } from "./access-classes.js";
import { DEFAULT_CLEARANCE, visibleSql } from "./memory-access.js";

/** SET clause that reinforces a memory (migration 0018): it was used, merged into, or helped a task succeed. */
export const REINFORCE_SQL = `reinforced_at = now(), reinforce_count = reinforce_count + 1`;

// Record the outcome of a task that used these memories. Counts toward
// ranking (success_count / failure_count). Only memories the caller can see are touched
// (memory-access.ts). Returns how many rows were updated.
export async function recordFeedback(args: {
  pool:       Pool;
  username:   string;
  memory_ids: string[];
  outcome:    "success" | "failure";
  clearance?: AccessClass;
}): Promise<{ updated: number }> {
  const r = await args.pool.query(
    `UPDATE memories
        SET success_count = success_count + CASE WHEN $3 = 'success' THEN 1 ELSE 0 END,
            failure_count = failure_count + CASE WHEN $3 = 'failure' THEN 1 ELSE 0 END,
            reinforced_at   = CASE WHEN $3 = 'success' THEN now() ELSE reinforced_at END,
            reinforce_count = reinforce_count + CASE WHEN $3 = 'success' THEN 1 ELSE 0 END,
            -- An anecdotal experience that worked twice is 'repeated'.
            validation_level = CASE
              WHEN validation_level = 'anecdotal' AND $3 = 'success' AND success_count + 1 >= 2
              THEN 'repeated' ELSE validation_level END
      WHERE memory_id = ANY($1::uuid[])
        AND deleted_at IS NULL
        AND ${visibleSql("memories", "$2", "$4")}`,
    [[...new Set(args.memory_ids)], args.username, args.outcome, args.clearance ?? DEFAULT_CLEARANCE],
  );
  return { updated: r.rowCount ?? 0 };
}

// ---------------------------------------------------------------------------
// Outcome loop (GLOSSARY.md): the agent's memory opens are recorded, and a
// step outcome credits the memories opened since the step began.

/** Opening a memory for work records the use, counts as a hit and reinforces it. */
export async function recordUse(args: { pool: Pool; username: string; memoryId: string }): Promise<void> {
  await args.pool.query(
    `WITH used AS (INSERT INTO memory_uses (username, memory_id) VALUES ($1, $2))
     UPDATE memories SET hit_count = hit_count + 1, last_hit_at = now(), ${REINFORCE_SQL} WHERE memory_id = $2`,
    [args.username, args.memoryId],
  );
}

/** The distinct memories `username` used since `since`. */
export async function usedSince(args: { pool: Pool; username: string; since: Date }): Promise<string[]> {
  const r = await args.pool.query<{ memory_id: string }>(
    `SELECT DISTINCT memory_id FROM memory_uses WHERE username = $1 AND used_at >= $2`,
    [args.username, args.since],
  );
  return r.rows.map((row) => row.memory_id);
}

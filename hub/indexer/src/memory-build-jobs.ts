// Memory builder jobs (migration 0026). The member's adapter creates a job,
// reports progress while it parses and imports, and finishes it; the Memory
// panel lists them. Every query is scoped to the job's owner.

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { BuildJob } from "./memory-contract.js";

export async function createBuildJob(pool: Pool, a: {
  username: string; project_dir: string | null; origin_kind: BuildJob["origin_kind"]; origin: string;
}): Promise<string> {
  const job_id = randomUUID();
  await pool.query(
    `INSERT INTO memory_build_jobs (job_id, username, project_dir, origin_kind, origin) VALUES ($1, $2, $3, $4, $5)`,
    [job_id, a.username, a.project_dir, a.origin_kind, a.origin],
  );
  return job_id;
}

const COUNTS = ["files_seen", "files_parsed", "files_skipped", "entries_created", "duplicates"] as const;

export type BuildJobUpdate = {
  status?: BuildJob["status"];
  error?:  string;
  report?: Record<string, unknown>;
} & Partial<Record<(typeof COUNTS)[number], number>>;

/** Set the given fields; a status of done or failed also stamps finished_at. */
export async function updateBuildJob(
  pool: Pool, a: { username: string; job_id: string } & BuildJobUpdate,
): Promise<boolean> {
  const sets: string[] = [];
  const vals: unknown[] = [a.job_id, a.username];
  const set = (col: string, v: unknown, cast = "") => { vals.push(v); sets.push(`${col} = $${vals.length}${cast}`); };
  if (a.status) set("status", a.status);
  for (const c of COUNTS) if (a[c] !== undefined) set(c, a[c]);
  if (a.report) set("report", JSON.stringify(a.report), "::jsonb");
  if (a.error !== undefined) set("error", a.error);
  if (a.status === "done" || a.status === "failed") sets.push("finished_at = now()");
  if (sets.length === 0) return true;
  const r = await pool.query(
    `UPDATE memory_build_jobs SET ${sets.join(", ")} WHERE job_id = $1 AND username = $2`, vals);
  return (r.rowCount ?? 0) > 0;
}

export async function listBuildJobs(pool: Pool, a: { username: string; limit?: number }): Promise<BuildJob[]> {
  const r = await pool.query(
    `SELECT job_id, project_dir, origin_kind, origin, status, files_seen, files_parsed, files_skipped,
            entries_created, duplicates, report, error, created_at, finished_at
       FROM memory_build_jobs WHERE username = $1 ORDER BY created_at DESC LIMIT $2`,
    [a.username, a.limit ?? 20],
  );
  return r.rows.map((row) => ({
    ...row,
    created_at:  row.created_at.toISOString(),
    finished_at: row.finished_at ? row.finished_at.toISOString() : null,
  }));
}

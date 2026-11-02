// Anti-bloat lifecycle for memories:
//   - per-directory cap: a directory instance (username, project_dir, dir_key)
//     holds at most `cap` live rows; beyond it the lowest-value distilled rows
//     (fewest hits, longest unused, oldest) are soft-deleted. User-authored
//     rows are never retired, so a directory can stay over cap (`over_cap`).
//   - retention pass (periodic): soft-delete distilled rows never recalled
//     after `staleDays`, and hard-delete rows soft-deleted more than
//     `purgeDays` ago (chunks, facets and audit rows go with them via
//     ON DELETE CASCADE).
// Every system soft-delete is audited as 'forget' by SYSTEM_ACTOR with the
// reason in `after`.
import type { Pool } from "pg";

export const SYSTEM_ACTOR = "__system__";

type Queryable = Pick<Pool, "query">;

// Retire distilled rows beyond the cap. With `instance`, only that directory
// instance is checked (the write path); without, every instance is (the
// periodic pass, which also trims rows that predate the cap). `keep` is never
// retired: the row just written hasn't had a chance to be recalled yet.
// Params: $1 cap, $2 username, $3 project_dir, $4 dir_key, $5 keep.
const ENFORCE_CAP_SQL = `
WITH live AS (
  SELECT m.memory_id, m.source, m.username, m.project_dir, m.dir_key,
         m.hit_count, m.last_hit_at, m.created_at,
         COUNT(*) OVER (PARTITION BY m.username, m.project_dir, m.dir_key) AS n
    FROM memories m
   WHERE m.deleted_at IS NULL
     AND ($2::text IS NULL OR (m.username = $2
                               AND m.project_dir IS NOT DISTINCT FROM $3::text
                               AND m.dir_key = $4::text))
), ranked AS (
  SELECT memory_id, n,
         ROW_NUMBER() OVER (PARTITION BY username, project_dir, dir_key
                            ORDER BY hit_count, last_hit_at NULLS FIRST, created_at, memory_id) AS rk
    FROM live
   WHERE n > $1 AND source = 'distilled' AND memory_id IS DISTINCT FROM $5::uuid
), retired AS (
  UPDATE memories m
     SET deleted_at = now(), updated_at = now()
    FROM ranked r
   WHERE m.memory_id = r.memory_id AND r.rk <= r.n - $1
  RETURNING m.memory_id, m.name
)
INSERT INTO memory_audit_log (memory_id, actor, action, before, after)
SELECT memory_id, '${SYSTEM_ACTOR}', 'forget',
       jsonb_build_object('deleted_at', NULL, 'name', name),
       '{"reason": "dir_cap"}'::jsonb
  FROM retired`;

export async function enforceDirCap(
  db: Queryable,
  args: {
    cap:       number;
    instance?: { username: string; project_dir: string | null; dir_key: string };
    keep?:     string;
  },
): Promise<number> {
  const i = args.instance;
  const r = await db.query(ENFORCE_CAP_SQL, [
    args.cap, i?.username ?? null, i?.project_dir ?? null, i?.dir_key ?? null, args.keep ?? null,
  ]);
  return r.rowCount ?? 0;
}

export interface RetentionPolicy {
  staleDays: number;   // distilled rows with hit_count=0 not updated for this long are retired
  purgeDays: number;   // rows soft-deleted this long ago are hard-deleted
  dirCap:    number;
}

const RETIRE_STALE_SQL = `
WITH retired AS (
  UPDATE memories
     SET deleted_at = now(), updated_at = now()
   WHERE deleted_at IS NULL
     AND source = 'distilled'
     AND hit_count = 0
     AND updated_at < now() - make_interval(days => $1::int)
  RETURNING memory_id, name
)
INSERT INTO memory_audit_log (memory_id, actor, action, before, after)
SELECT memory_id, '${SYSTEM_ACTOR}', 'forget',
       jsonb_build_object('deleted_at', NULL, 'name', name),
       '{"reason": "retention"}'::jsonb
  FROM retired`;

export async function runRetentionOnce(
  pool: Pool,
  policy: RetentionPolicy,
): Promise<{ retired_stale: number; retired_over_cap: number; purged: number }> {
  const stale = await pool.query(RETIRE_STALE_SQL, [policy.staleDays]);
  const retired_over_cap = await enforceDirCap(pool, { cap: policy.dirCap });
  const purged = await pool.query(
    `DELETE FROM memories WHERE deleted_at < now() - make_interval(days => $1::int)`,
    [policy.purgeDays],
  );
  return {
    retired_stale:    stale.rowCount ?? 0,
    retired_over_cap,
    purged:           purged.rowCount ?? 0,
  };
}

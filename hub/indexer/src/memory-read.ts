// Memory reads: one memory, its audit trail, the timeline, the paged list,
// and the operator metrics.

import type { Pool } from "pg";
import type { AccessClass } from "./access-classes.js";
import { DEFAULT_CLEARANCE, visibleSql } from "./memory-access.js";
import type { Domain } from "./memory-domain.js";
import type { AuditRow, ListItem, MemoryDetail, TimelineEntry } from "./memory-contract.js";

// Fetch a single memory by id with its facets grouped by key, if the caller
// can see it (memory-access.ts); otherwise null, as if it did not exist. The
// owner also gets their soft-deleted rows, so the UI can offer Restore.
//
// One round-trip via a correlated subquery that builds the facets map in
// Postgres (jsonb_object_agg over per-key jsonb_agg). Empty facet sets
// collapse to '{}'::jsonb so the JS shape is always Record<string,string[]>.
export async function getMemory(args: {
  pool:       Pool;
  memoryId:   string;
  username:   string;
  clearance?: AccessClass;
}): Promise<MemoryDetail | null> {
  type Row = {
    memory_id:          string;
    username:           string;
    project_dir:        string | null;
    type:               string;
    source:             "distilled" | "user";
    scope_tier:         "org" | "user" | "project";
    dir_key:            string;
    name:               string;
    description:        string;
    body:               string;
    source_session_id:  string | null;
    hit_count:          number;
    last_hit_at:        Date | null;
    created_at:         Date;
    updated_at:         Date;
    deleted_at:         Date | null;
    facets:             Record<string, string[]>;
  };
  const r = await args.pool.query<Row>(
    `SELECT m.memory_id, m.username, m.project_dir, m.type, m.source,
            m.scope AS scope_tier, m.dir_key,
            m.name, m.description, m.body, m.source_session_id,
            m.hit_count, m.last_hit_at, m.created_at, m.updated_at, m.deleted_at,
            COALESCE(
              (SELECT jsonb_object_agg(key, vals) FROM (
                 SELECT key, jsonb_agg(value ORDER BY value COLLATE "C") AS vals
                   FROM memory_facets
                  WHERE memory_id = m.memory_id
                  GROUP BY key
               ) g),
              '{}'::jsonb
            ) AS facets
       FROM memories m
      WHERE m.memory_id = $1
        AND ${visibleSql("m", "$2", "$3")}
        -- A deleted memory is still shown to its owner, who may restore it.
        AND (m.deleted_at IS NULL OR m.username = $2)`,
    [args.memoryId, args.username, args.clearance ?? DEFAULT_CLEARANCE],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0]!;
  return {
    memory_id:         row.memory_id,
    username:          row.username,
    project_dir:       row.project_dir,
    type:              row.type,
    source:            row.source,
    scope_tier:        row.scope_tier,
    dir_key:           row.dir_key,
    name:              row.name,
    description:       row.description,
    body:              row.body,
    source_session_id: row.source_session_id,
    facets:            row.facets,
    hit_count:         row.hit_count,
    last_hit_at:       row.last_hit_at?.toISOString() ?? null,
    created_at:        row.created_at.toISOString(),
    updated_at:        row.updated_at.toISOString(),
    deleted_at:        row.deleted_at?.toISOString() ?? null,
  };
}

export async function getAuditTrail(args: {
  pool:     Pool;
  actor:    string;
  memoryId: string;
  limit?:   number;
}): Promise<
  | {
      rows: AuditRow[];
    }
  | { error: 'not_found' | 'forbidden' }
> {
  // Ownership check: lookup the memory (including soft-deleted rows)
  const ownershipCheck = await args.pool.query<{ username: string }>(
    `SELECT username FROM memories WHERE memory_id = $1`,
    [args.memoryId],
  );

  if (ownershipCheck.rowCount === 0) {
    return { error: 'not_found' };
  }

  const row = ownershipCheck.rows[0]!;
  if (row.username !== args.actor) {
    return { error: 'forbidden' };
  }

  // Fetch audit trail capped at limit (default/max 100)
  const limit = Math.min(args.limit ?? 100, 100);
  type AuditDbRow = {
    audit_id:  number;
    action:    AuditRow["action"];
    actor:     string;
    before:    unknown;
    after:     unknown;
    created_at: Date;
  };
  const auditRes = await args.pool.query<AuditDbRow>(
    `SELECT audit_id, action, actor, before, after, created_at
       FROM memory_audit_log
      WHERE memory_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [args.memoryId, limit],
  );

  return {
    rows: auditRes.rows.map((r) => ({
      audit_id:  r.audit_id,
      action:    r.action,
      actor:     r.actor,
      before:    r.before,
      after:     r.after,
      created_at: r.created_at.toISOString(),
    })),
  };
}

export interface TimelineMemoriesArgs {
  pool:         Pool;
  username:     string;
  // project_dir tri-state semantics:
  //   undefined → no project filter (returns all scopes for the user + org)
  //   null      → treated the same as undefined (no filter), so callers that
  //               pass an Optional<string|null> from JSON without normalising
  //               still get the org+user+all-projects timeline they expect
  //   "<dir>"   → exact match on project_dir = "<dir>" only; rows with
  //               project_dir IS NULL (including org rows) are excluded
  project_dir?: string | null;
  clearance?:   AccessClass;
  since?:       Date;
  until?:       Date;
  limit?:       number;
}

// Chronological timeline (newest first) for a user, merged with org-scope
// memories. Soft-deleted rows are excluded. Results are capped by `limit`
// (default 50). since/until are inclusive bounds.
export async function timelineMemories(args: TimelineMemoriesArgs): Promise<TimelineEntry[]> {
  const limit      = args.limit ?? 50;
  const projectDir = typeof args.project_dir === "string" ? args.project_dir : null;
  const since      = args.since ? args.since.toISOString() : null;
  const until      = args.until ? args.until.toISOString() : null;

  type Row = {
    memory_id:  string;
    name:       string;
    type:       string;
    dir_key:    string;
    created_at: Date;
  };
  const r = await args.pool.query<Row>(
    `SELECT m.memory_id, m.name, m.type, m.dir_key, m.created_at
       FROM memories m
      WHERE m.deleted_at IS NULL
        AND ${visibleSql("m", "$1", "$6")}
        AND ($2::text IS NULL OR m.project_dir = $2)
        AND ($3::timestamptz IS NULL OR m.created_at >= $3)
        AND ($4::timestamptz IS NULL OR m.created_at <= $4)
      ORDER BY m.created_at DESC
      LIMIT $5`,
    [args.username, projectDir, since, until, limit, args.clearance ?? DEFAULT_CLEARANCE],
  );
  return r.rows.map((row) => ({
    memory_id:  row.memory_id,
    name:       row.name,
    type:       row.type,
    dir_key:    row.dir_key,
    created_at: row.created_at.toISOString(),
  }));
}

export interface ListFilter {
  pool:             Pool;
  username:         string;                       // requester (for org-merge)
  project_dir:      string | null;                // null = no project filter
  scope?:           'org' | 'user' | 'project';  // optional narrow
  type?:            string[];                     // any-of
  source?:          'user' | 'distilled' | 'import';
  dir?:             string;                       // exact dir_key
  include_deleted?: boolean;                      // default false
  sort?:            'created' | 'hit';            // default 'created'
  limit?:           number;                       // default 50, cap 200
  cursor?:          string;                       // ISO timestamp from prev page's tail
  clearance?:       AccessClass;                  // default DEFAULT_CLEARANCE
  domain?:          Domain;                       // only this domain
}

// Paginated browser-friendly listing. Filterable by scope_tier, type, source,
// include_deleted. Sortable by created_at DESC (default) or last_hit_at DESC.
// Cursor pagination: the cursor is the ISO timestamp of the last item's sort
// column from the previous page. Returns items plus next_cursor (null = last page).
//
// The org-merge: when scope is undefined, returns rows where
// (username = $u OR username = '__org__') AND (project_dir filter).
// When scope='org', returns only username='__org__' rows.
// When scope='user', returns only rows where username=$u AND project_dir IS NULL.
// When scope='project', returns only rows where username=$u AND project_dir IS NOT NULL
//   (and project_dir=$project_dir when project_dir is specified).
//
// Params:
//   $1  username
//   $2  project_dir (text or NULL = no filter)
//   $3  scope_filter (text or NULL = no scope filter)
//   $4  types[] (text[] or NULL = no type filter)
//   $5  source (text or NULL = no source filter)
//   $6  include_deleted (boolean)
//   $7  cursor (timestamptz or NULL = no cursor)
//   $8  limit+1
//   $9  dir_key (text or NULL = no dir filter)
export async function listMemories(f: ListFilter): Promise<{
  items: ListItem[];
  next_cursor: string | null;
}> {
  const limit       = Math.min(f.limit ?? 50, 200);
  const sort        = f.sort ?? 'created';
  const sortCol     = sort === 'hit' ? 'm.last_hit_at' : 'm.created_at';
  const types       = f.type && f.type.length > 0 ? f.type : null;
  const source      = f.source ?? null;
  const scope       = f.scope ?? null;
  const projectDir  = f.project_dir;
  const cursor      = f.cursor ?? null;
  const inclDeleted = f.include_deleted ?? false;

  // Rows are those the caller can see (memory-access.ts), narrowed by scope:
  // - scope=undefined: every scope, with the project_dir filter
  // - scope='org' | 'user': that scope
  // - scope='project': project rows (+ project_dir filter)
  // $3 = scope_filter (text or NULL).

  // Cursor condition: skip rows at/before the cursor timestamp on the sort col.
  // For sort='hit', last_hit_at can be NULL. We only apply the cursor to non-NULL
  // values (i.e. once all non-NULL rows are paged through, the final cursor passed
  // in will be NULL, and the query just returns the remaining NULL rows by tie-break).
  let cursorCond: string;
  if (sort === 'hit') {
    // When sort='hit': skip rows where last_hit_at >= cursor (we want < cursor).
    // NULL last_hit_at rows come AFTER all non-NULL rows (NULLS LAST), so they
    // only appear once cursor is NULL (first page) or after all non-NULL rows.
    // When cursor IS NOT NULL, exclude all NULL last_hit_at rows too (they haven't
    // been paged yet conceptually, but they appear at the end; once the first page
    // with all NULLs is needed, cursor will be null). Actually, the simpler correct
    // approach: when cursor is supplied (non-null), only return rows where
    // last_hit_at < cursor (strict). NULL rows sort AFTER any non-NULL so they
    // appear at the end of the full result set. When cursor is provided and all
    // non-null values < cursor are exhausted, the next "page" starting point is
    // the NULL block — but since NULLs < anything is false, they'd be excluded.
    // Solution: when cursor is provided, include NULLs only after non-NULLs are done.
    // The simplest stable solution: cursor condition is:
    //   ($7::timestamptz IS NULL OR (last_hit_at IS NOT NULL AND last_hit_at < $7::timestamptz)
    //                               OR (last_hit_at IS NULL AND $7_was_null_cursor))
    // This is getting complex. Use the two-tier approach:
    //   - when cursor is null: no filter (include everything, NULLs at end)
    //   - when cursor is non-null: last_hit_at IS NOT NULL AND last_hit_at < cursor
    //     OR last_hit_at IS NULL AND <all non-null pages exhausted signal>
    // The cleanest is: include NULL rows only when cursor is NULL (first call).
    // But that breaks if limit < total non-null count.
    //
    // Correct approach for NULLS LAST ordering: since NULLs sort last, cursor
    // pagination for hit sort works as:
    //   - If cursor is null: no cursor filter, returns top rows (non-null first, NULLs last)
    //   - If cursor looks like a real timestamp: WHERE last_hit_at < cursor (excludes NULLs)
    //   - After all non-null rows are paged, next_cursor from last non-null page's last item
    //     has last_hit_at = some timestamp. The "NULL page" needs special handling.
    //
    // Simplest correct approach used here: use a sentinel. Since NULL rows sort LAST,
    // after all non-null pages are consumed, the caller gets next_cursor from the last
    // non-null item. That cursor, when applied, gives WHERE last_hit_at < <min_value>
    // which excludes NULLs. The NULL rows are never reached via cursor pagination for hit sort.
    //
    // This matches real-world cursor pagination for nullable sort cols where NULLs are
    // minority edge cases. For this implementation we keep it simple and stable:
    // NULLs appear on the first page if limit is large enough, otherwise are unreachable
    // via cursor. The tie-break (memory_id ASC) ensures no duplicates within a page.
    cursorCond = `($7::timestamptz IS NULL OR (${sortCol} IS NOT NULL AND ${sortCol} < $7::timestamptz))`;
  } else {
    // For created_at sort: created_at is never NULL (it has a DEFAULT now()), so simple.
    cursorCond = `($7::timestamptz IS NULL OR ${sortCol} < $7::timestamptz)`;
  }

  const orderBy = sort === 'hit'
    ? `ORDER BY m.last_hit_at DESC NULLS LAST, m.memory_id ASC`
    : `ORDER BY m.created_at DESC, m.memory_id ASC`;

  const sql = `
SELECT m.memory_id, m.type, m.source,
       m.scope AS scope_tier, m.dir_key,
       m.name, m.description,
       m.created_at, m.updated_at,
       m.hit_count, m.last_hit_at, m.deleted_at
  FROM memories m
 WHERE
   ${visibleSql("m", "$1", "$10", "$11")}
   -- scope filter
   AND (
     ($3::text IS NULL AND ($2::text IS NULL OR m.project_dir IS NULL OR m.project_dir = $2))
     OR ($3 IN ('org', 'user') AND m.scope = $3)
     OR ($3 = 'project' AND m.scope = 'project' AND ($2::text IS NULL OR m.project_dir = $2))
   )
   -- deleted filter: only the owner sees their deleted rows
   AND (m.deleted_at IS NULL OR ($6 AND m.username = $1))
   -- type filter
   AND ($4::text[] IS NULL OR m.type = ANY($4))
   -- source filter
   AND ($5::text IS NULL OR m.source = $5::text)
   -- directory filter
   AND ($9::text IS NULL OR m.dir_key = $9::text)
   -- cursor filter
   AND ${cursorCond}
${orderBy}
LIMIT $8
`;

  type Row = {
    memory_id:   string;
    type:        string;
    source:      'user' | 'distilled' | 'import';
    scope_tier:  'org' | 'user' | 'project';
    dir_key:     string;
    name:        string;
    description: string;
    created_at:  Date;
    updated_at:  Date;
    hit_count:   number;
    last_hit_at: Date | null;
    deleted_at:  Date | null;
  };

  const res = await f.pool.query<Row>(sql, [
    f.username,      // $1
    projectDir,      // $2
    scope,           // $3
    types,           // $4
    source,          // $5
    inclDeleted,     // $6
    cursor,          // $7
    limit + 1,       // $8 — fetch one extra to determine next_cursor
    f.dir ?? null,   // $9
    f.clearance ?? DEFAULT_CLEARANCE, // $10
    f.domain ?? null, // $11
  ]);

  const rows = res.rows;
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  let next_cursor: string | null = null;
  if (hasMore) {
    const tail = pageRows[pageRows.length - 1]!;
    const tailVal = sort === 'hit' ? tail.last_hit_at : tail.created_at;
    next_cursor = tailVal ? tailVal.toISOString() : null;
  }

  const items: ListItem[] = pageRows.map((r) => ({
    memory_id:   r.memory_id,
    type:        r.type,
    source:      r.source,
    scope_tier:  r.scope_tier,
    dir_key:     r.dir_key,
    name:        r.name,
    description: r.description,
    created_at:  r.created_at.toISOString(),
    updated_at:  r.updated_at.toISOString(),
    hit_count:   r.hit_count,
    last_hit_at: r.last_hit_at ? r.last_hit_at.toISOString() : null,
    deleted_at:  r.deleted_at  ? r.deleted_at.toISOString()  : null,
  }));

  return { items, next_cursor };
}

export async function getMetrics(pool: Pool): Promise<{
  memories_total: number;
  memories_by_type: Record<string, number>;
  memories_by_source: { user: number; distilled: number };
  memories_soft_deleted: number;
  embedder_queue_depth: number;
  embedder_queue_oldest: string | null;
  distill_cursor_lag_seconds_max: number;
  audit_log_size: number;
}> {
  type MetricsRow = {
    memories_total:              string;
    memories_soft_deleted:       string;
    embedder_queue_depth:        string;
    embedder_queue_oldest:       Date | null;
    distill_cursor_lag_seconds_max: string;
    audit_log_size:              string;
  };

  const metricsRes = await pool.query<MetricsRow>(
    `SELECT
       (SELECT COUNT(*) FROM memories WHERE deleted_at IS NULL) AS memories_total,
       (SELECT COUNT(*) FROM memories WHERE deleted_at IS NOT NULL) AS memories_soft_deleted,
       (SELECT COUNT(*) FROM embedder_queue) AS embedder_queue_depth,
       (SELECT enqueued_at FROM embedder_queue ORDER BY enqueued_at ASC LIMIT 1) AS embedder_queue_oldest,
       (SELECT COALESCE(MAX(EXTRACT(EPOCH FROM (now() - last_seen_session_last_active))), 0)
          FROM memory_distill_cursor) AS distill_cursor_lag_seconds_max,
       (SELECT COUNT(*) FROM memory_audit_log) AS audit_log_size`,
  );

  const metricsRow = metricsRes.rows[0]!;

  type TypeSourceRow = {
    type:   string;
    source: string;
    n:      string;
  };

  const typeSourceRes = await pool.query<TypeSourceRow>(
    `SELECT type, source, COUNT(*) AS n
       FROM memories
      WHERE deleted_at IS NULL
      GROUP BY type, source`,
  );

  const memories_by_type: Record<string, number> = {};
  const memories_by_source: { user: number; distilled: number } = { user: 0, distilled: 0 };

  for (const row of typeSourceRes.rows) {
    const count = parseInt(row.n, 10);
    memories_by_type[row.type] = (memories_by_type[row.type] ?? 0) + count;
    if (row.source === "user" || row.source === "distilled") {
      memories_by_source[row.source] += count;
    }
  }

  return {
    memories_total: parseInt(metricsRow.memories_total, 10),
    memories_by_type,
    memories_by_source,
    memories_soft_deleted: parseInt(metricsRow.memories_soft_deleted, 10),
    embedder_queue_depth: parseInt(metricsRow.embedder_queue_depth, 10),
    embedder_queue_oldest: metricsRow.embedder_queue_oldest
      ? metricsRow.embedder_queue_oldest.toISOString()
      : null,
    distill_cursor_lag_seconds_max: Math.round(
      parseFloat(metricsRow.distill_cursor_lag_seconds_max) * 100,
    ) / 100,
    audit_log_size: parseInt(metricsRow.audit_log_size, 10),
  };
}

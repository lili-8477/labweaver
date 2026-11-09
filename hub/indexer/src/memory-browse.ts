// Browsing memory by directory: the agent's context index, the directory
// list, one directory, and the tree the UI draws.

import type { Pool } from "pg";
import { encodeProjectDir } from "./path-decode.js";
import type { AccessClass } from "./access-classes.js";
import { DEFAULT_CLEARANCE, visibleSql } from "./memory-access.js";
import type { Domain } from "./memory-domain.js";
import type { DirDetail, DirSummary, MemoryTree, TreeMemory, TreeTopic } from "./memory-contract.js";
import { truncate } from "./claims.js";
import { PRIOR_SCORE_SQL } from "./memory-search.js";

export interface GetContextArgs {
  pool:          Pool;
  username:      string;
  project_path:  string;
  budget_tokens: number;
  clearance?:    AccessClass;
}

export interface MemoryContext {
  system_prompt: string;
  memory_ids:    string[];
}

// SessionStart directory index (phase 3). Instead of dumping memory bodies,
// list each non-empty directory with its L0 and its top few entries (name,
// description, id), project first, then user, then org, until the budget
// (`budget_tokens * 4` chars) is spent. The agent drills down with
// memory_dir / memory_get. Returns {system_prompt: "", memory_ids: []} when
// the caller has no memories: the hook then emits nothing.
//
// project_path is the raw absolute path inside the user's container (e.g.
// "/workspace/pbmc3k"), encoded via encodeProjectDir.
const CONTEXT_ENTRIES_PER_DIR = 3;
const CONTEXT_SCOPE_ORDER = { project: 0, user: 1, org: 2 } as const;
const CONTEXT_HEADER =
  "# Memory index\n\n" +
  "Your long-term memory, by directory: each line is a directory's summary and entry count, " +
  "followed by its top entries. Read a directory's full overview with memory_dir, " +
  "an entry's full text with memory_get(id), or search with memory_search " +
  "(memory_context for a cited bundle).\n" +
  "After a task where a memory informed your work, call memory_feedback with those " +
  "memory ids and whether the task succeeded.\n\n";

export async function getContext(args: GetContextArgs): Promise<MemoryContext> {
  const project_dir = encodeProjectDir(args.project_path);
  const dirs = (await listDirs({ pool: args.pool, username: args.username, project_dir, clearance: args.clearance }))
    .filter((d) => d.entry_count > 0)
    .sort((a, b) => CONTEXT_SCOPE_ORDER[a.scope] - CONTEXT_SCOPE_ORDER[b.scope]);
  if (dirs.length === 0) return { system_prompt: "", memory_ids: [] };

  const charBudget = args.budget_tokens * 4;
  const parts = [CONTEXT_HEADER];
  const ids: string[] = [];
  let used = CONTEXT_HEADER.length;
  const fits = (line: string) => used + line.length <= charBudget;

  outer:
  for (const d of dirs) {
    const dirLine = `- ${d.dir_key} (${d.entry_count}): ${d.l0}\n`;
    if (!fits(dirLine)) break;
    parts.push(dirLine);
    used += dirLine.length;
    const entries = await dirEntries({
      pool: args.pool, username: args.username, project_dir, clearance: args.clearance,
      dir_key: d.dir_key, limit: CONTEXT_ENTRIES_PER_DIR,
    });
    for (const e of entries) {
      const line = `  - ${e.name}: ${truncate(e.description, 120)} [${e.memory_id}]\n`;
      if (!fits(line)) break outer;
      parts.push(line);
      used += line.length;
      ids.push(e.memory_id);
    }
  }
  return { system_prompt: parts.join(""), memory_ids: ids };
}

// Name of the sentinel row distiller.ts writes on permanent failure; never
// surfaced to agents.
const DISTILL_FAILED_NAME = "raw distillation failed";

// ---------------------------------------------------------------------------
// Directories. L0 is the static memory_dirs.l0 line; L1 is computed here from
// the owner's entries so it is never stale. A caller sees the org and user
// directories always, and the project directories only with a project_dir.

// Params: $1 username, $2 project_dir (NULL = no project), $4 clearance,
// and the domain parameter `domain` names, if any.
const DIR_VISIBLE_SQL = `(d.scope <> 'project' OR $2::text IS NOT NULL)`;
// A directory counts the entries the caller can see, project ones from $2 only.
const dirEntrySql = (domain?: string) => `
  (${visibleSql("m", "$1", "$4", domain)} AND (m.scope <> 'project' OR m.project_dir = $2))`;

// all_projects (UI tree): show project directories even without a
// project_dir, counting entries across all of the caller's projects.
export async function listDirs(args: {
  pool:          Pool;
  username:      string;
  project_dir:   string | null;
  all_projects?: boolean;
  clearance?:    AccessClass;
  domain?:       Domain;
}): Promise<DirSummary[]> {
  type Row = Omit<DirSummary, "updated_at"> & { updated_at: Date | null };
  const r = await args.pool.query<Row>(
    `SELECT d.dir_key, d.scope, d.l0,
            COUNT(m.memory_id)::int AS entry_count,
            MAX(m.updated_at)       AS updated_at
       FROM memory_dirs d
       LEFT JOIN memories m
         ON m.dir_key = d.dir_key
        AND m.deleted_at IS NULL
        AND m.name <> '${DISTILL_FAILED_NAME}'
        AND (${dirEntrySql("$5")} OR ($3 AND m.scope = 'project' AND ${visibleSql("m", "$1", "$4", "$5")}))
      WHERE ${DIR_VISIBLE_SQL} OR $3
      GROUP BY d.dir_key, d.scope, d.l0, d.sort, d.hide_empty
     HAVING NOT d.hide_empty OR COUNT(m.memory_id) > 0
      ORDER BY d.sort`,
    [args.username, args.project_dir, args.all_projects ?? false, args.clearance ?? DEFAULT_CLEARANCE, args.domain ?? null],
  );
  return r.rows.map((row) => ({
    ...row,
    updated_at: row.updated_at ? row.updated_at.toISOString() : null,
  }));
}

// ---------------------------------------------------------------------------
// Memory tree: every directory, its live entries with usage counters, and
// "topics" — memories sharing a pipeline/tool/dataset facet. A topic that has
// gathered enough knowledge and has proven itself in tasks is a candidate to
// be distilled into a skill. Feeds the UI tree view and the memory_tree tool.

const TOPIC_FACETS = ["pipeline", "tool", "dataset"];
export const SKILL_MIN_MEMORIES  = 3;
export const SKILL_MIN_SUCCESSES = 3;

export async function memoryTree(args: {
  pool:       Pool;
  username:   string;
  limit?:     number;
  clearance?: AccessClass;
  domain?:    Domain;
}): Promise<MemoryTree> {
  const clearance = args.clearance ?? DEFAULT_CLEARANCE;
  type Row = Omit<TreeMemory, "created_at" | "updated_at"> & { created_at: Date; updated_at: Date };
  const [dirs, r] = await Promise.all([
    listDirs({ pool: args.pool, username: args.username, project_dir: null, all_projects: true, clearance, domain: args.domain }),
    args.pool.query<Row>(
      `SELECT m.memory_id, m.name, m.description, m.dir_key, m.scope, m.project_dir,
              m.created_at, m.updated_at, m.hit_count, m.success_count, m.failure_count,
              COALESCE(array_agg(f.key || ':' || f.value ORDER BY f.key, f.value)
                       FILTER (WHERE f.key IS NOT NULL), '{}') AS topics
         FROM memories m
         LEFT JOIN memory_facets f ON f.memory_id = m.memory_id AND f.key = ANY($2)
        WHERE m.deleted_at IS NULL
          AND m.name <> '${DISTILL_FAILED_NAME}'
          AND ${visibleSql("m", "$1", "$4", "$5")}
        GROUP BY m.memory_id
        ORDER BY m.created_at DESC
        LIMIT $3`,
      [args.username, TOPIC_FACETS, args.limit ?? 2000, clearance, args.domain ?? null],
    ),
  ]);
  const memories = r.rows.map((row) => ({
    ...row,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }));
  return {
    dirs,
    memories,
    topics: groupTopics(memories),
    thresholds: { memories: SKILL_MIN_MEMORIES, successes: SKILL_MIN_SUCCESSES },
  };
}

function groupTopics(memories: TreeMemory[]): TreeTopic[] {
  const byTopic = new Map<string, TreeMemory[]>();
  for (const m of memories) {
    for (const t of m.topics) byTopic.set(t, [...(byTopic.get(t) ?? []), m]);
  }
  const topics: TreeTopic[] = [];
  for (const [topic, ms] of byTopic) {
    if (ms.length < 2) continue;
    const sum = (k: "hit_count" | "success_count" | "failure_count") =>
      ms.reduce((n, m) => n + m[k], 0);
    const success_count = sum("success_count");
    const readiness =
      (Math.min(1, ms.length / SKILL_MIN_MEMORIES) + Math.min(1, success_count / SKILL_MIN_SUCCESSES)) / 2;
    const [key, ...rest] = topic.split(":");
    topics.push({
      topic, key: key!, value: rest.join(":"),
      memory_ids:    ms.map((m) => m.memory_id),
      dirs:          [...new Set(ms.map((m) => m.dir_key))],
      memory_count:  ms.length,
      hit_count:     sum("hit_count"),
      success_count,
      failure_count: sum("failure_count"),
      readiness,
      ready:         readiness >= 1,
    });
  }
  return topics.sort((a, b) => b.readiness - a.readiness || b.memory_count - a.memory_count);
}

// Directory L1: the directory's L0 plus its top `limit` entries ranked by the
// same prior as session-start context. Returns null when the directory does
// not exist or is not visible to the caller.
export async function getDir(args: {
  pool:        Pool;
  username:    string;
  project_dir: string | null;
  dir_key:     string;
  limit?:      number;
  clearance?:  AccessClass;
}): Promise<DirDetail | null> {
  const summary = (await listDirs(args)).find((d) => d.dir_key === args.dir_key);
  if (!summary) return null;
  return { ...summary, entries: await dirEntries({ ...args, limit: args.limit ?? 20 }) };
}

async function dirEntries(args: {
  pool:        Pool;
  username:    string;
  project_dir: string | null;
  dir_key:     string;
  limit:       number;
  clearance?:  AccessClass;
}): Promise<DirDetail["entries"]> {
  type Row = { memory_id: string; name: string; description: string; updated_at: Date };
  const r = await args.pool.query<Row>(
    `SELECT m.memory_id, m.name, m.description, m.updated_at
       FROM memories m
      WHERE m.dir_key = $3
        AND m.deleted_at IS NULL
        AND m.name <> '${DISTILL_FAILED_NAME}'
        AND ${dirEntrySql()}
      ORDER BY ${PRIOR_SCORE_SQL} DESC, m.name, m.memory_id
      LIMIT $5`,
    [args.username, args.project_dir, args.dir_key, args.clearance ?? DEFAULT_CLEARANCE, args.limit],
  );
  return r.rows.map((row) => ({
    memory_id:   row.memory_id,
    name:        row.name,
    description: row.description,
    updated_at:  row.updated_at.toISOString(),
  }));
}

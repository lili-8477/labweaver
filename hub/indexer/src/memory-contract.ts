// The memory contract (GLOSSARY.md): every memory-api operation in one table
// — its HTTP route, the identity field the caller's process fills in, the
// caller's input schema, and the result shape. The API validates with these
// schemas (memory-api.ts) and the repo returns these result types, so the
// compiler holds both to the contract. The other tiers derive from it:
//   - the adapter forwards the UI's memory_* RPCs generically (callMemoryApi)
//   - mcp-memory derives each tool's JSON Schema from the input schemas
//   - the frontend imports the input and result types
// Kept dependency-free apart from zod (and the pure modules it imports) so
// all four packages can import it.

import { z } from "zod/v4";
import {
  CONDITIONS_HELP, DistillationFields, EXPERIENCE_SOURCE_MESSAGE, experienceSourcesValid,
} from "./distiller-prompts.js";
import { FACET_KEYS } from "./facet-keys.js";
import { DOMAIN_HELP, DOMAINS, UI_DOMAIN } from "./memory-domain.js";

// ─── shared pieces ──────────────────────────────────────────────────────

export const SCOPES = ["user", "project", "org"] as const;
export type Scope = (typeof SCOPES)[number];

export const EDGE_RELS = [
  "DERIVED_FROM", "SUPPORTS", "QUALIFIES", "CONTRADICTS",
  "SUPERSEDES", "RETRACTS", "VALIDATED_BY", "FAILED_TO_REPLICATE",
] as const;

const conditions = z.partialRecord(z.enum(FACET_KEYS), z.array(z.string()).min(1)).describe(CONDITIONS_HELP);
const domain = z.enum(DOMAINS).describe(DOMAIN_HELP);
const domainFilter = z.enum(DOMAINS).optional().describe("Only memories of this domain.");
const projectDir = z.string().describe("Encoded project dir (e.g. -home-alice-proj).");

/** What the memory builder sorts imported content into (memory-import.ts). */
export const IMPORT_CATEGORIES = ["protocol", "inventory", "data_record", "pipeline", "reference"] as const;
export type ImportCategory = (typeof IMPORT_CATEGORIES)[number];
export const ORIGIN_KINDS = ["file", "folder", "website"] as const;
export const BUILD_STATUSES = ["queued", "running", "done", "failed"] as const;

/** One entry the builder parsed from a source, before it becomes a memory. */
export const ImportEntrySchema = z.object({
  category:      z.enum(IMPORT_CATEGORIES),
  name:          z.string().min(1).max(80),
  description:   z.string().max(200),
  body:          z.string().min(1).max(1500),
  facets:        z.record(z.string(), z.array(z.string().max(200)).max(20)).optional(),
  origin_kind:   z.enum(ORIGIN_KINDS),
  origin:        z.string().min(1).max(1000).describe("Workspace-relative path, or the URL of a website snapshot."),
  origin_sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ImportEntry = z.infer<typeof ImportEntrySchema>;
const buildCounts = {
  files_seen:      z.number().int().min(0).optional(),
  files_parsed:    z.number().int().min(0).optional(),
  files_skipped:   z.number().int().min(0).optional(),
  entries_created: z.number().int().min(0).optional(),
  duplicates:      z.number().int().min(0).optional(),
};

// GET operations travel as a querystring, where every value is a string.
// These accept the typed value from code and the string from a query alike.
const queryInts = new WeakMap<object, number>();
const qInt = (max: number) => {
  const schema = z.union([z.number(), z.string().transform(Number)]).pipe(z.number().int().positive().max(max));
  queryInts.set(schema, max);
  return schema;
};
// `z.coerce.boolean` would read "false" as true; match the literals instead.
const qBool = z.union([z.boolean(), z.enum(["true", "false"])]).transform((v) => v === true || v === "true");
// A repeated ?type=a&type=b arrives as an array, a single one as a string.
const qList = z.union([z.string(), z.array(z.string())]).transform((v) => (typeof v === "string" ? [v] : v));

// ─── operations ─────────────────────────────────────────────────────────

type Method = "GET" | "POST" | "PUT";
/** The field the forwarding process fills with its own user: the caller never chooses it. */
type Identity = "username" | "actor" | null;

interface OpSpec<I extends z.ZodType = z.ZodType, Id extends Identity = Identity> {
  method: Method;
  /** Route; `:name` segments are filled from the input field of that name. */
  path: string;
  identity: Id;
  input: I;
}

const op = <I extends z.ZodType, Id extends Identity>(method: Method, path: string, identity: Id, input: I): OpSpec<I, Id> =>
  ({ method, path, identity, input });

export const MEMORY_OPS = {
  memory_search: op("POST", "/memory/search", "username", z.object({
    query:        z.string().min(1).describe("Free-text query."),
    project_dir:  projectDir.nullable().optional(),
    // Raw container path (e.g. /workspace/pbmc3k), encoded server-side; used
    // by hooks that only know CLAUDE_PROJECT_DIR.
    project_path: z.string().min(1).optional(),
    limit:        z.number().int().positive().max(100).optional(),
    types:        z.array(z.string()).optional().describe("Filter to memory types (user, feedback, project, reference, claim, experience)."),
    since:        z.iso.datetime().optional().describe("ISO-8601 cutoff; only memories created after are returned."),
    dirs:         z.array(z.string()).optional().describe("Restrict to directories (dir_key, e.g. project/decisions)."),
    conditions:   conditions.optional(),
    strict:       z.boolean().optional().describe("Also exclude memories that do not state a requested condition."),
    domain:       domainFilter,
  })),
  memory_get: op("GET", "/memory/:memory_id", "username", z.object({
    memory_id: z.string().min(1),
    use:       qBool.optional().describe("The agent is using this memory for its work: recorded for the outcome loop."),
  })),
  memory_timeline: op("GET", "/memory/timeline", "username", z.object({
    project_dir: projectDir.optional(),
    since:       z.iso.datetime().optional(),
    until:       z.iso.datetime().optional(),
    limit:       qInt(500).optional(),
  })),
  memory_context: op("GET", "/memory/context", "username", z.object({
    project_path:  z.string().min(1),
    budget_tokens: qInt(100000).optional(),
  })),
  memory_list: op("GET", "/memory/list", "username", z.object({
    project_dir:     z.string().optional(),
    scope:           z.enum(SCOPES).optional(),
    type:            qList.optional(),
    source:          z.enum(["user", "distilled", "import"]).optional(),
    dir:             z.string().optional(),
    include_deleted: qBool.default(false),
    sort:            z.enum(["created", "hit"]).optional(),
    limit:           qInt(200).optional(),
    cursor:          z.iso.datetime().optional(),
    domain:          domainFilter,
  })),
  memory_dirs: op("GET", "/memory/dirs", "username", z.object({
    project_dir:  projectDir.optional().describe("Encoded project dir; required to see project/* directories."),
    all_projects: qBool.default(false),
    domain:       domainFilter,
  })),
  memory_dir: op("GET", "/memory/dirs/:dir_key", "username", z.object({
    dir_key:     z.string().min(1).describe("dir_key, e.g. project/decisions."),
    project_dir: projectDir.optional().describe("Encoded project dir; required to see project/* directories."),
    limit:       qInt(200).optional().describe("Max entries in the overview (default 20)."),
  })),
  memory_tree: op("GET", "/memory/tree", "username", z.object({
    limit:  qInt(5000).optional(),
    domain: domainFilter,
  })),
  // v1's context graph (memory-graph.ts): memories, skills and resources.
  memory_graph: op("GET", "/memory/graph", "username", z.object({
    include_deleted: qBool.default(false),
    domain:          domainFilter,
  })),
  memory_outcome: op("POST", "/memory/outcome", "username", z.object({
    outcome: z.enum(["success", "failure"]),
    since:   z.iso.datetime().describe("Credit the memories the agent used from this time on."),
  })),
  memory_feedback: op("POST", "/memory/feedback", "username", z.object({
    memory_ids: z.array(z.uuid()).min(1).max(100),
    outcome:    z.enum(["success", "failure"]),
  })),
  memory_write: op("POST", "/memory/write", "username", z.object({
    scope:       z.enum(SCOPES),
    project_dir: z.string().nullable().optional().describe("Required when scope='project'."),
    type:        z.enum(["user", "feedback", "project", "reference"]),
    name:        z.string().min(1),
    description: z.string(),
    body:        z.string(),
    domain,
    facets:      z.record(z.string(), z.array(z.string())).optional(),
    dir:         z.string().optional().describe("Directory in the same scope (e.g. project/decisions). Omit to file by type."),
    force_new:   z.boolean().optional().describe("Write even if similar memories exist. Only after reviewing a `similar` response and deciding the new memory is distinct."),
  })),
  memory_distill: op("POST", "/memory/distill", "username", DistillationFields.extend({
    project_dir:       projectDir.nullable().optional().describe("Encoded project dir (e.g. -home-alice-proj). Omit for user-scope distill."),
    source_session_id: z.uuid().nullable().optional().describe("Session UUID, only if you know it."),
  }).refine(experienceSourcesValid, { message: EXPERIENCE_SOURCE_MESSAGE })),
  memory_bundle: op("POST", "/memory/bundle", "username", z.object({
    query:         z.string().min(1).describe("The task or question. Include exact IDs (genes, samples, lots, versions)."),
    project_dir:   projectDir.nullable().optional().describe("Encoded project dir. Omit for user scope."),
    project_path:  z.string().min(1).optional(),
    conditions:    conditions.optional(),
    strict:        z.boolean().optional().describe("Also exclude memories that do not state a requested condition."),
    limit:         z.number().int().positive().max(30).optional(),
    budget_tokens: z.number().int().positive().max(8000).optional(),
  })),
  memory_consolidate: op("POST", "/memory/consolidate", "actor", z.object({
    username: z.string().min(1).optional(),
  })),
  memory_link: op("POST", "/memory/link", "actor", z.object({
    src_id: z.uuid(),
    dst_id: z.uuid(),
    rel:    z.enum(EDGE_RELS),
    status: z.enum(["accepted", "rejected"]).optional(),
    note:   z.string().max(500).optional(),
  })),
  memory_import: op("POST", "/memory/import", "username", z.object({
    project_dir:     projectDir.nullable().describe("Encoded project dir for project scope; null for the member's own scope."),
    builder_version: z.number().int().positive(),
    entries:         z.array(ImportEntrySchema).min(1).max(200),
  })),
  memory_import_seen: op("POST", "/memory/import/seen", "username", z.object({
    project_dir:    projectDir.nullable(),
    origin_sha256s: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1).max(500),
  })),
  memory_build_job_create: op("POST", "/memory/build-jobs", "username", z.object({
    project_dir: projectDir.nullable(),
    origin_kind: z.enum(ORIGIN_KINDS),
    origin:      z.string().min(1).max(1000),
  })),
  memory_build_job_update: op("PUT", "/memory/build-jobs/:job_id", "username", z.object({
    job_id: z.uuid(),
    status: z.enum(BUILD_STATUSES).optional(),
    error:  z.string().max(2000).optional(),
    report: z.record(z.string(), z.unknown()).optional(),
    ...buildCounts,
  })),
  memory_build_jobs: op("GET", "/memory/build-jobs", "username", z.object({
    limit: qInt(50).optional(),
  })),
  memory_forget: op("POST", "/memory/forget", "username", z.object({
    memory_id: z.string().min(1),
  })),
  memory_update: op("PUT", "/memory/:memory_id", "actor", z.object({
    memory_id:   z.string().min(1),
    name:        z.string().min(1),
    description: z.string(),
    body:        z.string().min(1).describe("The full body (replaces the old one)."),
    dir:         z.string().optional(),
    domain:      domain.optional().describe("Change the domain, e.g. a lab memory filed as technical."),
    merge:       z.boolean().optional(),
  })),
  memory_restore: op("POST", "/memory/:memory_id/restore", "actor", z.object({
    memory_id: z.string().min(1),
  })),
  memory_audit: op("GET", "/memory/:memory_id/audit", "actor", z.object({
    memory_id: z.string().min(1),
    limit:     qInt(100).optional(),
  })),
} as const;

export type MemoryOp = keyof typeof MEMORY_OPS;
/** What a caller passes for an operation (identity excluded). */
export type MemoryInput<O extends MemoryOp> = z.input<(typeof MEMORY_OPS)[O]["input"]>;

/**
 * JSON Schema of an input, as an agent's tool schema (mcp-memory): the input
 * side, without the querystring spellings an agent never needs.
 */
export function toolJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...json } = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
    override: (ctx) => {
      const js = ctx.jsonSchema as Record<string, unknown>;
      const max = queryInts.get(ctx.zodSchema);
      if (max !== undefined) {
        for (const k of Object.keys(js)) delete js[k];
        Object.assign(js, { type: "integer", minimum: 1, maximum: max });
      }
      // The ISO date-time regex beside format: date-time is noise to a model.
      if (js.format === "date-time") delete js.pattern;
    },
  });
  return json;
}

/**
 * The UI's listing operations. The adapter pins them to UI_DOMAIN: the chat
 * UI's users are life scientists, so technical memories stay agent-only.
 */
export const UI_DOMAIN_OPS = ["memory_search", "memory_list", "memory_dirs", "memory_tree", "memory_graph"] as const satisfies readonly MemoryOp[];
export { UI_DOMAIN };

/** Operations the chat UI may call through the adapter. */
export const UI_OPS = [
  "memory_search", "memory_get", "memory_list", "memory_dirs", "memory_tree", "memory_graph",
  "memory_update", "memory_forget", "memory_restore", "memory_audit", "memory_build_jobs",
] as const satisfies readonly MemoryOp[];
export type UiOp = (typeof UI_OPS)[number];

type IdentityOf<O extends MemoryOp> = (typeof MEMORY_OPS)[O]["identity"];
/** What the API sees for an operation: the parsed input plus the identity field. */
export type ApiData<O extends MemoryOp> = z.output<(typeof MEMORY_OPS)[O]["input"]>
  & (IdentityOf<O> extends string ? Record<IdentityOf<O>, string> : unknown);

/** The schema the API validates: the caller's input plus the identity field. */
export function apiSchema<O extends MemoryOp>(name: O): z.ZodType<ApiData<O>> {
  const spec: OpSpec = MEMORY_OPS[name];
  const schema = spec.identity
    ? z.intersection(spec.input, z.object({ [spec.identity]: z.string().min(1) }))
    : spec.input;
  return schema as z.ZodType<ApiData<O>>;
}

/**
 * Why a user-side caller (the UI through the adapter, or the agent through
 * mcp-memory) may not make this call, or null. Org memory is written only by
 * the platform; the API itself accepts org writes for the indexer's own use.
 */
export function callerRefusal(name: MemoryOp, params: Record<string, unknown>): string | null {
  if (name === "memory_write" && params.scope === "org") {
    return "org-scope writes are admin-only and not available from a user container";
  }
  return null;
}

// ─── results ────────────────────────────────────────────────────────────
// The shapes the repo returns and the wire carries (times as ISO strings).

export interface SearchHit {
  memory_id:   string;
  name:        string;
  description: string;
  dir_key:     string;
  snippet:     string;
  score:       number;
  scope_tier:  Scope;
  // List-row parity: the memory panel renders hits with the list-row component.
  type:        string;
  source:      "user" | "distilled" | "import";
  created_at:  string;
  updated_at:  string;
  hit_count:   number;
  last_hit_at: string | null;
  deleted_at:  string | null;
  /** A facet equals an ID-like token of the query. */
  exact:       boolean;
}

export interface MemoryDetail {
  memory_id:         string;
  username:          string;
  project_dir:       string | null;
  type:              string;
  source:            "distilled" | "user";
  scope_tier:        Scope;
  dir_key:           string;
  name:              string;
  description:       string;
  body:              string;
  source_session_id: string | null;
  facets:            Record<string, string[]>;
  hit_count:         number;
  last_hit_at:       string | null;
  created_at:        string;
  updated_at:        string;
  /** Set for soft-deleted rows, so the UI can offer Restore. */
  deleted_at:        string | null;
}

export interface TimelineEntry {
  memory_id:  string;
  name:       string;
  type:       string;
  dir_key:    string;
  created_at: string;
}

export interface ListItem {
  memory_id:   string;
  type:        string;
  source:      "user" | "distilled" | "import";
  scope_tier:  Scope;
  dir_key:     string;
  name:        string;
  description: string;
  created_at:  string;
  updated_at:  string;
  hit_count:   number;
  last_hit_at: string | null;
  deleted_at:  string | null;
}

export interface DirSummary {
  dir_key:     string;
  scope:       Scope;
  l0:          string;
  entry_count: number;
  /** Newest entry; null when empty. */
  updated_at:  string | null;
}

export interface DirDetail extends DirSummary {
  entries: Array<{ memory_id: string; name: string; description: string; updated_at: string }>;
}

export interface TreeMemory {
  memory_id:     string;
  name:          string;
  description:   string;
  dir_key:       string;
  scope:         Scope;
  project_dir:   string | null;
  created_at:    string;
  updated_at:    string;
  hit_count:     number;
  success_count: number;
  failure_count: number;
  /** "pipeline:toy-stats", "tool:pandas", … */
  topics:        string[];
}

export interface TreeTopic {
  topic:         string;
  key:           string;
  value:         string;
  memory_ids:    string[];
  dirs:          string[];
  memory_count:  number;
  hit_count:     number;
  success_count: number;
  failure_count: number;
  /** 0..1; 1 = both thresholds met. */
  readiness:     number;
  ready:         boolean;
}

export interface MemoryTree {
  dirs:       DirSummary[];
  memories:   TreeMemory[];
  /** ≥2 memories, most ready first. */
  topics:     TreeTopic[];
  thresholds: { memories: number; successes: number };
}

export type GraphNode =
  | { id: string; kind: "memory"; label: string; description: string; scope: Scope; dir_key: string; deleted?: true }
  | { id: string; kind: "skill"; label: string; description: string; scope: "user" | "org"; path: string }
  | { id: string; kind: "resource"; label: string; type: "project" | "file" | "dataset"; path: string }
  | { id: string; kind: "topic"; label: string; facet: "gene" | "tool" };

export interface GraphEdge {
  source: string;
  target: string;
  kind:   "facet" | "project" | "mention";
}

export interface MemoryGraph {
  nodes:   GraphNode[];
  edges:   GraphEdge[];
  // Nodes left out by the caps, per kind (memories: lowest prior first;
  // others: fewest edges first).
  dropped: Record<GraphNode["kind"], number>;
}

export interface SimilarMemory {
  memory_id:   string;
  name:        string;
  description: string;
  body:        string;
  sim:         number;
}

export interface AuditRow {
  audit_id:   number;
  action:     "write" | "update" | "forget" | "restore" | "merge" | "status";
  actor:      string;
  before:     unknown;
  after:      unknown;
  created_at: string;
}

/** Result of each operation the UI reads. */
export interface MemoryResults {
  memory_search:   SearchHit[];
  memory_get:      MemoryDetail;
  memory_timeline: TimelineEntry[];
  memory_list:     { items: ListItem[]; next_cursor: string | null };
  memory_dirs:     DirSummary[];
  memory_dir:      DirDetail;
  memory_tree:     MemoryTree;
  memory_graph:    MemoryGraph;
  /** memory_id null: held back as a near-duplicate of `similar`. */
  memory_write:    { memory_id: string | null; similar?: SimilarMemory[] };
  memory_update:   { ok: true };
  memory_forget:   { ok: boolean };
  memory_restore:  { ok: true };
  memory_audit:    { rows: AuditRow[] };
  memory_feedback: { updated: number; proposed_for_org: string[] };
  memory_outcome:  { memory_ids: string[]; updated: number; proposed_for_org: string[] };
  memory_import:   { created: number; duplicates: number; memory_ids: string[] };
  memory_import_seen:      { seen: string[] };
  memory_build_job_create: { job_id: string };
  memory_build_job_update: { ok: boolean };
  memory_build_jobs:       BuildJob[];
}

/** A memory builder job as the Memory panel shows it (migration 0030). */
export interface BuildJob {
  job_id:          string;
  project_dir:     string | null;
  origin_kind:     (typeof ORIGIN_KINDS)[number];
  origin:          string;
  status:          (typeof BUILD_STATUSES)[number];
  files_seen:      number;
  files_parsed:    number;
  files_skipped:   number;
  entries_created: number;
  duplicates:      number;
  report:          Record<string, unknown>;
  error:           string | null;
  created_at:      string;
  finished_at:     string | null;
}

export type MemoryResult<O extends MemoryOp> = O extends keyof MemoryResults ? MemoryResults[O] : unknown;

// ─── calling the API ────────────────────────────────────────────────────

export class MemoryApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export interface CallOptions {
  baseUrl: string;
  /** Fills the operation's identity field; never taken from params. */
  user:    string;
  /** The container's SERVICE_ID, sent as a Bearer token so the hub knows the caller. */
  token?:  string;
  fetch?:  typeof fetch;
  timeoutMs?: number;
}

/**
 * Call one memory-api operation as `user`. Path segments come from params, the
 * rest travels as the query (GET) or JSON body. Throws MemoryApiError with the
 * API's `error` text on a non-2xx reply.
 */
export async function callMemoryApi<O extends MemoryOp>(
  name: O,
  params: Record<string, unknown>,
  opts: CallOptions,
): Promise<MemoryResult<O>> {
  const spec: OpSpec = MEMORY_OPS[name];
  const rest: Record<string, unknown> = { ...params };
  const path = spec.path.replace(/:(\w+)/g, (_, key: string) => {
    const v = rest[key];
    delete rest[key];
    return encodeURIComponent(String(v ?? ""));
  });
  // Set last, so a caller-supplied value never survives.
  if (spec.identity) rest[spec.identity] = opts.user;

  const url = new URL(path, opts.baseUrl);
  const headers: Record<string, string> = opts.token ? { authorization: `Bearer ${opts.token}` } : {};
  const init: RequestInit = { method: spec.method, headers };
  if (spec.method === "GET") {
    for (const [k, v] of Object.entries(rest)) {
      if (v === undefined || v === null) continue;
      for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(item));
    }
  } else {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(rest);
  }
  init.signal = AbortSignal.timeout(opts.timeoutMs ?? 10_000);

  const res = await (opts.fetch ?? fetch)(url, init);
  const text = await res.text();
  if (!res.ok) {
    let message = `memory-api ${spec.method} ${path} → HTTP ${res.status}`;
    try {
      const err = (JSON.parse(text) as { error?: unknown }).error;
      if (typeof err === "string") message = err;
    } catch { /* not JSON */ }
    throw new MemoryApiError(message, res.status, text);
  }
  return JSON.parse(text) as MemoryResult<O>;
}

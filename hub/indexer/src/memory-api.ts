import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type {
  searchMemories,
  getMemory,
  timelineMemories,
  writeUserMemory,
  forgetMemory,
  getContext,
  updateMemory,
  restoreMemory,
  listMemories,
  getAuditTrail,
  getMetrics,
  listDirs,
  getDir,
  memoryTree,
} from "./memory-repo.js";
import type { writeDistillation } from "./distiller-repo.js";
import { PROMPT_VERSION } from "./distiller-prompts.js";
import { InvalidDirError } from "./memory-dirs.js";
import type { WritePolicy } from "./memory-merge.js";
import { encodeProjectDir } from "./path-decode.js";

// DI seam: production wires real repo functions; tests pass vi.fn stubs. Pool
// and embedderClient travel as a bag so the same `repo.searchMemories` shape
// works whether the underlying impl needs them or not.
export interface MemoryApiDeps {
  pool:           Pool;
  embedderClient: { embedTexts: (texts: string[]) => Promise<number[][]> };
  // Cosine similarity at which a write merges into an existing entry of the
  // same directory, and the live-entry cap per directory instance.
  mergeSimilarity: number;
  dirCap:          number;
  repo: {
    searchMemories:   typeof searchMemories;
    getMemory:        typeof getMemory;
    timelineMemories: typeof timelineMemories;
    writeUserMemory:  typeof writeUserMemory;
    forgetMemory:     typeof forgetMemory;
    getContext:       typeof getContext;
    updateMemory:     typeof updateMemory;
    restoreMemory:    typeof restoreMemory;
    listMemories:     typeof listMemories;
    getAuditTrail:    typeof getAuditTrail;
    getMetrics:       typeof getMetrics;
    writeDistillation: typeof writeDistillation;
    listDirs:         typeof listDirs;
    getDir:           typeof getDir;
    memoryTree:       typeof memoryTree;
  };
}

// Bodies longer than this are rejected at write: memories are meant to be
// short, recallable facts; long material belongs in files the memory points to.
export const MEMORY_BODY_MAX_CHARS = 4000;
const MemoryBodyField = z.string().max(MEMORY_BODY_MAX_CHARS, {
  message: `body exceeds ${MEMORY_BODY_MAX_CHARS} characters; split it into smaller memories or point to a file`,
});

// project_dir is tri-state: missing/undefined and explicit `null` both mean
// "no project filter". The repo layer normalises null → undefined / vice versa
// per its own conventions; we just pass the JSON shape through.
const SearchBody = z.object({
  username:    z.string().min(1),
  project_dir: z.string().nullable().optional(),
  query:       z.string().min(1),
  limit:       z.number().int().positive().max(100).optional(),
  types:       z.array(z.string()).optional(),
  since:       z.string().datetime().optional(),
});

const TimelineQuery = z.object({
  username:    z.string().min(1),
  // Querystring → only `string | undefined` is reachable; nullability lives
  // at the JSON body layer (search/write).
  project_dir: z.string().optional(),
  since:       z.string().datetime().optional(),
  until:       z.string().datetime().optional(),
  // Querystrings arrive as strings; zod's `coerce.number` does the int parse.
  limit:       z.coerce.number().int().positive().max(500).optional(),
});

const WriteBody = z.object({
  username:    z.string().min(1),
  scope:       z.enum(["user", "project", "org"]),
  project_dir: z.string().nullable().optional(),
  type:        z.enum(["user", "feedback", "project", "reference"]),
  name:        z.string().min(1),
  description: z.string(),
  body:        MemoryBodyField,
  facets:      z.record(z.string(), z.array(z.string())).optional(),
  // Target directory, e.g. "user/preferences"; defaults by (scope, type).
  dir_key:     z.string().min(1).optional(),
});

const ForgetBody = z.object({
  username:  z.string().min(1),
  memory_id: z.string().min(1),
});

const ContextQuery = z.object({
  username:      z.string().min(1),
  project_path:  z.string().min(1),
  budget_tokens: z.coerce.number().int().positive().max(100000).optional(),
});

const UpdateBody = z.object({
  actor:       z.string().min(1),
  name:        z.string().min(1),
  description: z.string(),
  body:        MemoryBodyField.min(1),
});

const RestoreBody = z.object({ actor: z.string().min(1) });

// Querystring schema for GET /memory/list. Uses coerce.boolean/coerce.number
// for the same reason TimelineQuery does: querystrings arrive as strings.
// `type` arrives as repeated ?type=foo&type=bar → zod array of strings.
const ListQuery = z.object({
  username:        z.string().min(1),
  project_dir:     z.string().optional(),
  scope:           z.enum(['org', 'user', 'project']).optional(),
  type:            z.union([z.string(), z.array(z.string())]).transform((v) =>
    typeof v === 'string' ? [v] : v
  ).optional(),
  source:          z.enum(['user', 'distilled']).optional(),
  // Querystring booleans need explicit literal parsing — `z.coerce.boolean`
  // calls JS `Boolean(x)` which returns `true` for any non-empty string,
  // so `?include_deleted=false` would incorrectly include deleted rows.
  include_deleted: z.union([z.literal('true'), z.literal('false')]).optional()
                    .transform(v => v === 'true'),
  sort:            z.enum(['created', 'hit']).optional(),
  limit:           z.coerce.number().int().positive().max(200).optional(),
  cursor:          z.string().datetime().optional(),
});

// Directory reads take the project as an encoded project_dir or, like
// /memory/context, as a raw project_path encoded here.
const DirsQuery = z.object({
  username:     z.string().min(1),
  project_dir:  z.string().optional(),
  project_path: z.string().optional(),
});
const projectDirOf = (q: z.infer<typeof DirsQuery>): string | null =>
  q.project_path ? encodeProjectDir(q.project_path) : (q.project_dir ?? null);

const DirQuery = DirsQuery.extend({
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const TreeQuery = DirsQuery.extend({
  include_deleted: z.union([z.literal('true'), z.literal('false')]).optional()
                    .transform(v => v === 'true'),
  limit:           z.coerce.number().int().positive().max(200).optional(),
});

const AuditQuery = z.object({
  actor: z.string().min(1),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

// /memory/distill payload mirrors distiller-prompts.ts `DistillationResult` so
// agent-side and (formerly) server-side distill paths share dedup semantics
// via the same content_hash construction in distiller-repo.ts.
const DistillSummary = z.object({
  name:        z.string().min(1).max(80),
  description: z.string().max(200),
  body:        z.string().max(1500),
});

const DistillObservation = z.object({
  type: z.enum(["decision", "finding", "file-touched", "command-result", "user-preference"]),
  name:        z.string().min(1).max(80),
  description: z.string().max(200),
  body:        z.string().max(800),
  facets: z.object({
    gene:     z.array(z.string()).optional(),
    dataset:  z.array(z.string()).optional(),
    tool:     z.array(z.string()).optional(),
    pipeline: z.array(z.string()).optional(),
    file:     z.array(z.string()).optional(),
  }).strict(),
});

const DistillBody = z.object({
  username:          z.string().min(1),
  project_dir:       z.string().nullable().optional(),
  source_session_id: z.string().nullable().optional(),
  summary:           DistillSummary,
  observations:      z.array(DistillObservation).max(8),
});

export function buildApp(deps: MemoryApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  const policy: WritePolicy = {
    embedderClient:  deps.embedderClient,
    mergeSimilarity: deps.mergeSimilarity,
    dirCap:          deps.dirCap,
  };

  app.get("/healthz", async () => ({ ok: true }));

  // GET /memory/dirs — the directories visible to the caller (org and user
  // always, project ones with a project) with L0, live entry count, over_cap.
  app.get("/memory/dirs", async (req, reply) => {
    const parsed = DirsQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    return await deps.repo.listDirs({
      pool:        deps.pool,
      username:    parsed.data.username,
      project_dir: projectDirOf(parsed.data),
      cap:         deps.dirCap,
    });
  });

  // GET /memory/dirs/<dir_key> — one directory's L0 plus its top entries
  // (L1). dir_key contains "/" ("project/decisions"); the wildcard takes it
  // raw or URL-encoded.
  app.get<{ Params: { "*": string } }>("/memory/dirs/*", async (req, reply) => {
    const parsed = DirQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const dir = await deps.repo.getDir({
      pool:        deps.pool,
      username:    parsed.data.username,
      project_dir: projectDirOf(parsed.data),
      dir_key:     decodeURIComponent(req.params["*"]),
      limit:       parsed.data.limit,
      cap:         deps.dirCap,
    });
    if (dir === null) {
      reply.code(404);
      return { error: "directory not found" };
    }
    return dir;
  });

  // GET /memory/tree — every directory instance with L0, counts, over_cap and
  // its memories' metadata (MemoryTree in memory-repo.ts).
  app.get("/memory/tree", async (req, reply) => {
    const parsed = TreeQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    return await deps.repo.memoryTree({
      pool:            deps.pool,
      username:        parsed.data.username,
      project_dir:     projectDirOf(parsed.data),
      include_deleted: parsed.data.include_deleted,
      limit:           parsed.data.limit,
      cap:             deps.dirCap,
    });
  });

  // GET /memory/metrics — debug surface returning metrics across memory,
  // embedder_queue, and audit_log. No params, no auth (private docker network).
  app.get("/memory/metrics", async () => deps.repo.getMetrics(deps.pool));

  // POST /memory/search — hybrid retrieval (vector + FTS). Body validated by
  // SearchBody; ISO `since` is converted to Date at the boundary.
  app.post("/memory/search", async (req, reply) => {
    const parsed = SearchBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const b = parsed.data;
    const hits = await deps.repo.searchMemories({
      pool:           deps.pool,
      embedderClient: deps.embedderClient,
      username:       b.username,
      project_dir:    b.project_dir ?? null,
      query:          b.query,
      limit:          b.limit,
      types:          b.types,
      since:          b.since ? new Date(b.since) : undefined,
    });
    return hits;
  });

  // GET /memory/timeline — registered BEFORE GET /memory/:id so fastify's
  // router matches the literal "timeline" segment first; otherwise the
  // dynamic `:id` route would swallow it.
  app.get("/memory/timeline", async (req, reply) => {
    const parsed = TimelineQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const q = parsed.data;
    const entries = await deps.repo.timelineMemories({
      pool:        deps.pool,
      username:    q.username,
      project_dir: q.project_dir,
      since:       q.since ? new Date(q.since) : undefined,
      until:       q.until ? new Date(q.until) : undefined,
      limit:       q.limit,
    });
    return entries;
  });

  // GET /memory/context — SessionStart bundle. Default budget_tokens=2000
  // applied here per spec §7.2; the underlying getContext trusts whatever
  // number arrives.
  app.get("/memory/context", async (req, reply) => {
    const parsed = ContextQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const q = parsed.data;
    const ctx = await deps.repo.getContext({
      pool:          deps.pool,
      username:      q.username,
      project_path:  q.project_path,
      budget_tokens: q.budget_tokens ?? 2000,
    });
    return ctx;
  });

  // GET /memory/list — paginated listing with optional filters. Registered
  // BEFORE GET /memory/:id so fastify's router matches the literal "list"
  // segment before the dynamic :id wildcard.
  app.get("/memory/list", async (req, reply) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const q = parsed.data;
    return await deps.repo.listMemories({
      pool:            deps.pool,
      username:        q.username,
      project_dir:     q.project_dir ?? null,
      scope:           q.scope,
      type:            q.type,
      source:          q.source,
      include_deleted: q.include_deleted,
      sort:            q.sort,
      limit:           q.limit,
      cursor:          q.cursor,
    });
  });

  // POST /memory/write — /memorize-style user-authored memory. Returns
  // {memory_id: null} on dedup collision.
  app.post("/memory/write", async (req, reply) => {
    const parsed = WriteBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const b = parsed.data;
    try {
      return await deps.repo.writeUserMemory({
        pool:        deps.pool,
        username:    b.username,
        scope:       b.scope,
        project_dir: b.project_dir ?? null,
        type:        b.type,
        name:        b.name,
        description: b.description,
        body:        b.body,
        facets:      b.facets,
        dir_key:     b.dir_key,
        policy,
      });
    } catch (e) {
      if (e instanceof InvalidDirError) { reply.code(400); return { error: e.message }; }
      throw e;
    }
  });

  // POST /memory/distill — agent-driven on-demand distill. Caller (the
  // bioflow-memory MCP server) supplies a {summary, observations} payload
  // produced by the in-session agent itself; we just write rows. Auto-distill
  // (the polled cron-style loop) is disabled; this is the only path now.
  app.post("/memory/distill", async (req, reply) => {
    const parsed = DistillBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const b = parsed.data;
    const { written, merged } = await deps.repo.writeDistillation(deps.pool, {
      sessionMeta: {
        username:          b.username,
        project_dir:       b.project_dir ?? null,
        source_session_id: b.source_session_id ?? null,
      },
      result: { summary: b.summary, observations: b.observations },
      promptVersion: PROMPT_VERSION,
      policy,
    });
    // attempted = 1 summary + N observations; the rest of attempted was
    // dropped as duplicates of existing rows.
    return { ok: true, attempted: 1 + b.observations.length, written, merged };
  });

  // POST /memory/forget — soft-delete with username scoping; idempotent
  // (returns {ok:false} for already-deleted or wrong-owner ids).
  app.post("/memory/forget", async (req, reply) => {
    const parsed = ForgetBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const b = parsed.data;
    return await deps.repo.forgetMemory({
      pool:     deps.pool,
      username: b.username,
      memoryId: b.memory_id,
    });
  });

  // PUT /memory/:id — edit a user-authored memory's name/description/body.
  // Rejects distilled rows (403) and non-owner edits (403). Registered BEFORE
  // GET /memory/:id to match fastify's route-registration convention in this file.
  app.put<{ Params: { id: string } }>("/memory/:id", async (req, reply) => {
    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation failed', issues: parsed.error.issues };
    }
    const r = await deps.repo.updateMemory({
      pool:        deps.pool,
      actor:       parsed.data.actor,
      memoryId:    req.params.id,
      name:        parsed.data.name,
      description: parsed.data.description,
      body:        parsed.data.body,
    });
    if (!r.ok && r.reason === 'not_found') { reply.code(404); return { error: 'memory not found' }; }
    if (!r.ok && r.reason === 'forbidden')  { reply.code(403); return { error: 'not the owner' }; }
    if (!r.ok && r.reason === 'distilled')  { reply.code(403); return { error: 'distilled memories are read-only' }; }
    return { ok: true };
  });

  // POST /memory/:id/restore — undelete a soft-deleted memory. Owner-only.
  // 409 Conflict when the row is already live (not_deleted is a state mismatch,
  // not a validation problem). Registered before GET /memory/:id.
  app.post<{ Params: { id: string } }>("/memory/:id/restore", async (req, reply) => {
    const parsed = RestoreBody.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'validation failed', issues: parsed.error.issues }; }
    const r = await deps.repo.restoreMemory({ pool: deps.pool, actor: parsed.data.actor, memoryId: req.params.id });
    if (!r.ok && r.reason === 'not_found')   { reply.code(404); return { error: 'memory not found' }; }
    if (!r.ok && r.reason === 'forbidden')   { reply.code(403); return { error: 'not the owner' }; }
    if (!r.ok && r.reason === 'not_deleted') { reply.code(409); return { error: 'memory is not deleted' }; }
    return { ok: true };
  });

  // GET /memory/:id/audit — fetch audit trail for a memory. Owner-only.
  // Registered before GET /memory/:id so literal "/audit" segment takes precedence.
  app.get<{ Params: { id: string } }>("/memory/:id/audit", async (req, reply) => {
    const parsed = AuditQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation failed', issues: parsed.error.issues };
    }
    const q = parsed.data;
    const result = await deps.repo.getAuditTrail({
      pool:     deps.pool,
      actor:    q.actor,
      memoryId: req.params.id,
      limit:    q.limit,
    });
    if ('error' in result) {
      if (result.error === 'not_found') { reply.code(404); return { error: 'memory not found' }; }
      if (result.error === 'forbidden') { reply.code(403); return { error: 'not the owner' }; }
    }
    return result;
  });

  // GET /memory/:id — must be registered AFTER literal /memory/* routes
  // so fastify's radix tree prefers static segments over the wildcard.
  app.get<{ Params: { id: string } }>("/memory/:id", async (req, reply) => {
    const detail = await deps.repo.getMemory(deps.pool, req.params.id);
    if (detail === null) {
      reply.code(404);
      return { error: "memory not found" };
    }
    return detail;
  });

  return app;
}

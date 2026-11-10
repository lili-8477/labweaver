import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
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
  recordFeedback,
  recordUse,
  usedSince,
} from "./memory-repo.js";
import { InvalidDirError } from "./memory-dirs.js";
import { encodeProjectDir } from "./path-decode.js";
import type { proposeExperiences } from "./experience-promotion.js";
import type { writeDistillation } from "./distiller-repo.js";
import type { linkMemories } from "./lineage-repo.js";
import type { buildBundle } from "./context-bundle.js";
import type { consolidate } from "./consolidate.js";
import type { importedFiles, importEntries } from "./memory-import.js";
import type { createBuildJob, listBuildJobs, updateBuildJob } from "./memory-build-jobs.js";
import type { memoryGraph } from "./memory-graph.js";
import { PROMPT_VERSION } from "./distiller-prompts.js";
import type { AccessClass } from "./access-classes.js";
import { DEFAULT_CLEARANCE } from "./memory-access.js";
import { apiSchema, type MemoryResults } from "./memory-contract.js";
import type { EmbedderClient } from "./embedder-client.js";

// DI seam: production wires real repo functions; tests pass vi.fn stubs. Pool
// and embedderClient travel as a bag so the same `repo.searchMemories` shape
// works whether the underlying impl needs them or not.
export interface MemoryApiDeps {
  pool:           Pool;
  embedderClient: EmbedderClient;
  // Cosine similarity at which a write is held back as a near-duplicate.
  mergeSimilarity: number;
  // Org managers (MEMORY_ORG_MANAGER); auto-promotion requests go to them.
  managers:        string[];
  // Per-user read clearance (MEMORY_CLEARANCE); default 'internal'.
  clearance?:      Record<string, AccessClass>;
  // Host root of every user's workspace (<root>/<username>/...): the graph
  // reads skills and project folders from it.
  workspacesRoot:  string;
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
    listDirs:         typeof listDirs;
    getDir:           typeof getDir;
    memoryTree:       typeof memoryTree;
    recordFeedback:   typeof recordFeedback;
    recordUse:        typeof recordUse;
    usedSince:        typeof usedSince;
    proposeExperiences: typeof proposeExperiences;
    writeDistillation: typeof writeDistillation;
    linkMemories:     typeof linkMemories;
    buildBundle:      typeof buildBundle;
    consolidate:      typeof consolidate;
    importEntries:    typeof importEntries;
    importedFiles:    typeof importedFiles;
    createBuildJob:   typeof createBuildJob;
    updateBuildJob:   typeof updateBuildJob;
    listBuildJobs:    typeof listBuildJobs;
    memoryGraph:      typeof memoryGraph;
  };
}

// Request schemas come from the memory contract: the caller's input plus the
// identity field (apiSchema). Results of the UI's operations pass through
// `result`, which holds each route to the contract's result type.
const result = <O extends keyof MemoryResults>(_op: O, value: MemoryResults[O]): MemoryResults[O] => value;

export function buildApp(deps: MemoryApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const mergeCheck = { embedderClient: deps.embedderClient, similarity: deps.mergeSimilarity };
  const clearanceOf = (username: string): AccessClass => deps.clearance?.[username] ?? DEFAULT_CLEARANCE;

  // A write/update naming a directory outside the memory's scope is a client
  // error, not a 500.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof InvalidDirError) {
      reply.code(400).send({ error: err.message });
      return;
    }
    reply.send(err);
  });

  app.get("/healthz", async () => ({ ok: true }));

  // GET /memory/metrics — debug surface returning metrics across memory,
  // embedder_queue, and audit_log. No params, no auth (private docker network).
  app.get("/memory/metrics", async () => deps.repo.getMetrics(deps.pool));

  // POST /memory/search — hybrid retrieval (vector + FTS). Body validated by
  // SearchBody; ISO `since` is converted to Date at the boundary.
  app.post("/memory/search", async (req, reply) => {
    const parsed = apiSchema("memory_search").safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const b = parsed.data;
    const hits = await deps.repo.searchMemories({
      pool:           deps.pool,
      embedderClient: deps.embedderClient,
      username:       b.username,
      project_dir:    b.project_path ? encodeProjectDir(b.project_path) : (b.project_dir ?? null),
      query:          b.query,
      limit:          b.limit,
      types:          b.types,
      since:          b.since ? new Date(b.since) : undefined,
      dirs:           b.dirs,
      conditions:     b.conditions as Record<string, string[]> | undefined,
      strict:         b.strict,
      clearance:      clearanceOf(b.username),
      domain:         b.domain,
    });
    return result("memory_search", hits);
  });

  // GET /memory/timeline — registered BEFORE GET /memory/:id so fastify's
  // router matches the literal "timeline" segment first; otherwise the
  // dynamic `:id` route would swallow it.
  app.get("/memory/timeline", async (req, reply) => {
    const parsed = apiSchema("memory_timeline").safeParse(req.query);
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
      clearance:   clearanceOf(q.username),
    });
    return result("memory_timeline", entries);
  });

  // GET /memory/context — SessionStart directory index. Default
  // budget_tokens=800 (phase 3 gate); getContext trusts whatever arrives.
  app.get("/memory/context", async (req, reply) => {
    const parsed = apiSchema("memory_context").safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const q = parsed.data;
    const ctx = await deps.repo.getContext({
      pool:          deps.pool,
      username:      q.username,
      project_path:  q.project_path,
      budget_tokens: q.budget_tokens ?? 800,
      clearance:     clearanceOf(q.username),
    });
    return ctx;
  });

  // GET /memory/list — paginated listing with optional filters. Registered
  // BEFORE GET /memory/:id so fastify's router matches the literal "list"
  // segment before the dynamic :id wildcard.
  app.get("/memory/list", async (req, reply) => {
    const parsed = apiSchema("memory_list").safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const q = parsed.data;
    return result("memory_list", await deps.repo.listMemories({
      pool:            deps.pool,
      username:        q.username,
      project_dir:     q.project_dir ?? null,
      scope:           q.scope,
      type:            q.type,
      source:          q.source,
      dir:             q.dir,
      include_deleted: q.include_deleted,
      sort:            q.sort,
      limit:           q.limit,
      cursor:          q.cursor,
      clearance:       clearanceOf(q.username),
      domain:          q.domain,
    }));
  });

  // GET /memory/dirs — directories visible to the caller with their L0 and
  // entry counts. GET /memory/dirs/:dir_key — one directory's computed L1.
  // dir_key contains "/" so callers URL-encode it.
  app.get("/memory/dirs", async (req, reply) => {
    const parsed = apiSchema("memory_dirs").safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const q = parsed.data;
    return result("memory_dirs", await deps.repo.listDirs({
      pool:         deps.pool,
      username:     q.username,
      project_dir:  q.project_dir ?? null,
      all_projects: q.all_projects,
      clearance:    clearanceOf(q.username),
      domain:       q.domain,
    }));
  });

  app.get<{ Params: { dir_key: string } }>("/memory/dirs/:dir_key", async (req, reply) => {
    const parsed = apiSchema("memory_dir").safeParse({ ...(req.query as object), dir_key: req.params.dir_key });
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const q = parsed.data;
    const dir = await deps.repo.getDir({
      pool:        deps.pool,
      username:    q.username,
      project_dir: q.project_dir ?? null,
      dir_key:     req.params.dir_key,
      limit:       q.limit,
      clearance:   clearanceOf(q.username),
    });
    if (dir === null) {
      reply.code(404);
      return { error: "directory not found" };
    }
    return result("memory_dir", dir);
  });

  // GET /memory/tree — every directory with its entries' usage counters and
  // the facet topics ranked by skill readiness.
  app.get("/memory/tree", async (req, reply) => {
    const parsed = apiSchema("memory_tree").safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const q = parsed.data;
    return result("memory_tree", await deps.repo.memoryTree({
      pool: deps.pool, limit: q.limit, username: q.username, clearance: clearanceOf(q.username), domain: q.domain,
    }));
  });

  app.get("/memory/graph", async (req, reply) => {
    const parsed = apiSchema("memory_graph").safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const q = parsed.data;
    // username becomes a path segment here, so it must be a plain name.
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(q.username)) {
      reply.code(400);
      return { error: "validation failed", issues: [{ path: ["username"], message: "not a plain name" }] };
    }
    return result("memory_graph", await deps.repo.memoryGraph({
      pool: deps.pool, workspacesRoot: deps.workspacesRoot, username: q.username,
      include_deleted: q.include_deleted, clearance: clearanceOf(q.username), domain: q.domain,
    }));
  });

  // A task outcome for memories that informed it: counts towards their
  // ranking, and a success may carry personal experience over the promotion
  // threshold.
  const applyOutcome = async (username: string, memory_ids: string[], outcome: "success" | "failure") => {
    if (memory_ids.length === 0) return { updated: 0, proposed_for_org: [] as string[] };
    const { updated } = await deps.repo.recordFeedback({
      pool: deps.pool, username, memory_ids, outcome, clearance: clearanceOf(username),
    });
    const { proposed } = outcome === "success"
      ? await deps.repo.proposeExperiences({ pool: deps.pool, managers: deps.managers, memory_ids })
      : { proposed: [] as string[] };
    return { updated, proposed_for_org: proposed };
  };

  // POST /memory/feedback — outcome of a task that used these memories.
  app.post("/memory/feedback", async (req, reply) => {
    const parsed = apiSchema("memory_feedback").safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const b = parsed.data;
    return result("memory_feedback", await applyOutcome(b.username, b.memory_ids, b.outcome));
  });

  // POST /memory/outcome — a step outcome (an Auto-mode review verdict),
  // credited to the memories the agent used since the step began.
  app.post("/memory/outcome", async (req, reply) => {
    const parsed = apiSchema("memory_outcome").safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const b = parsed.data;
    const memory_ids = await deps.repo.usedSince({ pool: deps.pool, username: b.username, since: new Date(b.since) });
    return result("memory_outcome", { memory_ids, ...(await applyOutcome(b.username, memory_ids, b.outcome)) });
  });

  // POST /memory/write — /memorize-style user-authored memory. Returns
  // {memory_id: null} on dedup collision.
  app.post("/memory/write", async (req, reply) => {
    const parsed = apiSchema("memory_write").safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const b = parsed.data;
    return result("memory_write", await deps.repo.writeUserMemory({
      pool:        deps.pool,
      username:    b.username,
      scope:       b.scope,
      project_dir: b.project_dir ?? null,
      type:        b.type,
      name:        b.name,
      description: b.description,
      body:        b.body,
      domain:      b.domain,
      facets:      b.facets,
      dir:         b.dir,
      force_new:   b.force_new,
      merge:       mergeCheck,
    }));
  });

  // POST /memory/distill — agent-driven on-demand distill (the only distill
  // path; auto-distill is off). The in-session agent supplies a v2 payload:
  // one run claim, 0..5 claims, 0..3 experiences. The response reports what
  // reconcile did, and lists `related` claims for the agent to label with
  // memory_link and `similar` experiences to fold in with memory_merge.
  app.post("/memory/distill", async (req, reply) => {
    const parsed = apiSchema("memory_distill").safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const b = parsed.data;
    const outcome = await deps.repo.writeDistillation(deps.pool, {
      sessionMeta: {
        username:          b.username,
        project_dir:       b.project_dir ?? null,
        source_session_id: b.source_session_id ?? null,
      },
      result: { run: b.run, claims: b.claims, experiences: b.experiences },
      promptVersion: PROMPT_VERSION,
      merge:         mergeCheck,
    });
    return { ok: true, ...outcome };
  });

  // POST /memory/bundle — the context bundle for one task (MCP
  // memory_context, spec §6): filtered search plus conditions, evidence,
  // lineage, current versions and warnings, rendered as cited text. (GET
  // /memory/context stays the SessionStart directory index.)
  app.post("/memory/bundle", async (req, reply) => {
    const parsed = apiSchema("memory_bundle").safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const b = parsed.data;
    return await deps.repo.buildBundle({
      pool:           deps.pool,
      embedderClient: deps.embedderClient,
      username:       b.username,
      project_dir:    b.project_path ? encodeProjectDir(b.project_path) : (b.project_dir ?? null),
      query:          b.query,
      conditions:     b.conditions as Record<string, string[]> | undefined,
      strict:         b.strict,
      clearance:      clearanceOf(b.username),
      limit:          b.limit,
      budget_tokens:  b.budget_tokens,
    });
  });

  // POST /memory/consolidate — manager-only "System 2" pass (spec §7):
  // proposes SUPPORTS for replications, reports unlabeled same-condition
  // pairs and experiences built on superseded or retracted claims.
  app.post("/memory/consolidate", async (req, reply) => {
    const parsed = apiSchema("memory_consolidate").safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    if (!deps.managers.includes(parsed.data.actor)) {
      reply.code(403);
      return { error: "consolidation is manager-only" };
    }
    return await deps.repo.consolidate({
      pool: deps.pool, actor: parsed.data.actor, username: parsed.data.username,
      similarity: deps.mergeSimilarity,
    });
  });

  // POST /memory/link — write or reject a typed edge `src rel dst` (spec
  // §4.3). The agent labels `related` claims from /memory/distill with it;
  // RETRACTS / VALIDATED_BY / FAILED_TO_REPLICATE are for explicit user asks.
  app.post("/memory/link", async (req, reply) => {
    const parsed = apiSchema("memory_link").safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const r = await deps.repo.linkMemories({ pool: deps.pool, ...parsed.data });
    if (!r.ok && r.reason === "not_found") { reply.code(404); return { error: "memory not found" }; }
    if (!r.ok && r.reason === "forbidden") { reply.code(403); return { error: "src must be yours; dst must be yours (or org, for non-status edges)" }; }
    if (!r.ok && r.reason === "self")      { reply.code(400); return { error: "src and dst must differ" }; }
    return { ok: true };
  });

  // POST /memory/forget — soft-delete with username scoping; idempotent
  // (returns {ok:false} for already-deleted or wrong-owner ids).
  app.post("/memory/forget", async (req, reply) => {
    const parsed = apiSchema("memory_forget").safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const b = parsed.data;
    return result("memory_forget", await deps.repo.forgetMemory({
      pool:     deps.pool,
      username: b.username,
      memoryId: b.memory_id,
    }));
  });

  // PUT /memory/:id — edit a user-authored memory's name/description/body.
  // Rejects distilled rows (403) and non-owner edits (403). Registered BEFORE
  // GET /memory/:id to match fastify's route-registration convention in this file.
  // The memory builder (memory-import.ts): the member's adapter parses and
  // segments a source, then posts the entries here in batches, and reports
  // the job's progress through the build-jobs routes.
  app.post("/memory/import", async (req, reply) => {
    const parsed = apiSchema("memory_import").safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: "validation failed", issues: parsed.error.issues }; }
    return result("memory_import", await deps.repo.importEntries({ pool: deps.pool, ...parsed.data }));
  });

  app.post("/memory/import/seen", async (req, reply) => {
    const parsed = apiSchema("memory_import_seen").safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: "validation failed", issues: parsed.error.issues }; }
    const { username, project_dir, origin_sha256s } = parsed.data;
    return result("memory_import_seen", {
      seen: await deps.repo.importedFiles({ pool: deps.pool, username, project_dir, sha256s: origin_sha256s }),
    });
  });

  app.post("/memory/build-jobs", async (req, reply) => {
    const parsed = apiSchema("memory_build_job_create").safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: "validation failed", issues: parsed.error.issues }; }
    return result("memory_build_job_create", { job_id: await deps.repo.createBuildJob(deps.pool, parsed.data) });
  });

  app.put<{ Params: { job_id: string } }>("/memory/build-jobs/:job_id", async (req, reply) => {
    const parsed = apiSchema("memory_build_job_update").safeParse({ ...(req.body as object), job_id: req.params.job_id });
    if (!parsed.success) { reply.code(400); return { error: "validation failed", issues: parsed.error.issues }; }
    const ok = await deps.repo.updateBuildJob(deps.pool, parsed.data);
    if (!ok) { reply.code(404); return { error: "job not found" }; }
    return result("memory_build_job_update", { ok });
  });

  app.get("/memory/build-jobs", async (req, reply) => {
    const parsed = apiSchema("memory_build_jobs").safeParse(req.query);
    if (!parsed.success) { reply.code(400); return { error: "validation failed", issues: parsed.error.issues }; }
    return result("memory_build_jobs", await deps.repo.listBuildJobs(deps.pool, parsed.data));
  });

  app.put<{ Params: { id: string } }>("/memory/:id", async (req, reply) => {
    const parsed = apiSchema("memory_update").safeParse({ ...(req.body as object), memory_id: req.params.id });
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
      dir:         parsed.data.dir,
      domain:      parsed.data.domain,
      merge:       parsed.data.merge,
    });
    if (!r.ok && r.reason === 'not_found') { reply.code(404); return { error: 'memory not found' }; }
    if (!r.ok && r.reason === 'forbidden')  { reply.code(403); return { error: 'not the owner' }; }
    if (!r.ok && r.reason === 'distilled')  { reply.code(403); return { error: 'distilled memories are read-only' }; }
    if (!r.ok && r.reason === 'immutable')  { reply.code(409); return { error: 'claims are immutable; write a new claim and link it with SUPERSEDES or RETRACTS' }; }
    return result("memory_update", { ok: true });
  });

  // POST /memory/:id/restore — undelete a soft-deleted memory. Owner-only.
  // 409 Conflict when the row is already live (not_deleted is a state mismatch,
  // not a validation problem). Registered before GET /memory/:id.
  app.post<{ Params: { id: string } }>("/memory/:id/restore", async (req, reply) => {
    const parsed = apiSchema("memory_restore").safeParse({ ...(req.body as object), memory_id: req.params.id });
    if (!parsed.success) { reply.code(400); return { error: 'validation failed', issues: parsed.error.issues }; }
    const r = await deps.repo.restoreMemory({ pool: deps.pool, actor: parsed.data.actor, memoryId: req.params.id });
    if (!r.ok && r.reason === 'not_found')   { reply.code(404); return { error: 'memory not found' }; }
    if (!r.ok && r.reason === 'forbidden')   { reply.code(403); return { error: 'not the owner' }; }
    if (!r.ok && r.reason === 'not_deleted') { reply.code(409); return { error: 'memory is not deleted' }; }
    return result("memory_restore", { ok: true });
  });

  // GET /memory/:id/audit — fetch audit trail for a memory. Owner-only.
  // Registered before GET /memory/:id so literal "/audit" segment takes precedence.
  app.get<{ Params: { id: string } }>("/memory/:id/audit", async (req, reply) => {
    const parsed = apiSchema("memory_audit").safeParse({ ...(req.query as object), memory_id: req.params.id });
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation failed', issues: parsed.error.issues };
    }
    const q = parsed.data;
    const trail = await deps.repo.getAuditTrail({
      pool:     deps.pool,
      actor:    q.actor,
      memoryId: req.params.id,
      limit:    q.limit,
    });
    if ('error' in trail) {
      if (trail.error === 'not_found') { reply.code(404); return { error: 'memory not found' }; }
      reply.code(403);
      return { error: 'not the owner' };
    }
    return result("memory_audit", trail);
  });

  // GET /memory/:id — must be registered AFTER literal /memory/* routes
  // so fastify's radix tree prefers static segments over the wildcard.
  // A memory the caller can't see is reported as not found (memory-access.ts).
  app.get<{ Params: { id: string } }>("/memory/:id", async (req, reply) => {
    const parsed = apiSchema("memory_get").safeParse({ ...(req.query as object), memory_id: req.params.id });
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const q = parsed.data;
    const detail = await deps.repo.getMemory({
      pool: deps.pool, memoryId: q.memory_id, username: q.username, clearance: clearanceOf(q.username),
    });
    if (detail === null) {
      reply.code(404);
      return { error: "memory not found" };
    }
    if (q.use) await deps.repo.recordUse({ pool: deps.pool, username: q.username, memoryId: detail.memory_id });
    return result("memory_get", detail);
  });

  return app;
}

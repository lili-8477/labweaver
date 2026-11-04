import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Pool } from "pg";
import { buildApp, type MemoryApiDeps } from "../src/memory-api.js";
import { InvalidDirError } from "../src/memory-dirs.js";
import type { MemoryGraph } from "../src/memory-contract.js";
import type { Changed } from "../src/memory-access.js";
import type {
  SearchHit,
  MemoryDetail,
  TimelineEntry,
  MemoryContext,
  ListItem,
} from "../src/memory-repo.js";

const EMPTY_OUTCOME = {
  run_id: "r-1" as string | null, claim_ids: [] as Array<string | null>, experience_ids: [] as Array<string | null>,
  duplicates: [] as never[], superseded: [] as never[], qualified: [] as never[], related: [] as never[],
  similar: [] as Array<{ name: string; matches: never[] }>,
};

// Tiny test-double factory: every repo function is a vi.fn() with a sensible
// default return. Tests override on a per-case basis with mockResolvedValueOnce.
function makeDeps(): { deps: MemoryApiDeps; repo: {
  searchMemories:   ReturnType<typeof vi.fn>;
  getMemory:        ReturnType<typeof vi.fn>;
  timelineMemories: ReturnType<typeof vi.fn>;
  writeUserMemory:  ReturnType<typeof vi.fn>;
  forgetMemory:     ReturnType<typeof vi.fn>;
  getContext:       ReturnType<typeof vi.fn>;
  updateMemory:     ReturnType<typeof vi.fn>;
  restoreMemory:    ReturnType<typeof vi.fn>;
  listMemories:     ReturnType<typeof vi.fn>;
  getAuditTrail:    ReturnType<typeof vi.fn>;
  getMetrics:       ReturnType<typeof vi.fn>;
  listDirs:         ReturnType<typeof vi.fn>;
  getDir:           ReturnType<typeof vi.fn>;
  memoryTree:       ReturnType<typeof vi.fn>;
  recordFeedback:   ReturnType<typeof vi.fn>;
  recordUse:        ReturnType<typeof vi.fn>;
  usedSince:        ReturnType<typeof vi.fn>;
  proposeExperiences: ReturnType<typeof vi.fn>;
  writeDistillation: ReturnType<typeof vi.fn>;
  linkMemories:     ReturnType<typeof vi.fn>;
  buildBundle:      ReturnType<typeof vi.fn>;
  consolidate:      ReturnType<typeof vi.fn>;
  memoryGraph:      ReturnType<typeof vi.fn>;
} } {
  const repo = {
    searchMemories:   vi.fn(async (): Promise<SearchHit[]>     => []),
    getMemory:        vi.fn(async (): Promise<MemoryDetail | null> => null),
    timelineMemories: vi.fn(async (): Promise<TimelineEntry[]> => []),
    writeUserMemory:  vi.fn(async (): Promise<{ memory_id: string | null }> => ({ memory_id: "m-1" })),
    forgetMemory:     vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true })),
    getContext:       vi.fn(async (): Promise<MemoryContext>   => ({ system_prompt: "", memory_ids: [] })),
    updateMemory:     vi.fn(async (): Promise<Changed<'not_found' | 'forbidden' | 'distilled' | 'immutable'>> => ({ ok: true })),
    restoreMemory:    vi.fn(async (): Promise<Changed<'not_found' | 'forbidden' | 'not_deleted'>> => ({ ok: true })),
    listMemories:     vi.fn(async (): Promise<{ items: ListItem[]; next_cursor: string | null }> => ({ items: [], next_cursor: null })),
    getAuditTrail:    vi.fn(async (): Promise<{ rows: never[] } | { error: 'not_found' | 'forbidden' }> => ({ rows: [] })),
    getMetrics:       vi.fn(async (): Promise<{ memories_total: number; memories_by_type: Record<string, number>; memories_by_source: { user: number; distilled: number }; memories_soft_deleted: number; embedder_queue_depth: number; embedder_queue_oldest: string | null; distill_cursor_lag_seconds_max: number; audit_log_size: number }> => ({
      memories_total: 0,
      memories_by_type: {},
      memories_by_source: { user: 0, distilled: 0 },
      memories_soft_deleted: 0,
      embedder_queue_depth: 0,
      embedder_queue_oldest: null,
      distill_cursor_lag_seconds_max: 0,
      audit_log_size: 0,
    })),
    listDirs:         vi.fn(async () => []),
    getDir:           vi.fn(async () => null),
    memoryTree:       vi.fn(async () => ({ dirs: [], memories: [], topics: [], thresholds: { memories: 3, successes: 3 } })),
    recordFeedback:   vi.fn(async () => ({ updated: 0 })),
    recordUse:        vi.fn(async () => undefined),
    usedSince:        vi.fn(async () => [] as string[]),
    proposeExperiences: vi.fn(async () => ({ proposed: [] as string[] })),
    writeDistillation: vi.fn(async () => ({ ...EMPTY_OUTCOME })),
    linkMemories:     vi.fn(async (): Promise<{ ok: boolean; reason?: "not_found" | "forbidden" | "self" }> => ({ ok: true })),
    buildBundle:      vi.fn(async () => ({
      query: "q", filters: {}, current_versions: [], facts: [], experiences: [], warnings: [], text: "",
    })),
    consolidate:      vi.fn(async () => ({ proposed_supports: [], unlabeled_pairs: [], stale_experiences: [], similar_understandings: [] })),
    memoryGraph:      vi.fn(async (): Promise<MemoryGraph> => ({ nodes: [], edges: [], dropped: { memory: 0, skill: 0, resource: 0, topic: 0 } })),
  };
  const deps: MemoryApiDeps = {
    pool: {} as Pool,
    embedderClient: { embedTexts: vi.fn(async () => []) },
    mergeSimilarity: 0.9,
    managers:        ["pi"],
    workspacesRoot:  "/ws",
    repo,
  };
  return { deps, repo };
}

describe("memory-api", () => {
  let depsBag: ReturnType<typeof makeDeps>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    if (app) await app.close();
    depsBag = makeDeps();
    app = buildApp(depsBag.deps);
  });

  it("GET /healthz returns 200 + { ok: true }", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  // ────────────────────────────── /memory/search ──────────────────────────────

  describe("POST /memory/search", () => {
    it("happy path: forwards to searchMemories and returns hits", async () => {
      const hits: SearchHit[] = [
        {
          memory_id: "a", name: "n", description: "d", dir_key: "user/notes", snippet: "s", score: 0.9,
          scope_tier: "user", type: "user", source: "user",
          created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
          hit_count: 0, last_hit_at: null, deleted_at: null, exact: false,
        },
      ];
      depsBag.repo.searchMemories.mockResolvedValueOnce(hits);

      const res = await app.inject({
        method:  "POST",
        url:     "/memory/search",
        payload: {
          username:    "alice",
          project_dir: "-workspace-foo",
          query:       "vector query",
          limit:       5,
          types:       ["user", "project"],
          since:       "2026-01-01T00:00:00Z",
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(hits);
      expect(depsBag.repo.searchMemories).toHaveBeenCalledTimes(1);
      const arg = depsBag.repo.searchMemories.mock.calls[0]![0];
      expect(arg.username).toBe("alice");
      expect(arg.project_dir).toBe("-workspace-foo");
      expect(arg.query).toBe("vector query");
      expect(arg.limit).toBe(5);
      expect(arg.types).toEqual(["user", "project"]);
      expect(arg.since).toBeInstanceOf(Date);
      expect(arg.since.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(arg.pool).toBe(depsBag.deps.pool);
      expect(arg.embedderClient).toBe(depsBag.deps.embedderClient);
    });

    it("treats project_dir=null as no-filter and omits since when absent", async () => {
      depsBag.repo.searchMemories.mockResolvedValueOnce([]);
      const res = await app.inject({
        method:  "POST",
        url:     "/memory/search",
        payload: { username: "alice", project_dir: null, query: "q" },
      });
      expect(res.statusCode).toBe(200);
      const arg = depsBag.repo.searchMemories.mock.calls[0]![0];
      expect(arg.project_dir).toBeNull();
      expect(arg.since).toBeUndefined();
    });

    it("400 when username is missing", async () => {
      const res = await app.inject({
        method:  "POST",
        url:     "/memory/search",
        payload: { query: "q" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation failed", issues: expect.any(Array) });
      expect(depsBag.repo.searchMemories).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────── /memory/:id ────────────────────────────────

  describe("GET /memory/:id", () => {
    it("happy path: returns the detail when getMemory finds it", async () => {
      const detail: MemoryDetail = {
        memory_id:         "abc",
        username:          "alice",
        project_dir:       null,
        type:              "user",
        source:            "user",
        scope_tier:        "user",
        dir_key:           "user/notes",
        name:              "test",
        description:       "desc",
        body:              "body",
        source_session_id: null,
        facets:            {},
        hit_count:         0,
        last_hit_at:       null,
        created_at:        "2026-01-01T00:00:00.000Z",
        updated_at:        "2026-01-01T00:00:00.000Z",
        deleted_at:        null,
      };
      depsBag.repo.getMemory.mockResolvedValueOnce(detail);

      const res = await app.inject({ method: "GET", url: "/memory/abc?username=alice" });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.memory_id).toBe("abc");
      expect(json.username).toBe("alice");
      expect(depsBag.repo.getMemory).toHaveBeenCalledWith({
        pool: depsBag.deps.pool, memoryId: "abc", username: "alice", clearance: "internal",
      });
    });

    it("needs the caller: there is no anonymous lookup by id", async () => {
      const res = await app.inject({ method: "GET", url: "/memory/abc" });
      expect(res.statusCode).toBe(400);
      expect(depsBag.repo.getMemory).not.toHaveBeenCalled();
    });

    it("returns 404 when getMemory returns null", async () => {
      depsBag.repo.getMemory.mockResolvedValueOnce(null);
      const res = await app.inject({ method: "GET", url: "/memory/missing?username=alice" });
      expect(res.statusCode).toBe(404);
    });
  });

  // ───────────────────────────── /memory/timeline ─────────────────────────────

  describe("GET /memory/timeline", () => {
    it("happy path: forwards query params and converts since/until to Date", async () => {
      const entries: TimelineEntry[] = [
        { memory_id: "x", name: "n", type: "user", dir_key: "user/notes", created_at: "2026-01-01T00:00:00.000Z" },
      ];
      depsBag.repo.timelineMemories.mockResolvedValueOnce(entries);

      const res = await app.inject({
        method: "GET",
        url:
          "/memory/timeline?username=alice&project_dir=-workspace-foo" +
          "&since=2026-01-01T00:00:00Z&until=2026-02-01T00:00:00Z&limit=20",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(1);
      const arg = depsBag.repo.timelineMemories.mock.calls[0]![0];
      expect(arg.username).toBe("alice");
      expect(arg.project_dir).toBe("-workspace-foo");
      expect(arg.since).toBeInstanceOf(Date);
      expect(arg.since.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(arg.until).toBeInstanceOf(Date);
      expect(arg.until.toISOString()).toBe("2026-02-01T00:00:00.000Z");
      expect(arg.limit).toBe(20);
    });

    it("400 when username is missing", async () => {
      const res = await app.inject({ method: "GET", url: "/memory/timeline?limit=10" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation failed", issues: expect.any(Array) });
      expect(depsBag.repo.timelineMemories).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────── /memory/write ───────────────────────────────

  describe("POST /memory/write", () => {
    it("happy path: forwards args and returns the inserted id", async () => {
      depsBag.repo.writeUserMemory.mockResolvedValueOnce({ memory_id: "new-id" });
      const res = await app.inject({
        method:  "POST",
        url:     "/memory/write",
        payload: {
          username:    "alice",
          scope:       "user",
          project_dir: null,
          type:        "user",
          name:        "n",
          description: "d",
          body:        "b",
          domain:      "technical",
          facets:      { tag: ["x"] },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ memory_id: "new-id" });
      const arg = depsBag.repo.writeUserMemory.mock.calls[0]![0];
      expect(arg.scope).toBe("user");
      expect(arg.project_dir).toBeNull();
      expect(arg.facets).toEqual({ tag: ["x"] });
      expect(arg.domain).toBe("technical");
      expect(arg.pool).toBe(depsBag.deps.pool);
    });

    it("happy path: dedup returns memory_id=null", async () => {
      depsBag.repo.writeUserMemory.mockResolvedValueOnce({ memory_id: null });
      const res = await app.inject({
        method:  "POST",
        url:     "/memory/write",
        payload: {
          username:    "alice",
          scope:       "user",
          type:        "user",
          name:        "n",
          description: "d",
          body:        "b",
          domain:      "lab",
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ memory_id: null });
    });

    it("400 when scope is missing", async () => {
      const res = await app.inject({
        method:  "POST",
        url:     "/memory/write",
        payload: { username: "alice", type: "user", name: "n", description: "d", body: "b" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation failed", issues: expect.any(Array) });
      expect(depsBag.repo.writeUserMemory).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────── /memory/forget ──────────────────────────────

  describe("POST /memory/forget", () => {
    it("happy path: forwards memoryId + username and returns ok", async () => {
      depsBag.repo.forgetMemory.mockResolvedValueOnce({ ok: true });
      const res = await app.inject({
        method:  "POST",
        url:     "/memory/forget",
        payload: { username: "alice", memory_id: "abc" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      const arg = depsBag.repo.forgetMemory.mock.calls[0]![0];
      expect(arg.username).toBe("alice");
      expect(arg.memoryId).toBe("abc");
      expect(arg.pool).toBe(depsBag.deps.pool);
    });

    it("400 when memory_id is missing", async () => {
      const res = await app.inject({
        method:  "POST",
        url:     "/memory/forget",
        payload: { username: "alice" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation failed", issues: expect.any(Array) });
      expect(depsBag.repo.forgetMemory).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────── /memory/context ─────────────────────────────

  describe("GET /memory/context", () => {
    it("happy path: applies default budget_tokens=800 when omitted", async () => {
      const ctx: MemoryContext = { system_prompt: "hi", memory_ids: ["a"] };
      depsBag.repo.getContext.mockResolvedValueOnce(ctx);

      const res = await app.inject({
        method: "GET",
        url:    "/memory/context?username=alice&project_path=/workspace/foo",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(ctx);
      const arg = depsBag.repo.getContext.mock.calls[0]![0];
      expect(arg.username).toBe("alice");
      expect(arg.project_path).toBe("/workspace/foo");
      expect(arg.budget_tokens).toBe(800);
    });

    it("happy path: honours explicit budget_tokens", async () => {
      depsBag.repo.getContext.mockResolvedValueOnce({ system_prompt: "", memory_ids: [] });
      const res = await app.inject({
        method: "GET",
        url:    "/memory/context?username=alice&project_path=/workspace/foo&budget_tokens=500",
      });
      expect(res.statusCode).toBe(200);
      const arg = depsBag.repo.getContext.mock.calls[0]![0];
      expect(arg.budget_tokens).toBe(500);
    });

    it("400 when project_path is missing", async () => {
      const res = await app.inject({
        method: "GET",
        url:    "/memory/context?username=alice",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation failed", issues: expect.any(Array) });
      expect(depsBag.repo.getContext).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────── PUT /memory/:id ────────────────────────────────

  describe("PUT /memory/:id", () => {
    const validPayload = {
      actor:       "alice",
      name:        "updated name",
      description: "updated description",
      body:        "updated body text",
    };

    it("happy path: calls updateMemory and returns {ok:true}", async () => {
      depsBag.repo.updateMemory.mockResolvedValueOnce({ ok: true });
      const res = await app.inject({
        method:  "PUT",
        url:     "/memory/abc-123",
        payload: validPayload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(depsBag.repo.updateMemory).toHaveBeenCalledTimes(1);
      const arg = depsBag.repo.updateMemory.mock.calls[0]![0];
      expect(arg.actor).toBe("alice");
      expect(arg.memoryId).toBe("abc-123");
      expect(arg.name).toBe("updated name");
      expect(arg.description).toBe("updated description");
      expect(arg.body).toBe("updated body text");
      expect(arg.pool).toBe(depsBag.deps.pool);
    });

    it("404 when repo returns not_found", async () => {
      depsBag.repo.updateMemory.mockResolvedValueOnce({ ok: false, reason: "not_found" });
      const res = await app.inject({
        method:  "PUT",
        url:     "/memory/missing-id",
        payload: validPayload,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "memory not found" });
    });

    it("403 when repo returns forbidden", async () => {
      depsBag.repo.updateMemory.mockResolvedValueOnce({ ok: false, reason: "forbidden" });
      const res = await app.inject({
        method:  "PUT",
        url:     "/memory/other-users-id",
        payload: validPayload,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "not the owner" });
    });

    it("403 when repo returns distilled", async () => {
      depsBag.repo.updateMemory.mockResolvedValueOnce({ ok: false, reason: "distilled" });
      const res = await app.inject({
        method:  "PUT",
        url:     "/memory/distilled-id",
        payload: validPayload,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "distilled memories are read-only" });
    });

    it("400 when actor is missing", async () => {
      const res = await app.inject({
        method:  "PUT",
        url:     "/memory/abc-123",
        payload: { name: "n", description: "d", body: "b" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation failed", issues: expect.any(Array) });
      expect(depsBag.repo.updateMemory).not.toHaveBeenCalled();
    });

    it("400 when body is missing", async () => {
      const res = await app.inject({
        method:  "PUT",
        url:     "/memory/abc-123",
        payload: { actor: "alice", name: "n", description: "d" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation failed", issues: expect.any(Array) });
      expect(depsBag.repo.updateMemory).not.toHaveBeenCalled();
    });
  });

  // ───────────────────── POST /memory/:id/restore ─────────────────────────────

  describe("POST /memory/:id/restore", () => {
    const validPayload = { actor: "alice" };

    it("happy path: calls restoreMemory and returns {ok:true}", async () => {
      depsBag.repo.restoreMemory.mockResolvedValueOnce({ ok: true });
      const res = await app.inject({
        method:  "POST",
        url:     "/memory/abc-123/restore",
        payload: validPayload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(depsBag.repo.restoreMemory).toHaveBeenCalledTimes(1);
      const arg = depsBag.repo.restoreMemory.mock.calls[0]![0];
      expect(arg.actor).toBe("alice");
      expect(arg.memoryId).toBe("abc-123");
      expect(arg.pool).toBe(depsBag.deps.pool);
    });

    it("404 when repo returns not_found", async () => {
      depsBag.repo.restoreMemory.mockResolvedValueOnce({ ok: false, reason: "not_found" });
      const res = await app.inject({
        method:  "POST",
        url:     "/memory/missing-id/restore",
        payload: validPayload,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "memory not found" });
    });

    it("403 when repo returns forbidden", async () => {
      depsBag.repo.restoreMemory.mockResolvedValueOnce({ ok: false, reason: "forbidden" });
      const res = await app.inject({
        method:  "POST",
        url:     "/memory/other-users-id/restore",
        payload: validPayload,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "not the owner" });
    });

    it("409 when repo returns not_deleted (memory is still live)", async () => {
      depsBag.repo.restoreMemory.mockResolvedValueOnce({ ok: false, reason: "not_deleted" });
      const res = await app.inject({
        method:  "POST",
        url:     "/memory/live-id/restore",
        payload: validPayload,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "memory is not deleted" });
    });

    it("400 when actor is missing", async () => {
      const res = await app.inject({
        method:  "POST",
        url:     "/memory/abc-123/restore",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation failed", issues: expect.any(Array) });
      expect(depsBag.repo.restoreMemory).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────── GET /memory/list ───────────────────────────────

  describe("GET /memory/list", () => {
    const sampleItem: ListItem = {
      memory_id:   "abc",
      type:        "observation",
      source:      "user",
      scope_tier:  "user",
      dir_key:     "user/notes",
      name:        "test memory",
      description: "desc",
      created_at:  "2026-01-01T00:00:00.000Z",
      updated_at:  "2026-01-01T00:00:00.000Z",
      hit_count:   0,
      last_hit_at: null,
      deleted_at:  null,
    };

    it("happy path: forwards query params and returns items + next_cursor", async () => {
      depsBag.repo.listMemories.mockResolvedValueOnce({
        items:       [sampleItem],
        next_cursor: "2026-01-01T00:00:00.000Z",
      });

      const res = await app.inject({
        method: "GET",
        url:    "/memory/list?username=alice&project_dir=-w-foo&scope=user&source=user&limit=50&sort=created",
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.items).toHaveLength(1);
      expect(json.items[0].memory_id).toBe("abc");
      expect(json.next_cursor).toBe("2026-01-01T00:00:00.000Z");

      expect(depsBag.repo.listMemories).toHaveBeenCalledTimes(1);
      const arg = depsBag.repo.listMemories.mock.calls[0]![0];
      expect(arg.username).toBe("alice");
      expect(arg.project_dir).toBe("-w-foo");
      expect(arg.scope).toBe("user");
      expect(arg.source).toBe("user");
      expect(arg.limit).toBe(50);
      expect(arg.sort).toBe("created");
      expect(arg.pool).toBe(depsBag.deps.pool);
    });

    it("400 when cursor is not a valid ISO datetime", async () => {
      const res = await app.inject({
        method: "GET",
        url:    "/memory/list?username=alice&cursor=not-a-date",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation failed", issues: expect.any(Array) });
      expect(depsBag.repo.listMemories).not.toHaveBeenCalled();
    });

    it.each([
      ["true",   true],
      ["false",  false],
      [undefined, false],  // missing key → transform returns false, the spec default
    ] as const)(
      "include_deleted=%s parses to %s (z.coerce.boolean would coerce non-empty strings to true)",
      async (raw, expected) => {
        const url = raw === undefined
          ? "/memory/list?username=alice"
          : `/memory/list?username=alice&include_deleted=${raw}`;
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode).toBe(200);
        const arg = depsBag.repo.listMemories.mock.calls[0]![0];
        expect(arg.include_deleted).toBe(expected);
      },
    );

    it("400 when include_deleted is something other than 'true'/'false'", async () => {
      const res = await app.inject({
        method: "GET",
        url:    "/memory/list?username=alice&include_deleted=yes",
      });
      expect(res.statusCode).toBe(400);
      expect(depsBag.repo.listMemories).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────── GET /memory/:id/audit ───────────────────────────────

  describe("GET /memory/:id/audit", () => {
    it("happy path: returns audit rows when owner requests", async () => {
      depsBag.repo.getAuditTrail.mockResolvedValueOnce({
        rows: [
          { audit_id: 1, action: "write", actor: "alice", before: null, after: { name: "mem" }, created_at: "2026-01-01T00:00:00.000Z" },
        ],
      });

      const res = await app.inject({
        method: "GET",
        url:    "/memory/abc-123/audit?actor=alice&limit=50",
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.rows).toHaveLength(1);
      expect(json.rows[0].audit_id).toBe(1);
      expect(json.rows[0].action).toBe("write");

      expect(depsBag.repo.getAuditTrail).toHaveBeenCalledTimes(1);
      const arg = depsBag.repo.getAuditTrail.mock.calls[0]![0];
      expect(arg.actor).toBe("alice");
      expect(arg.memoryId).toBe("abc-123");
      expect(arg.limit).toBe(50);
      expect(arg.pool).toBe(depsBag.deps.pool);
    });

    it("404 when repo returns not_found", async () => {
      depsBag.repo.getAuditTrail.mockResolvedValueOnce({ error: "not_found" });
      const res = await app.inject({
        method: "GET",
        url:    "/memory/missing-id/audit?actor=alice",
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "memory not found" });
    });

    it("403 when repo returns forbidden", async () => {
      depsBag.repo.getAuditTrail.mockResolvedValueOnce({ error: "forbidden" });
      const res = await app.inject({
        method: "GET",
        url:    "/memory/other-users-id/audit?actor=alice",
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "not the owner" });
    });

    it("400 when actor is missing", async () => {
      const res = await app.inject({
        method: "GET",
        url:    "/memory/abc-123/audit",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation failed", issues: expect.any(Array) });
      expect(depsBag.repo.getAuditTrail).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────── /memory/distill ──────────────────────────

  describe("POST /memory/distill", () => {
    const validBody = {
      username:    "alice",
      project_dir: "-home-alice-proj",
      run: { subject: "PBMC3k QC", statement: "filtered to 2638 cells", conditions: { dataset: ["pbmc3k"] } },
      claims: [{ claim_kind: "result", subject: "clusters", statement: "9 clusters at res 0.8" }],
    };

    it("happy path: forwards the parsed v2 payload and returns the outcome", async () => {
      const res = await app.inject({ method: "POST", url: "/memory/distill", payload: validBody });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, ...EMPTY_OUTCOME });
      const arg = depsBag.repo.writeDistillation.mock.calls[0]![1];
      expect(arg.sessionMeta).toEqual({ username: "alice", project_dir: "-home-alice-proj", source_session_id: null });
      expect(arg.promptVersion).toBe(2);
      // zod defaults are applied before the repo sees the payload.
      expect(arg.result.run).toMatchObject({ subject: "PBMC3k QC", inputs: [], evidence: [] });
      expect(arg.result.claims[0]).toMatchObject({ claim_kind: "result", conditions: {} });
      expect(arg.result.experiences).toEqual([]);
    });

    it("source_session_id must be a UUID", async () => {
      const bad = await app.inject({ method: "POST", url: "/memory/distill", payload: { ...validBody, source_session_id: "abc" } });
      expect(bad.statusCode).toBe(400);
      const sid = "00000000-0000-4000-8000-000000000001";
      const ok = await app.inject({ method: "POST", url: "/memory/distill", payload: { ...validBody, source_session_id: sid } });
      expect(ok.statusCode).toBe(200);
      expect(depsBag.repo.writeDistillation.mock.calls[0]![1].sessionMeta.source_session_id).toBe(sid);
    });

    it("rejects a payload without a run claim", async () => {
      const res = await app.inject({ method: "POST", url: "/memory/distill", payload: { username: "alice", claims: [] } });
      expect(res.statusCode).toBe(400);
      expect(depsBag.repo.writeDistillation).not.toHaveBeenCalled();
    });

    it("rejects unknown condition keys and bad evidence URIs", async () => {
      for (const run of [
        { ...validBody.run, conditions: { favourite_colour: ["blue"] } },
        { ...validBody.run, evidence: [{ uri: "results/umap.png" }] },
      ]) {
        const res = await app.inject({ method: "POST", url: "/memory/distill", payload: { ...validBody, run } });
        expect(res.statusCode).toBe(400);
      }
    });

    it("rejects an experience below the value bar", async () => {
      const exp = { task: "t", solution: "s", domain: "lab", applicability: ["always"] };
      const res = await app.inject({
        method: "POST", url: "/memory/distill", payload: { ...validBody, experiences: [exp] },
      });
      expect(res.statusCode).toBe(400);
      const res2 = await app.inject({
        method: "POST", url: "/memory/distill",
        payload: { ...validBody, experiences: [{ ...exp, failure_modes: ["fails on 10x v2"], source: 5 }] },
      });
      expect(res2.statusCode).toBe(400); // source index out of range
    });

    it("rejects more than 5 claims or 3 experiences", async () => {
      const claims = Array.from({ length: 6 }, () => validBody.claims[0]);
      const res = await app.inject({ method: "POST", url: "/memory/distill", payload: { ...validBody, claims } });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("scientific routes", () => {
    const A = "00000000-0000-4000-8000-00000000000a";
    const B = "00000000-0000-4000-8000-00000000000b";

    it("POST /memory/search forwards conditions and the caller's clearance", async () => {
      app = buildApp({ ...depsBag.deps, clearance: { alice: "irb" } });
      await app.inject({
        method: "POST", url: "/memory/search",
        payload: { username: "alice", query: "q", conditions: { cell_line: ["A549"] }, strict: true },
      });
      expect(depsBag.repo.searchMemories).toHaveBeenCalledWith(expect.objectContaining({
        conditions: { cell_line: ["A549"] }, strict: true, clearance: "irb",
      }));
    });

    it("POST /memory/bundle encodes project_path and defaults clearance to internal", async () => {
      const res = await app.inject({
        method: "POST", url: "/memory/bundle",
        payload: { username: "bob", project_path: "/workspace/pbmc3k", query: "q" },
      });
      expect(res.statusCode).toBe(200);
      expect(depsBag.repo.buildBundle).toHaveBeenCalledWith(expect.objectContaining({
        username: "bob", project_dir: "-workspace-pbmc3k", clearance: "internal",
      }));
    });

    it("POST /memory/link maps repo reasons to status codes", async () => {
      const body = { actor: "alice", src_id: A, dst_id: B, rel: "SUPPORTS" };
      expect((await app.inject({ method: "POST", url: "/memory/link", payload: body })).statusCode).toBe(200);
      depsBag.repo.linkMemories.mockResolvedValueOnce({ ok: false, reason: "forbidden" });
      expect((await app.inject({ method: "POST", url: "/memory/link", payload: body })).statusCode).toBe(403);
      depsBag.repo.linkMemories.mockResolvedValueOnce({ ok: false, reason: "not_found" });
      expect((await app.inject({ method: "POST", url: "/memory/link", payload: body })).statusCode).toBe(404);
      const bad = await app.inject({ method: "POST", url: "/memory/link", payload: { ...body, rel: "LIKES" } });
      expect(bad.statusCode).toBe(400);
    });

    it("POST /memory/consolidate is manager-only", async () => {
      const no = await app.inject({ method: "POST", url: "/memory/consolidate", payload: { actor: "alice" } });
      expect(no.statusCode).toBe(403);
      const yes = await app.inject({ method: "POST", url: "/memory/consolidate", payload: { actor: "pi" } });
      expect(yes.statusCode).toBe(200);
      expect(depsBag.repo.consolidate).toHaveBeenCalledWith(expect.objectContaining({ actor: "pi", similarity: 0.9 }));
    });

    it("PUT /memory/:id returns 409 for an immutable claim", async () => {
      depsBag.repo.updateMemory.mockResolvedValueOnce({ ok: false, reason: "immutable" });
      const res = await app.inject({
        method: "PUT", url: "/memory/m-1",
        payload: { actor: "alice", name: "n", description: "d", body: "b", merge: true },
      });
      expect(res.statusCode).toBe(409);
    });
  });

  // ────────────────────────────── /memory/metrics ──────────────────────────

  // ────────────────────────────── tiered recall ───────────────────────────────
  describe("tiered recall", () => {
    it("POST /memory/feedback validates and forwards", async () => {
      const id = "00000000-0000-4000-8000-000000000001";
      const ok = await app.inject({
        method: "POST", url: "/memory/feedback",
        payload: { username: "alice", memory_ids: [id], outcome: "success" },
      });
      expect(ok.statusCode).toBe(200);
      expect(depsBag.repo.recordFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ username: "alice", memory_ids: [id], outcome: "success" }),
      );
      expect(depsBag.repo.proposeExperiences).toHaveBeenCalledWith(
        expect.objectContaining({ managers: ["pi"], memory_ids: [id] }),
      );
      const bad = await app.inject({
        method: "POST", url: "/memory/feedback",
        payload: { username: "alice", memory_ids: [id], outcome: "meh" },
      });
      expect(bad.statusCode).toBe(400);
    });

    it("POST /memory/feedback does not propose on failure", async () => {
      await app.inject({
        method: "POST", url: "/memory/feedback",
        payload: { username: "alice", memory_ids: ["00000000-0000-4000-8000-000000000001"], outcome: "failure" },
      });
      expect(depsBag.repo.proposeExperiences).not.toHaveBeenCalled();
    });

    it("POST /memory/search encodes project_path server-side", async () => {
      await app.inject({
        method: "POST", url: "/memory/search",
        payload: { username: "alice", project_path: "/workspace/pbmc3k", query: "q" },
      });
      expect(depsBag.repo.searchMemories).toHaveBeenCalledWith(
        expect.objectContaining({ project_dir: "-workspace-pbmc3k" }),
      );
    });
  });

  // ────────────────────────────── merge-on-write ──────────────────────────────
  describe("merge-on-write", () => {
    it("POST /memory/write passes force_new and the merge check", async () => {
      await app.inject({
        method: "POST", url: "/memory/write",
        payload: { username: "alice", scope: "user", type: "user", name: "n", description: "d", body: "b", domain: "lab", force_new: true },
      });
      expect(depsBag.repo.writeUserMemory).toHaveBeenCalledWith(expect.objectContaining({
        force_new: true,
        merge: expect.objectContaining({ similarity: 0.9 }),
      }));
    });

    it("POST /memory/distill returns held-back experiences", async () => {
      depsBag.repo.writeDistillation.mockResolvedValueOnce({ ...EMPTY_OUTCOME, similar: [{ name: "qc", matches: [] }] });
      const res = await app.inject({
        method: "POST", url: "/memory/distill",
        payload: { username: "alice", run: { subject: "s", statement: "b" } },
      });
      expect(res.json()).toMatchObject({ ok: true, similar: [{ name: "qc", matches: [] }] });
    });

    it("PUT /memory/:id forwards merge", async () => {
      await app.inject({
        method: "PUT", url: "/memory/m-1",
        payload: { actor: "alice", name: "n", description: "d", body: "b", merge: true },
      });
      expect(depsBag.repo.updateMemory).toHaveBeenCalledWith(expect.objectContaining({ merge: true }));
    });
  });

  // ────────────────────────────── directories ─────────────────────────────────
  describe("memory directories", () => {
    it("GET /memory/dirs passes owner through", async () => {
      depsBag.repo.listDirs.mockResolvedValueOnce([{ dir_key: "user/notes" }]);
      const res = await app.inject({ method: "GET", url: "/memory/dirs?username=alice&project_dir=-w-p" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([{ dir_key: "user/notes" }]);
      expect(depsBag.repo.listDirs).toHaveBeenCalledWith(
        expect.objectContaining({ username: "alice", project_dir: "-w-p" }),
      );
    });

    it("GET /memory/dirs/:dir_key decodes the key and 404s when absent", async () => {
      const res = await app.inject({ method: "GET", url: "/memory/dirs/user%2Fnotes?username=alice&limit=5" });
      expect(res.statusCode).toBe(404);
      expect(depsBag.repo.getDir).toHaveBeenCalledWith(
        expect.objectContaining({ dir_key: "user/notes", project_dir: null, limit: 5 }),
      );
    });

    it("GET /memory/tree passes owner and limit through", async () => {
      const res = await app.inject({ method: "GET", url: "/memory/tree?username=alice&limit=10" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ topics: [], thresholds: { memories: 3 } });
      expect(depsBag.repo.memoryTree).toHaveBeenCalledWith(
        expect.objectContaining({ username: "alice", limit: 10 }),
      );
    });

    it("GET /memory/dirs requires username", async () => {
      const res = await app.inject({ method: "GET", url: "/memory/dirs" });
      expect(res.statusCode).toBe(400);
    });

    it("POST /memory/write forwards dir and maps InvalidDirError to 400", async () => {
      depsBag.repo.writeUserMemory.mockRejectedValueOnce(new InvalidDirError("project/decisions", "user"));
      const res = await app.inject({
        method: "POST", url: "/memory/write",
        payload: { username: "alice", scope: "user", type: "user", name: "n", description: "d", body: "b", domain: "lab", dir: "project/decisions" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/project\/decisions/);
      expect(depsBag.repo.writeUserMemory).toHaveBeenCalledWith(expect.objectContaining({ dir: "project/decisions" }));
    });
  });

  describe("GET /memory/metrics", () => {
    it("returns metrics from repo.getMetrics", async () => {
      const mockMetrics = {
        memories_total: 10,
        memories_by_type: { observation: 5, feedback: 3, insight: 2 },
        memories_by_source: { user: 7, distilled: 3 },
        memories_soft_deleted: 2,
        embedder_queue_depth: 5,
        embedder_queue_oldest: "2026-05-07T10:00:00Z",
        distill_cursor_lag_seconds_max: 120.5,
        audit_log_size: 25,
      };
      depsBag.repo.getMetrics = vi.fn(async () => mockMetrics);

      const res = await app.inject({ method: "GET", url: "/memory/metrics" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(mockMetrics);
      expect(depsBag.repo.getMetrics).toHaveBeenCalledTimes(1);
      expect(depsBag.repo.getMetrics).toHaveBeenCalledWith(depsBag.deps.pool);
    });
  });

  // ────────────────────────────── outcome loop ──────────────────────────────

  describe("outcome loop", () => {
    const detail = { memory_id: "m1", name: "n" };

    it("records a use only when the agent says it is using the memory", async () => {
      depsBag.repo.getMemory.mockResolvedValue(detail);
      await app.inject({ method: "GET", url: "/memory/m1?username=alice" });
      expect(depsBag.repo.recordUse).not.toHaveBeenCalled();
      await app.inject({ method: "GET", url: "/memory/m1?username=alice&use=true" });
      expect(depsBag.repo.recordUse).toHaveBeenCalledWith(expect.objectContaining({ username: "alice", memoryId: "m1" }));
    });

    it("credits a step outcome to the memories used since the step began", async () => {
      depsBag.repo.usedSince.mockResolvedValueOnce(["m1", "m2"]);
      depsBag.repo.recordFeedback.mockResolvedValueOnce({ updated: 2 });
      depsBag.repo.proposeExperiences.mockResolvedValueOnce({ proposed: ["m2"] });
      const since = "2026-10-20T10:00:00.000Z";
      const res = await app.inject({ method: "POST", url: "/memory/outcome", payload: { username: "alice", outcome: "success", since } });
      expect(res.json()).toEqual({ memory_ids: ["m1", "m2"], updated: 2, proposed_for_org: ["m2"] });
      expect(depsBag.repo.usedSince).toHaveBeenCalledWith(expect.objectContaining({ username: "alice", since: new Date(since) }));
      expect(depsBag.repo.recordFeedback).toHaveBeenCalledWith(expect.objectContaining({ memory_ids: ["m1", "m2"], outcome: "success" }));
    });

    it("does nothing when no memory was used", async () => {
      const res = await app.inject({ method: "POST", url: "/memory/outcome", payload: { username: "alice", outcome: "failure", since: "2026-10-20T10:00:00.000Z" } });
      expect(res.json()).toEqual({ memory_ids: [], updated: 0, proposed_for_org: [] });
      expect(depsBag.repo.recordFeedback).not.toHaveBeenCalled();
    });
  });
  describe("GET /memory/graph", () => {
    it("forwards username, include_deleted and the workspaces root", async () => {
      const res = await app.inject({ method: "GET", url: "/memory/graph?username=alice&include_deleted=true" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ nodes: [], edges: [], dropped: { memory: 0, skill: 0, resource: 0, topic: 0 } });
      expect(depsBag.repo.memoryGraph.mock.calls[0]![0]).toMatchObject({
        username: "alice", include_deleted: true, workspacesRoot: "/ws",
      });
    });

    it("400 for a username that is not a plain path segment", async () => {
      for (const u of ["", "..", "a%2Fb", ".hidden"]) {
        const res = await app.inject({ method: "GET", url: `/memory/graph?username=${u}` });
        expect(res.statusCode).toBe(400);
      }
      expect(depsBag.repo.memoryGraph).not.toHaveBeenCalled();
    });
  });
});

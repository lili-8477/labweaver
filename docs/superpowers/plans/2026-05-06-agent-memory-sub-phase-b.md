# Agent memory — sub-phase B (retrieval) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the memories that sub-phase A is silently writing actually visible to the agent. After this lands, opening a fresh chat in any user's container injects ~1–2k tokens of relevant context as a system message at SessionStart, the agent can call `memory_search` mid-turn, `/memorize` writes a user-authored memory, `/recall <q>` runs an explicit search, and `/forget <id>` soft-deletes.

**Architecture:** Adds a fastify HTTP server inside `hub/indexer/` (port 8400, docker network only) with six endpoints, a sibling `mcp-memory/` Node package globally installed in the per-user devcontainer image, and three skeleton additions (one SessionStart hook, three slash commands). `add-user.sh` wires `MEMORY_API_URL` and `.mcp.json` per user. Rollout is gated by `MEMORY_ENABLED=1` per container — flip for li86 first, verify, then roll the rest.

**Tech Stack:**
- TypeScript / Node 20, vitest + `@testcontainers/postgresql` (matches existing indexer)
- `fastify` for the HTTP layer (light, schema-driven, reuses existing pino logger)
- `@modelcontextprotocol/sdk` for the MCP server (sibling package)
- Bash skeleton hooks + plain markdown slash commands (matches existing harness conventions)

**Spec:** `docs/superpowers/specs/2026-05-05-agent-memory-design.md`, sections 7.2 / 7.4 / 7.5 / 7.6 / 9 / 12.

**Sub-phase A status (must be in main before starting B):** code-complete and deployed. As of 2026-05-06 — production has 60+ distilled rows across 4 users, embedder queue drained, sentinel fallback for unparseable LLM output is working. Latest distiller fix in commit `006b4bd`.

**Out of sub-phase B scope** (covered by future plans):
- Frontend memory browser (list/edit/forget UI) — sub-phase C
- Audit log on write/forget — sub-phase C
- Org-scope writes from inside user containers — admin path, separate
- Tightening the LLM-output schema to recover the 7 sentinel sessions — backlog

---

## File Structure

**Created:**
- `hub/indexer/src/memory-repo.ts` — typed PG queries: search, get, timeline, write, forget, context
- `hub/indexer/src/memory-api.ts` — fastify routes that call memory-repo
- `hub/indexer/test/memory-repo.test.ts` — testcontainers PG, all six query types
- `hub/indexer/test/memory-api.test.ts` — fastify `inject()` against a stub repo
- `hub/indexer/test/integration/search-mixed-scope.test.ts` — org + user + project rows in one query
- `mcp-memory/package.json`
- `mcp-memory/tsconfig.json`
- `mcp-memory/src/index.ts` — 4 MCP tools (memory_search, memory_get, memory_timeline, memory_write)
- `mcp-memory/test/index.test.ts` — tool wiring against a stub HTTP server
- `hub/skeleton/harness/hooks/memory_session_start.sh`
- `hub/skeleton/harness/commands/memorize.md`
- `hub/skeleton/harness/commands/recall.md`
- `hub/skeleton/harness/commands/forget.md`

**Modified:**
- `hub/indexer/package.json` — add `fastify`
- `hub/indexer/src/index.ts` — boot the fastify server alongside the watcher + distiller + embedder loops
- `hub/indexer/src/config.ts` — parse `MEMORY_API_PORT` (default `8400`)
- `hub/indexer/src/distiller-repo.ts` — extract `insertMemoryRow` helper so user-authored writes can reuse the chunk + facet + embedder-queue path (currently hardcoded `source='distilled'`)
- `hub/docker-compose.yml` — indexer publishes `8400` on the docker network only (no host bind)
- `hub/scripts/add-user.sh` — write `.mcp.json` referencing `mcp-memory`, copy hook + commands into the user's `.claude/`, set `MEMORY_API_URL` and `MEMORY_ENABLED` in the per-user env
- `image/Dockerfile` — `npm install -g ./mcp-memory` alongside the existing adapter copy
- `hub/skeleton/harness/hooks/` — register `memory_session_start.sh` in the SessionStart hook list

---

## Conventions

- Every test uses the existing testcontainers pattern (see `hub/indexer/test/migrations-smoke.test.ts:14-22`).
- Every TypeScript file uses ESM with `.js` import suffixes (matches existing code).
- Every commit message uses the existing style: `feat(indexer): …`, `feat(hub): …`, `test(indexer): …`. **No `Co-Authored-By` trailer** (operator preference — sub-phase A had repeated amendments to strip it).
- Run all indexer tests with `cd hub/indexer && npm test`.
- For each task: the failing test goes in **first**, then the implementation.
- Memory writes go through one shared helper in `distiller-repo.ts` so distilled and user-authored rows share the chunking + embedder-queue path. Don't fork.

---

## Task 1: fastify dep + memory-api skeleton boots in index.ts

**Goal:** Add the fastify server scaffold so subsequent tasks have somewhere to attach routes. One health endpoint, one test.

**Files:**
- Modify: `hub/indexer/package.json` (add `fastify`)
- Modify: `hub/indexer/src/config.ts` (add `memoryApiPort`, default 8400)
- Create: `hub/indexer/src/memory-api.ts` with `buildApp(deps)` returning a `FastifyInstance`; one route `GET /healthz` returning `{ ok: true }`
- Modify: `hub/indexer/src/index.ts` — `await app.listen({ port: cfg.memoryApiPort, host: '0.0.0.0' })`; bubble shutdown into `SIGTERM` handler
- Create: `hub/indexer/test/memory-api.test.ts` — `app.inject({ method: 'GET', url: '/healthz' })` returns 200 + `{ok: true}`

**Acceptance:** `npm test` passes; `curl http://claude-bioflow-indexer:8400/healthz` from another container returns 200 once deployed.

---

## Task 2: extract `insertMemoryRow` helper from `distiller-repo.ts`

**Goal:** Make the chunk + facet + embedder-queue insertion path reusable so user-authored writes (Task 7) don't reimplement it. Pure refactor — no behavior change.

**Files:**
- Modify: `hub/indexer/src/distiller-repo.ts` — extract `insertOne(...)` body into an exported `insertMemoryRow(client, { username, project_dir, source, type, source_session_id, name, description, body, facets, content_hash })`
- `writeDistillation` becomes a thin wrapper that calls it with `source='distilled'`
- Existing tests (`distiller-repo.test.ts`, `distiller.test.ts`, `distill-real-session.test.ts`) all stay green — that's the regression bar

**Acceptance:** All pre-existing indexer tests pass with no edits.

---

## Task 3: `memory-repo.search()` — hybrid SQL ranking

**Goal:** Implement the search query from spec §7.2 verbatim (CTE + scope-tier × popularity × recency multiplier). Increment `hit_count` + `last_hit_at` on returned IDs in the same call.

**Files:**
- Create: `hub/indexer/src/memory-repo.ts` with `searchMemories(pool, { username, project_dir, query, limit, types, since })` returning `{memory_id, name, description, snippet, score, scope_tier}[]`
- Create: `hub/indexer/test/memory-repo.test.ts` — testcontainers PG, fixtures with three memories under (`__org__`, NULL), (`alice`, NULL), (`alice`, `-w-p`); query returns all three and the project-scoped one ranks highest
- The query needs a query-vector input (the embedder gives 384-dim float arrays); use `embedder-client.ts` to embed the input query string
- If embedder is down, fall back to FTS-only (vector portion of CTE returns 0 similarity)

**Acceptance:** Test asserts ordering project > user > org with same FTS score; `hit_count` increments by 1 per returned row.

---

## Task 4: `memory-repo.get()` + `timeline()`

**Goal:** Two simpler queries. `getMemory` returns a row by id with facets joined. `timelineMemories` returns chronological IDs filtered by date range.

**Files:**
- Modify: `hub/indexer/src/memory-repo.ts` — add both
- Modify: `hub/indexer/test/memory-repo.test.ts` — happy-path + soft-deleted row is hidden + non-existent id returns `null`

**Acceptance:** All cases tested green.

---

## Task 5: `memory-repo.write()` — user-authored memories

**Goal:** Persist `/memorize`-style content. Calls `insertMemoryRow` (Task 2) with `source='user'`, `source_session_id=NULL`, scope-derived `(username, project_dir)`. Returns the new `memory_id`. Dedup behavior matches distilled rows (UNIQUE on `(username, project_dir, type, content_hash)`).

**Files:**
- Modify: `hub/indexer/src/memory-repo.ts` — add `writeUserMemory({ username, scope, project_dir?, type, name, description, body, facets? })`
- Modify: `hub/indexer/test/memory-repo.test.ts` — three cases: scope=`user` writes `(username, NULL)`; scope=`project` writes `(username, project_dir)`; scope=`org` rejects with an Error (org writes are admin-only per spec §7.4)
- Same test asserts an `embedder_queue` row appears for the new chunk

**Acceptance:** Tests green; org write throws.

---

## Task 6: `memory-repo.forget()` + `context()`

**Goal:** Soft-delete sets `deleted_at = now()`. `context()` is the SessionStart helper: takes username + raw `project_path`, decodes via `path-decode.ts`, runs a default search ("recent + high-hit + scope-mixed"), formats results into a single `system_prompt` string within `budget_tokens` (4 chars/token estimate), returns `{system_prompt, memory_ids[]}`.

**Files:**
- Modify: `hub/indexer/src/memory-repo.ts` — add both
- Modify: `hub/indexer/test/memory-repo.test.ts` — forget hides from search; context returns formatted string under budget; context honors `path_path → encoded_project_dir` translation

**Acceptance:** Tests green.

---

## Task 7: `memory-api.ts` — wire all six routes

**Goal:** Connect the repo to fastify. JSON bodies validated via fastify's built-in zod or `@fastify/type-provider-zod`. No auth (private network).

**Files:**
- Modify: `hub/indexer/src/memory-api.ts` — six routes per spec §7.2 table
- Modify: `hub/indexer/test/memory-api.test.ts` — `inject()` each route against a stubbed repo (one happy path + one bad-body 400 each)

**Acceptance:** All six routes covered by injection tests; bad bodies return 400; missing memory returns 404.

---

## Task 8: integration — mixed-scope search across the real PG

**Goal:** End-to-end query against a real container with org + user + project rows seeded. Catches drift between the SQL the unit tests run and the actual `pgvector` operators / migration order.

**Files:**
- Create: `hub/indexer/test/integration/search-mixed-scope.test.ts` — testcontainers, run all 8 migrations, seed 5 memories across the 3 scope tiers with hand-rolled embeddings (random 384-floats are fine; we're testing ranking & filtering, not relevance), run `searchMemories`, assert order

**Acceptance:** Test green.

---

## Task 9: `mcp-memory/` package — 4 tools, fetch-based HTTP client

**Goal:** Standalone Node binary using `@modelcontextprotocol/sdk`. Reads `USERNAME` and `MEMORY_API_URL` from env. Exposes `memory_search`, `memory_get`, `memory_timeline`, `memory_write` — all are thin proxies to the corresponding HTTP endpoints. Errors from the API surface as MCP tool errors (agent sees them and can decide).

**Files:**
- Create: `mcp-memory/package.json` (deps: `@modelcontextprotocol/sdk`, `zod`)
- Create: `mcp-memory/tsconfig.json` (matches indexer's)
- Create: `mcp-memory/src/index.ts` — stdio MCP server, the four tools wired
- Create: `mcp-memory/test/index.test.ts` — start a stub HTTP server on a random port, point `MEMORY_API_URL` at it, drive each tool through the SDK, assert wire payloads

**Acceptance:** `cd mcp-memory && npm test` green; package builds (`npm run build` produces `dist/index.js`).

---

## Task 10: skeleton — SessionStart hook + three slash commands

**Goal:** Drop the four files into the skeleton tree per spec §7.5 and §7.6. Hook is bash, fail-open (`|| true`), 3-second curl timeout. Commands are markdown.

**Files:**
- Create: `hub/skeleton/harness/hooks/memory_session_start.sh` (verbatim from spec §7.5; chmod +x)
- Create: `hub/skeleton/harness/commands/memorize.md`
- Create: `hub/skeleton/harness/commands/recall.md`
- Create: `hub/skeleton/harness/commands/forget.md`
- Modify: `hub/skeleton/harness/hooks/SessionStart.json` (or wherever the hook list is registered) to include `memory_session_start.sh` ahead of any context-emitting hooks

**Acceptance:** Bash-syntax-check the hook (`bash -n`); slash commands parse as valid markdown.

---

## Task 11: `add-user.sh` — wire MEMORY_API_URL + .mcp.json per user

**Goal:** New users get the MCP server registered and the hook + commands copied. Existing users are unaffected until they're recreated.

**Files:**
- Modify: `hub/scripts/add-user.sh` — write `MEMORY_API_URL=http://claude-bioflow-indexer:8400` and `MEMORY_ENABLED=1` into the per-user env, write `.mcp.json` referencing the globally-installed `bioflow-memory-mcp` binary, copy the hook + commands from the skeleton

**Acceptance:** Run `./scripts/add-user.sh testB` against a dev compose; inspect the generated workspace; revert by `remove-user.sh testB` after verification.

---

## Task 12: image — bundle `mcp-memory` globally

**Goal:** The user devcontainer image includes the MCP binary so per-user `.mcp.json` can reference it without per-user installs.

**Files:**
- Modify: `image/Dockerfile` — add a build stage that runs `npm install` + `npm run build` in `mcp-memory/`, then `npm install -g .` in the runtime stage

**Acceptance:** `docker build -t claude-bioflow:dev .` succeeds; `docker run --rm claude-bioflow:dev which bioflow-memory-mcp` returns a path.

---

## Task 13: rollout — recreate li86 with MEMORY_ENABLED=1

**Goal:** First production user gets the new wiring. Verify SessionStart injects, MCP tools work, memory_write through `/memorize` lands a row.

**Steps:**
- `docker compose build` for `image/` and the new `indexer` (already deployed but rebuilt to pick up Task 7 routes)
- `./scripts/recreate-user.sh li86`
- Open a fresh session in li86's UI; check that the `SessionStart` injection mentions one or more existing memories (we have 22 distilled rows for li86)
- From inside the session, run `/memorize testing memory subsystem` — verify a row lands in `memories WHERE source='user' AND username='li86'`
- Run `/recall testing` — verify it returns the row just written
- Run `/forget <that-id>` — verify `deleted_at` is set
- Verify `memory_search` from the agent (not slash command) — open a chat and ask "what do you remember about my last bulk RNA-seq pipeline?"; confirm the agent calls the tool and surfaces real content

**Acceptance:** All five checks green. Otherwise back out: `MEMORY_ENABLED=0` in the user env, `docker restart claude-bioflow-li86`.

---

## Task 14: rollout — test1, test2, test3

**Goal:** Once li86 is verified for at least one chat session, recreate the other three users.

**Steps:**
- For each of test1, test2, test3: `./scripts/recreate-user.sh <user>`
- Spot-check SessionStart injection in each container
- Final state: `SELECT username, COUNT(*) FROM memories WHERE source='user' GROUP BY 1` shows zero or more rows depending on whether you `/memorize`d during the smoke; existing distilled rows are untouched

**Acceptance:** Four containers running with `MEMORY_ENABLED=1`, no log errors related to the hook or MCP server.

---

## Phase boundary check (sub-phase B → sub-phase C)

After task 14:
- A new chat in any user's container injects ~1–2k tokens of memory context at SessionStart.
- The agent can call `memory_search` mid-turn and the response is truthful (snippet ≤ 200 chars, score sorts as in spec §7.2).
- `/memorize`, `/recall`, `/forget` all work; soft-deleted rows don't reappear in search.
- No regressions in sub-phase A: distiller still ticks every 60s, embedder drains, no new sentinel patterns.

If any of the four bullets fails: back out via `MEMORY_ENABLED=0`. Schema and distilled data are preserved either way.

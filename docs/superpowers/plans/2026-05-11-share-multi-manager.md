# Share-promotion — multi-manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the bus-factor-1 single-manager limit. Today `MEMORY_ORG_MANAGER=li86` is one user. Change to a comma-separated list (`MEMORY_ORG_MANAGER=li86,alice,bob`); any member of the list can approve/reject any pending request; every member sees the same inbox.

**Architecture:** Spec §6 already sketched it: "`MEMORY_ORG_MANAGER` becomes a comma-separated list; `share_requests.reviewer` becomes a list-membership check rather than equality. Schema doesn't change."

Concretely:
- `cfg.memoryOrgManager: string | null` → `cfg.memoryOrgManagers: string[]`. Empty array = service disabled (same as `null` today).
- `share_requests.reviewer` column stays single-valued, **stamped with `managers[0]` at submit** for forensic and UI purposes. The decide auth check stops looking at this column entirely.
- Decide auth: `args.managers.includes(args.actor)` (live config, not the stamped value).
- Inbox filter: `status = 'pending' AND $actor = ANY($managers)` — pass managers as a Postgres array param.
- `getShareCapabilities`: returns `manager_usernames: string[]` (was `manager_username: string | null`).
- `MEMORY_ORG_MANAGER=li86` still parses as `['li86']` — production deployments keep working unchanged.

**Why live config (not frozen-at-submission) for the decide check:** if a user joins or leaves the manager group between submit and decide, we want the *current* group to govern. Frozen would mean "alice can't approve this because she wasn't a manager when test1 submitted it last week" — counterintuitive and operationally fragile.

**Tech Stack:** unchanged — TS/Node 20, fastify, pg, vitest. Frontend Vue 3.

**Spec:** `docs/superpowers/specs/2026-05-07-share-promotion.md` §6 (Manager identity), §2 non-goals row "Multiple managers / N-of-M approval" — N-of-M is still out of scope; this is N-of-1 (any manager).

**Out of scope:**
- N-of-M approval (any-1 is what spec §2 explicitly carves out).
- Per-kind manager roles (e.g. "skill-only manager"). Single flat manager set for v1.
- A managers admin UI. Operator edits compose env + recreates indexer.
- Migrating the `reviewer` column to an array. Stays text; stamped with managers[0].
- Audit-trail of which manager set existed at submission. Reconstructable from git history of compose.

---

## File Structure

**Modified (backend):**
- `hub/indexer/src/config.ts` — `memoryOrgManager` → `memoryOrgManagers: string[]`. Parse comma-separated env, trim, drop empties.
- `hub/indexer/test/config.test.ts` — 3 tests for the new parser (default, single, multi, empty-segment-trimmed).
- `hub/indexer/src/share-repo.ts` — replace `args.manager: string | null` with `args.managers: string[]` across `SubmitArgs`, `DecideArgs`, `ListArgs`, `getShareCapabilities`. Update auth checks and inbox filter.
- `hub/indexer/test/share-repo.test.ts` — mass-update existing test call sites (`manager: 'li86'` → `managers: ['li86']`); add 4 new tests for multi-manager (decide as second manager, inbox visible to both, capabilities is_manager for any in list, no_manager when empty).
- `hub/indexer/src/share-api.ts` — rename `deps.manager` → `deps.managers: string[]`. Update HTTP capabilities response shape.
- `hub/indexer/test/share-api.test.ts` — update mock deps factory; one new test for two-manager capabilities response shape.
- `hub/indexer/src/index.ts` — pass `cfg.memoryOrgManagers` into `shareRoutesPlugin`.

**Modified (frontend):**
- `frontend/src/types/share.ts` — `manager_username: string | null` → `manager_usernames: string[]`.
- `frontend/src/services/share.ts` — update the response mapping.
- `frontend/src/stores/share.ts` — update the initial capabilities value.
- `frontend/src/components/memory/MemoryDetail.vue` — update the "This sends the memory to X" copy to handle a list.

---

## Task 1: Config — parse comma-separated `MEMORY_ORG_MANAGER`

**Files:**
- Modify: `hub/indexer/src/config.ts`
- Modify: `hub/indexer/test/config.test.ts`

- [ ] **Step 1: Replace the field on `Config`**

In `hub/indexer/src/config.ts`, replace:

```ts
memoryOrgManager: string | null;
```

with:

```ts
memoryOrgManagers: string[];
```

In `loadConfig()`, replace the current `memoryOrgManager` parsing block:

```ts
const memoryOrgManager = env.MEMORY_ORG_MANAGER && env.MEMORY_ORG_MANAGER.length > 0
  ? env.MEMORY_ORG_MANAGER
  : null;
```

with:

```ts
const memoryOrgManagers = (env.MEMORY_ORG_MANAGER ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(s => s.length > 0);
```

Update the returned object to use `memoryOrgManagers,` instead of `memoryOrgManager,`.

- [ ] **Step 2: Update config tests**

In `hub/indexer/test/config.test.ts`, the existing three tests for `memoryOrgManager` need updating + extending. Replace them with:

```ts
it('memoryOrgManagers defaults to [] when MEMORY_ORG_MANAGER is unset', () => {
  const cfg = loadConfig({ PG_URL: 'postgres://x' });
  expect(cfg.memoryOrgManagers).toEqual([]);
});

it('memoryOrgManagers reads a single name', () => {
  const cfg = loadConfig({ PG_URL: 'postgres://x', MEMORY_ORG_MANAGER: 'li86' });
  expect(cfg.memoryOrgManagers).toEqual(['li86']);
});

it('memoryOrgManagers parses a comma-separated list and trims whitespace', () => {
  const cfg = loadConfig({ PG_URL: 'postgres://x', MEMORY_ORG_MANAGER: 'li86, alice ,bob' });
  expect(cfg.memoryOrgManagers).toEqual(['li86', 'alice', 'bob']);
});

it('memoryOrgManagers treats empty string and stray commas as empty list', () => {
  const cfg = loadConfig({ PG_URL: 'postgres://x', MEMORY_ORG_MANAGER: ',, ,' });
  expect(cfg.memoryOrgManagers).toEqual([]);
});
```

- [ ] **Step 3: Run tests**

```
cd /home/lili/claude-bioflow/hub/indexer && npm test -- config
```

Expected: 4 multi-manager tests pass; previous 3 single-manager tests are GONE (they referenced the old field name).

- [ ] **Step 4: Commit**

```
git -C /home/lili/claude-bioflow add hub/indexer/src/config.ts hub/indexer/test/config.test.ts
git -C /home/lili/claude-bioflow commit -m "feat(indexer): parse MEMORY_ORG_MANAGER as comma-separated list"
```

No `Co-Authored-By` trailer.

---

## Task 2: `share-repo` — managers array threading + auth + inbox filter

**Files:**
- Modify: `hub/indexer/src/share-repo.ts`
- Modify: `hub/indexer/test/share-repo.test.ts`

- [ ] **Step 1: Widen the arg types**

In `share-repo.ts`, find the four interfaces / arg shapes that reference `manager: string | null`:

1. `SubmitArgs.manager`
2. `DecideArgs.manager`
3. `ListArgs.manager`
4. `getShareCapabilities`'s args (inline type: `{ pool, actor, manager: string | null }`)

Replace each `manager: string | null` with `managers: string[]`.

- [ ] **Step 2: Update `submitShareRequest`**

The single change: replace the empty-manager check.

Find:
```ts
if (args.manager === null) {
  return { ok: false, reason: "no_manager" };
}
```

Replace with:
```ts
if (args.managers.length === 0) {
  return { ok: false, reason: "no_manager" };
}
```

In all three submit branches (memory inline, skill helper, folder helper), the INSERT that stamps `reviewer` currently uses `args.manager`. Change to `args.managers[0]` (which is now guaranteed non-empty by the early-return above).

Memory branch — find:
```ts
[..., args.manager, ...]  // in the INSERT params list
```

Change to `args.managers[0]`. Same in the skill and folder helpers.

(The reviewer column is now stamped with the FIRST manager as a representative — purely informational. Auth uses the live `managers` array, not this column.)

- [ ] **Step 3: Update `decideShareRequest`**

Replace the auth check at the top:

```ts
if (args.manager === null || args.actor !== args.manager) {
  return { ok: false, reason: "forbidden" };
}
```

With:

```ts
if (!args.managers.includes(args.actor)) {
  return { ok: false, reason: "forbidden" };
}
```

(Empty `managers` array still rejects — `[].includes(anything)` is false. The `no_manager` path doesn't apply to decide; forbidden covers it.)

- [ ] **Step 4: Update `listShareRequests` inbox filter**

In the `role === "inbox"` branch, find:

```ts
if (args.role === "inbox") {
  if (args.actor !== args.manager) {
    return { items: [], next_cursor: null };
  }
}
```

Replace with:

```ts
if (args.role === "inbox") {
  if (!args.managers.includes(args.actor)) {
    return { items: [], next_cursor: null };
  }
}
```

In the subsequent SQL conditions section where role inbox builds the where clause, the current code uses `reviewer = $actor`. The new semantics: a manager sees all pending requests, regardless of which manager's name is in the stamped reviewer column. Change the WHERE construction:

Find:
```ts
} else if (args.role === "inbox") {
  params.push(args.actor);
  conditions.push(`reviewer = $${params.length}`);
  conditions.push(`status = 'pending'`);
}
```

Replace with:
```ts
} else if (args.role === "inbox") {
  // Multi-manager: any manager sees every pending request. The `reviewer`
  // column is informational (stamped with managers[0] at submit time).
  conditions.push(`status = 'pending'`);
}
```

(The early-return above already guarantees `args.actor` is a manager, so we don't need a per-row check here. The query returns all pending requests; the auth gate happens at the API boundary.)

- [ ] **Step 5: Update `getShareCapabilities`**

The function currently returns `manager_username: string | null`. Replace its return shape and computation:

```ts
export async function getShareCapabilities(args: {
  pool:     Pool;
  actor:    string;
  managers: string[];
}): Promise<{
  is_manager:           boolean;
  manager_usernames:    string[];
  pending_inbox_count:  number;
  actor_username:       string;
}> {
  const is_manager = args.managers.includes(args.actor);

  let pending_inbox_count = 0;
  if (is_manager) {
    const r = await args.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM share_requests
        WHERE status = 'pending'`,
    );
    pending_inbox_count = parseInt(r.rows[0]!.count, 10);
  }

  return {
    is_manager,
    manager_usernames:   args.managers,
    pending_inbox_count,
    actor_username:      args.actor,
  };
}
```

Note: the SQL filter dropped the `reviewer = $actor` check. Every manager sees the same count — all pending requests across the queue.

- [ ] **Step 6: Mass-update existing test callers**

Every call site of `submitShareRequest`, `decideShareRequest`, `listShareRequests`, and `getShareCapabilities` in `share-repo.test.ts` currently passes `manager: 'li86'` (or `manager: null` for the no-manager-configured cases). Rename:
- `manager: 'li86'` → `managers: ['li86']`
- `manager: null` → `managers: []`

This is a mechanical replace; do it once globally over the file. Verify each call site type-checks.

- [ ] **Step 7: Add new multi-manager tests**

Add a new `describe("multi-manager", ...)` block to `share-repo.test.ts`. Reuse whatever fixture pattern the existing describe blocks use:

```ts
describe("multi-manager", () => {
  let workspacesRoot: string;
  let shareSnapshotsDir: string;
  const maxFolderBytes = 100 * 1024 * 1024;
  const managers = ['li86', 'alice'];

  beforeEach(async () => {
    workspacesRoot    = await mkdtemp(path.join(tmpdir(), "ws-"));
    shareSnapshotsDir = await mkdtemp(path.join(tmpdir(), "snap-"));
  });

  /** Helper: insert a pending memory share row via the repo, using li86 as primary. */
  async function seedPending(): Promise<string> {
    // Pre-seed the source memory row.
    const u = await pool.query<{ memory_id: string }>(
      `INSERT INTO memories (username, project_dir, type, source, source_session_id,
                             name, description, body, content_hash, facets)
       VALUES ('bob', null, 'fact', 'user', null, 'n', 'd', 'b', 'h', '{}'::jsonb)
       RETURNING memory_id`);
    const memId = u.rows[0]!.memory_id;
    const r = await submitShareRequest({
      pool, managers, requester: 'bob',
      kind: 'memory', ref: memId,
      workspacesRoot, shareSnapshotsDir, maxFolderBytes,
    });
    if (!r.ok) throw new Error('seed failed');
    return r.share_id;
  }

  it("any manager can approve any pending request", async () => {
    const id = await seedPending();
    // alice (not the primary, but in the managers list) approves
    const r = await decideShareRequest({
      pool, actor: 'alice', managers,
      shareId: id, decision: 'approve',
      workspacesRoot, shareSnapshotsDir,
    });
    expect(r.ok).toBe(true);
  });

  it("a non-manager cannot decide", async () => {
    const id = await seedPending();
    const r = await decideShareRequest({
      pool, actor: 'bob', managers,
      shareId: id, decision: 'approve',
      workspacesRoot, shareSnapshotsDir,
    });
    expect(r).toMatchObject({ ok: false, reason: 'forbidden' });
  });

  it("every manager sees the same pending inbox", async () => {
    await seedPending();
    await seedPending();
    for (const m of managers) {
      const list = await listShareRequests({
        pool, actor: m, managers, role: 'inbox',
      });
      expect(list.items).toHaveLength(2);
    }
  });

  it("getShareCapabilities returns is_manager=true for every manager and pending_inbox_count for all", async () => {
    await seedPending();
    for (const m of managers) {
      const caps = await getShareCapabilities({ pool, actor: m, managers });
      expect(caps.is_manager).toBe(true);
      expect(caps.manager_usernames).toEqual(managers);
      expect(caps.pending_inbox_count).toBe(1);
    }
    const caps = await getShareCapabilities({ pool, actor: 'bob', managers });
    expect(caps.is_manager).toBe(false);
    expect(caps.pending_inbox_count).toBe(0);
  });
});
```

Note: the seed helper assumes the existing share-repo test file knows how to insert a `memories` row — if the file uses a different mechanism for seeding memory shares, pattern-match what's there.

- [ ] **Step 8: Run tests**

```
cd /home/lili/claude-bioflow/hub/indexer && npm test -- share-repo
```

Expected: existing test count + 4 new multi-manager tests pass. If a renamed call site was missed it'll show as a TS error or test failure — fix as you go.

- [ ] **Step 9: Commit**

```
git -C /home/lili/claude-bioflow add hub/indexer/src/share-repo.ts hub/indexer/test/share-repo.test.ts
git -C /home/lili/claude-bioflow commit -m "feat(share-repo): managers array — any manager can decide; shared inbox"
```

No `Co-Authored-By` trailer.

---

## Task 3: `share-api` — thread `managers` + capabilities response shape

**Files:**
- Modify: `hub/indexer/src/share-api.ts`
- Modify: `hub/indexer/src/index.ts`
- Modify: `hub/indexer/test/share-api.test.ts`

- [ ] **Step 1: Update `ShareApiDeps`**

In `share-api.ts`, replace:

```ts
manager: string | null;
```

with:

```ts
managers: string[];
```

In every handler that called `deps.repo.<fn>(...)` passing `manager: deps.manager`, change to `managers: deps.managers`. This affects submit, list, get-by-id, decide, withdraw, capabilities, and snapshot-file routes.

Also: the submit handler currently returns 503 when `deps.manager === null`. Update:

```ts
if (deps.manager === null) { ... reply.code(503); return { error: 'sharing disabled — no manager configured' }; }
```

→

```ts
if (deps.managers.length === 0) { ... reply.code(503); return { error: 'sharing disabled — no manager configured' }; }
```

- [ ] **Step 2: Update `index.ts` plumbing**

In `hub/indexer/src/index.ts`, in the `shareRoutesPlugin({...})` call, replace:

```ts
manager: cfg.memoryOrgManager,
```

with:

```ts
managers: cfg.memoryOrgManagers,
```

- [ ] **Step 3: Update share-api test deps factory**

In `share-api.test.ts`, find the `makeDeps()` factory (or whatever the suite uses). Replace `manager: 'li86'` with `managers: ['li86']` everywhere. There may also be a "no manager configured" test that passes `manager: null` — change to `managers: []`.

- [ ] **Step 4: Add one new test for the multi-manager capabilities response**

In `share-api.test.ts`, in whichever describe block tests `/share/capabilities`, add:

```ts
it('returns manager_usernames array and is_manager for any listed user', async () => {
  // Adapt to the test file's mock pattern: mock getShareCapabilities to return:
  //   { is_manager: true, manager_usernames: ['li86', 'alice'], pending_inbox_count: 3, actor_username: 'alice' }
  // and assert the HTTP response shape.
  vi.mocked(repoMock.getShareCapabilities).mockResolvedValueOnce({
    is_manager: true,
    manager_usernames: ['li86', 'alice'],
    pending_inbox_count: 3,
    actor_username: 'alice',
  });
  const res = await app.inject({
    method: 'GET',
    url:    '/share/capabilities?actor=alice',
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({
    is_manager: true,
    manager_usernames: ['li86', 'alice'],
    pending_inbox_count: 3,
  });
});
```

- [ ] **Step 5: Run tests + typecheck**

```
cd /home/lili/claude-bioflow/hub/indexer && npm run typecheck
cd /home/lili/claude-bioflow/hub/indexer && npm test -- share-api
```

Expected: typecheck clean for share-api.ts and index.ts (pre-existing strict-mode noise in unrelated test files is fine). share-api tests all pass + 1 new.

- [ ] **Step 6: Commit**

```
git -C /home/lili/claude-bioflow add hub/indexer/src/share-api.ts hub/indexer/src/index.ts hub/indexer/test/share-api.test.ts
git -C /home/lili/claude-bioflow commit -m "feat(share-api): thread managers array + manager_usernames in capabilities"
```

No `Co-Authored-By` trailer.

---

## Task 4: Frontend — `manager_usernames` + MemoryDetail copy

**Files:**
- Modify: `frontend/src/types/share.ts`
- Modify: `frontend/src/services/share.ts`
- Modify: `frontend/src/stores/share.ts`
- Modify: `frontend/src/components/memory/MemoryDetail.vue`

- [ ] **Step 1: Update the type**

In `frontend/src/types/share.ts`, replace:

```ts
manager_username: string | null;
```

with:

```ts
manager_usernames: string[];
```

- [ ] **Step 2: Update the service mapping**

In `frontend/src/services/share.ts`, the `capabilities` method currently maps `manager_username: result.manager_username`. Change to:

```ts
manager_usernames: result.manager_usernames,
```

- [ ] **Step 3: Update the store initial value**

In `frontend/src/stores/share.ts`, find the initial `capabilities` ref:

```ts
manager_username: null,
```

Change to:

```ts
manager_usernames: [],
```

- [ ] **Step 4: Update `MemoryDetail.vue` copy**

In `frontend/src/components/memory/MemoryDetail.vue` line ~224:

```vue
This sends the memory to <strong>{{ shareStore.capabilities.manager_username ?? 'the manager' }}</strong>
```

Change to:

```vue
This sends the memory to <strong>{{ managerLabel }}</strong>
```

Add a computed at the top of `<script setup>`:

```ts
const managerLabel = computed(() => {
  const names = shareStore.capabilities.manager_usernames
  return names.length === 0 ? 'the manager' : names.join(', ')
})
```

(`computed` should already be imported from `'vue'` — verify; if not, add to the import line.)

- [ ] **Step 5: Build clean**

```
cd /home/lili/claude-bioflow/frontend && npm run build
```

Expected: clean TS build.

- [ ] **Step 6: Commit**

```
git -C /home/lili/claude-bioflow add \
  frontend/src/types/share.ts \
  frontend/src/services/share.ts \
  frontend/src/stores/share.ts \
  frontend/src/components/memory/MemoryDetail.vue
git -C /home/lili/claude-bioflow commit -m "feat(frontend): manager_usernames array; show the manager list in MemoryDetail copy"
```

No `Co-Authored-By` trailer.

---

## Task 5: Final smoke

- [ ] **Step 1: Full indexer test suite**

```
cd /home/lili/claude-bioflow/hub/indexer && npm test
```

Expected: ~340 + (4 multi-manager + 1 share-api) = ~345 tests pass.

- [ ] **Step 2: Rebuild indexer + recreate container**

```
cd /home/lili/claude-bioflow/hub
docker compose build indexer
docker compose up -d indexer
sleep 8
docker logs claude-bioflow-indexer 2>&1 | grep -iE "listening|share|managers|error" | tail -10
```

Expected: clean boot.

- [ ] **Step 3: Live multi-manager smoke test**

In `hub/docker-compose.yml`, change:

```yaml
MEMORY_ORG_MANAGER: li86
```

to a two-manager value (e.g. `li86,test1` — pick a real user). Apply with `docker compose up -d indexer`.

In the browser:
1. As `test1` (now a manager): open the Share panel; Inbox tab should be visible.
2. As `li86` (still a manager): submit a memory share. Inbox count should fire for both li86 AND test1.
3. As `test1`: approve the request. Verify in the DB that `decided_at` is set and `review_comment` is recorded.
4. Revert the compose change OR keep the multi-manager setup if you want it permanent.

Skip this step if you're not running the live stack. The unit tests cover the same behavior.

- [ ] **Step 4: Frontend rebuild**

Frontend `dist/` is bind-mounted into nginx (no container restart needed), but a fresh browser session is needed to pick up the new bundle. `npm run build` was already done in Task 4 Step 5.

When green: merge to main.

---

## Appendix: rough timing

| Task | Est | Notes |
|---|---:|---|
| 1 config | 30m | parse + 4 tests |
| 2 share-repo | 1.5h | the bulk; rename across ~50 call sites + 4 new tests |
| 3 share-api | 45m | thread + 1 test |
| 4 frontend | 30m | 4 files, mechanical |
| 5 final smoke | 30m | indexer rebuild + optional live test |

Total: ~3.5 hours. The dominant cost is the mechanical rename in Task 2's test mass-update; everything else is small.

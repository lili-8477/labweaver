# Share-to-org promotion — phase 1 (memory only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the user→manager review-gated promotion path for memory rows. After this lands, any user can click "Share" on a memory in the panel; the request lands in li86's Inbox with a count badge on the Share tab; li86 reviews the snapshot and clicks Approve or Reject; on approve the row materialises under `username='__org__'` and every user sees it under the Org tab immediately.

**Architecture:** New `share_requests` table (migration 0010) holding the queue with frozen JSONB snapshots, six HTTP routes on the indexer (`share-api.ts`), parallel NATS RPC bridge in the adapter (`share-rpc.ts` + six new dispatch cases), a new Vue right-panel "Share" alongside Memory with Outbox/Inbox tabs and a badge counter on the panel button, and a Share button added to MemoryDetail. `actor`/`requester` are server-injected from the adapter's `USERNAME` env (same trust pattern as memory_*); the frontend never sends usernames. Manager identity is `MEMORY_ORG_MANAGER` env var on the indexer (single manager v1).

**Phase scope:** memory-kind only end-to-end. Indexer routes accept `kind: 'memory' | 'skill' | 'folder'` per the data model but `submit`/`decide` return 501 for `skill` and `folder` — those land in phase 2/3. No tarball snapshotting in this phase, no path-traversal guards (only relevant for file-system kinds), no `:rw` mount swap on the indexer.

**Tech Stack:**
- Backend: TypeScript / Node 20, fastify, vitest + `@testcontainers/postgresql` (matches existing indexer)
- Adapter: TypeScript / Node 20, vitest (matches sub-phase C's `memory-rpc.ts`)
- Frontend: Vue 3 Composition API + pinia + `nats.ws` (no new runtime deps)

**Spec:** `docs/superpowers/specs/2026-05-07-share-promotion.md`. Resolved decisions in §13. MVP slice description in §11.

**Production prerequisites already in place:**
- `memory_audit_log` table from migration 0009 (sub-phase C).
- `MemoryDetail.vue` has its action bar in place; we add one button.
- Adapter's `RpcRouter` already constructs typed deps via `RpcRouterDeps`; we extend it.
- Frontend's `MainLayout.vue` already has a `RightPanel` union including `'memory'`; we add `'share'`.

**Out of phase 1 scope:**
- Skill kind: tarball, path-traversal, indexer mount swap, Skills panel — phase 2.
- Folder kind: same machinery on `local_projects/`, Files-panel context menu, size cap — phase 3.
- Multi-manager.
- Auto-close-on-idle for stale pending requests.
- Push notifications / Slack pings.
- "Update existing org skill" share kind.
- Org→user fork verb.

---

## File Structure

**Created:**
- `hub/indexer/migrations/0010_share_requests.sql`
- `hub/indexer/test/migrations-0010-smoke.test.ts` — testcontainers, asserts table + 3 indexes + status check constraint
- `hub/indexer/src/share-repo.ts` — six exported functions: `submitShareRequest`, `listShareRequests`, `getShareRequest`, `decideShareRequest`, `withdrawShareRequest`, `getShareCapabilities`
- `hub/indexer/test/share-repo.test.ts` — testcontainers PG, end-to-end coverage of all six (happy path, ownership rejection, manager-vs-non-manager, dedup-on-approve, idempotent decide, withdraw-after-decision rejection)
- `hub/indexer/src/share-api.ts` — six fastify routes
- `hub/indexer/test/share-api.test.ts` — `app.inject()` coverage of all six routes
- `adapter/src/share-rpc.ts` — fetch-based HTTP client, one method per route
- `adapter/test/share-rpc.test.ts` — stub HTTP server on random port; asserts wire payloads
- `adapter/test/rpc-share.test.ts` — six dispatch cases over a stub `ShareRpcClient`
- `frontend/src/types/share.ts` — typed payloads
- `frontend/src/services/share.ts` — thin wrapper over `natsService.invoke('share_*', ...)`
- `frontend/src/stores/share.ts` — pinia store: queue state, current view (outbox|inbox), selection, badge count
- `frontend/src/components/share/SharePanel.vue` — top-level: tab switcher, list + detail layout
- `frontend/src/components/share/ShareList.vue` — outbox/inbox list rows with kind icon + status pill
- `frontend/src/components/share/ShareDetail.vue` — header + memory snapshot preview + action bar (Approve/Reject for manager, Withdraw for requester)

**Modified:**
- `hub/indexer/src/config.ts` — add `memoryOrgManager: string | null` field to `Config`
- `hub/indexer/src/index.ts` — wire `share-repo` functions into the repo bag passed to `share-api.buildApp`
- `hub/docker-compose.yml` — add `MEMORY_ORG_MANAGER: li86` to the indexer service env
- `adapter/src/index.ts` — instantiate `ShareRpcClient(MEMORY_API_URL, USERNAME)`, pass into `RpcRouter` deps
- `adapter/src/rpc.ts` — add six `case "share_*":` branches; extend `RpcRouterDeps`
- `frontend/src/components/memory/MemoryDetail.vue` — add `[Share]` button to the action bar + submit-modal logic
- `frontend/src/components/layout/MainLayout.vue` — add `'share'` to the `RightPanel` union, render branch, toolbar button with `(N)` badge derived from `share_capabilities`

---

## Task 1: Migration 0010 — `share_requests` table

**Files:**
- Create: `hub/indexer/migrations/0010_share_requests.sql`
- Create: `hub/indexer/test/migrations-0010-smoke.test.ts`

- [ ] **Step 1: Write the migration**

```sql
-- 0010_share_requests.sql
-- Share-to-org promotion queue. One row per submission. State machine:
--   pending → approved | rejected | withdrawn (terminal).
-- Frozen JSONB snapshot at submission time so manager reviews what was
-- submitted, not whatever the source looks like at decision time.

CREATE TABLE share_requests (
  share_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_kind   text NOT NULL CHECK (artifact_kind IN ('memory', 'skill', 'folder')),
  artifact_ref    text NOT NULL,
  snapshot_meta   jsonb NOT NULL,
  requester       text NOT NULL,
  reviewer        text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  requester_note  text,
  review_comment  text,
  promotion_result jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz
);

CREATE INDEX share_requests_status_created_idx
  ON share_requests (status, created_at DESC);

CREATE INDEX share_requests_requester_idx
  ON share_requests (requester, created_at DESC);

CREATE INDEX share_requests_reviewer_pending_idx
  ON share_requests (reviewer, created_at DESC)
  WHERE status = 'pending';
```

- [ ] **Step 2: Write the failing test**

```ts
// hub/indexer/test/migrations-0010-smoke.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('migration 0010 share_requests', () => {
  let pgc: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    pgc = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    pool = new Pool({ connectionString: pgc.getConnectionUri() });
    await runMigrations({
      pool,
      migrationsDir: path.resolve(HERE, '..', 'migrations'),
      lockKey: 0xdeadbeefn,
    });
  }, 60_000);
  afterAll(async () => { await pool.end(); await pgc.stop(); });

  it('applies all 10 migrations and creates share_requests with constraints + indexes', async () => {
    const t = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name='share_requests'`,
    );
    expect(t.rowCount).toBe(1);

    const idx = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname='public' AND tablename='share_requests'
        ORDER BY indexname`,
    );
    expect(idx.rows.map(r => r.indexname).sort()).toEqual([
      'share_requests_pkey',
      'share_requests_requester_idx',
      'share_requests_reviewer_pending_idx',
      'share_requests_status_created_idx',
    ]);

    // CHECK constraint rejects bad kinds.
    await expect(pool.query(
      `INSERT INTO share_requests (artifact_kind, artifact_ref, snapshot_meta, requester, reviewer)
       VALUES ('garbage','x','{}','alice','li86')`,
    )).rejects.toThrow(/share_requests_artifact_kind_check/);

    // CHECK constraint rejects bad statuses.
    await expect(pool.query(
      `INSERT INTO share_requests (artifact_kind, artifact_ref, snapshot_meta, requester, reviewer, status)
       VALUES ('memory','x','{}','alice','li86','garbage')`,
    )).rejects.toThrow(/share_requests_status_check/);
  });
});
```

- [ ] **Step 3: Run test to verify it passes**

```
cd hub/indexer && npm test -- migrations-0010-smoke
```
Expected: 1 test passing.

- [ ] **Step 4: Commit**

```
git add hub/indexer/migrations/0010_share_requests.sql hub/indexer/test/migrations-0010-smoke.test.ts
git commit -m "feat(indexer): migration 0010 share_requests for share-to-org promotion queue"
```

---

## Task 2: Indexer config — `MEMORY_ORG_MANAGER` env

**Files:**
- Modify: `hub/indexer/src/config.ts`
- Modify: `hub/indexer/test/config.test.ts`

- [ ] **Step 1: Extend `Config` interface**

Add field to `Config`:

```ts
memoryOrgManager: string | null;
```

In `loadConfig()`, after the existing reads:

```ts
const memoryOrgManager = env.MEMORY_ORG_MANAGER && env.MEMORY_ORG_MANAGER.length > 0
  ? env.MEMORY_ORG_MANAGER
  : null;
```

Include in the returned object: `memoryOrgManager,`.

- [ ] **Step 2: Add test cases**

```ts
// in hub/indexer/test/config.test.ts
it('memoryOrgManager defaults to null when MEMORY_ORG_MANAGER is unset', () => {
  const cfg = loadConfig({ PG_URL: 'postgres://x', ANTHROPIC_API_KEY: 'sk' });
  expect(cfg.memoryOrgManager).toBeNull();
});

it('memoryOrgManager reads MEMORY_ORG_MANAGER as-is', () => {
  const cfg = loadConfig({
    PG_URL: 'postgres://x', ANTHROPIC_API_KEY: 'sk',
    MEMORY_ORG_MANAGER: 'li86',
  });
  expect(cfg.memoryOrgManager).toBe('li86');
});

it('memoryOrgManager treats empty string as null', () => {
  const cfg = loadConfig({
    PG_URL: 'postgres://x', ANTHROPIC_API_KEY: 'sk',
    MEMORY_ORG_MANAGER: '',
  });
  expect(cfg.memoryOrgManager).toBeNull();
});
```

- [ ] **Step 3: Run tests**

```
cd hub/indexer && npm test -- config
```
Expected: 3 new tests passing on top of existing `config.test.ts`.

- [ ] **Step 4: Commit**

```
git add hub/indexer/src/config.ts hub/indexer/test/config.test.ts
git commit -m "feat(indexer): add MEMORY_ORG_MANAGER config with null default"
```

---

## Task 3: `share-repo.ts` — six functions + tests

This is the largest single task. The repo encapsulates all state-machine + auth logic; the API layer just maps HTTP errors.

**Files:**
- Create: `hub/indexer/src/share-repo.ts`
- Create: `hub/indexer/test/share-repo.test.ts`

- [ ] **Step 1: Write the type interfaces and exports**

```ts
// share-repo.ts
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { insertMemoryRow } from './distiller-repo.js';
import { contentHash } from './content-hash.js';
import { appendAudit } from './memory-repo.js';

export type ArtifactKind = 'memory' | 'skill' | 'folder';
export type ShareStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface ShareRequest {
  share_id:        string;
  artifact_kind:   ArtifactKind;
  artifact_ref:    string;
  snapshot_meta:   Record<string, unknown>;
  requester:       string;
  reviewer:        string;
  status:          ShareStatus;
  requester_note:  string | null;
  review_comment:  string | null;
  promotion_result: Record<string, unknown> | null;
  created_at:      string;
  decided_at:      string | null;
}

export interface SubmitArgs {
  pool:           Pool;
  manager:        string | null;        // null → 503 service-unavailable
  requester:      string;
  kind:           ArtifactKind;
  ref:            string;
  note?:          string;
}

export type SubmitResult =
  | { ok: true; share_id: string }
  | { ok: false; reason: 'no_manager' | 'not_implemented' | 'source_not_found' | 'forbidden' | 'invalid_ref' };

export interface ListArgs {
  pool:    Pool;
  actor:   string;
  manager: string | null;
  role:    'outbox' | 'inbox' | 'all';
  status?: ShareStatus;
  limit?:  number;
  cursor?: string;            // ISO created_at of last item from previous page
}

export interface DecideArgs {
  pool:     Pool;
  actor:    string;
  manager:  string | null;
  shareId:  string;
  decision: 'approve' | 'reject';
  comment?: string;
}

export type DecideResult =
  | { ok: true; status: ShareStatus; promotion_result?: Record<string, unknown> }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'already_decided' | 'promotion_failed'; detail?: string };
```

- [ ] **Step 2: Implement `submitShareRequest` (memory kind only; skill/folder → not_implemented)**

```ts
export async function submitShareRequest(a: SubmitArgs): Promise<SubmitResult> {
  if (a.manager === null) return { ok: false, reason: 'no_manager' };
  if (a.kind !== 'memory') return { ok: false, reason: 'not_implemented' };

  // Validate the source row exists, is alive, and is owned by the requester.
  const r = await a.pool.query<{ memory_id: string }>(
    `SELECT memory_id FROM memories
      WHERE memory_id = $1 AND username = $2 AND deleted_at IS NULL`,
    [a.ref, a.requester],
  );
  if (r.rowCount === 0) {
    return { ok: false, reason: 'forbidden' };
  }

  // Build the snapshot. Re-read the row so the snapshot is a stable point-in-time copy.
  const snap = await a.pool.query<{
    name: string; description: string; body: string; type: string;
    source: 'user' | 'distilled'; hit_count: number;
    last_hit_at: Date | null; facets: Record<string, string[]>;
  }>(
    `SELECT m.name, m.description, m.body, m.type, m.source,
            m.hit_count, m.last_hit_at,
            COALESCE((SELECT jsonb_object_agg(key, vals) FROM (
              SELECT key, jsonb_agg(value ORDER BY value COLLATE "C") AS vals
                FROM memory_facets WHERE memory_id = m.memory_id
                GROUP BY key
            ) g), '{}'::jsonb) AS facets
       FROM memories m WHERE memory_id = $1`,
    [a.ref],
  );
  const s = snap.rows[0]!;
  const snapshot_meta = {
    name: s.name, description: s.description, body: s.body,
    type: s.type, source: s.source,
    hit_count: s.hit_count,
    last_hit_at: s.last_hit_at?.toISOString() ?? null,
    facets: s.facets,
  };

  const share_id = randomUUID();
  await a.pool.query(
    `INSERT INTO share_requests
       (share_id, artifact_kind, artifact_ref, snapshot_meta, requester, reviewer, requester_note)
     VALUES ($1, 'memory', $2, $3, $4, $5, $6)`,
    [share_id, a.ref, snapshot_meta, a.requester, a.manager, a.note ?? null],
  );
  return { ok: true, share_id };
}
```

- [ ] **Step 3: Implement `listShareRequests`** (cursor pagination identical to `listMemories`)

```ts
export async function listShareRequests(a: ListArgs): Promise<{ items: ShareRequest[]; next_cursor: string | null }> {
  const limit = Math.min(a.limit ?? 50, 200);
  // role determines the WHERE; outbox = my submissions, inbox = pending where I'm reviewer.
  let where: string;
  const params: unknown[] = [];
  if (a.role === 'outbox') {
    params.push(a.actor);
    where = `requester = $${params.length}`;
  } else if (a.role === 'inbox') {
    if (a.actor !== a.manager) {
      // non-managers have an empty inbox
      return { items: [], next_cursor: null };
    }
    params.push(a.actor);
    where = `reviewer = $${params.length} AND status = 'pending'`;
  } else {
    params.push(a.actor); params.push(a.actor);
    where = `(requester = $${params.length - 1} OR reviewer = $${params.length})`;
  }
  if (a.status) {
    params.push(a.status);
    where += ` AND status = $${params.length}`;
  }
  if (a.cursor) {
    params.push(a.cursor);
    where += ` AND created_at < $${params.length}::timestamptz`;
  }
  params.push(limit + 1);
  const sql = `
    SELECT share_id, artifact_kind, artifact_ref, snapshot_meta, requester, reviewer,
           status, requester_note, review_comment, promotion_result,
           created_at, decided_at
      FROM share_requests
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length}`;
  const r = await a.pool.query(sql, params);
  const hasMore = r.rows.length > limit;
  const page = hasMore ? r.rows.slice(0, limit) : r.rows;
  const items: ShareRequest[] = page.map((row: any) => ({
    share_id: row.share_id,
    artifact_kind: row.artifact_kind,
    artifact_ref: row.artifact_ref,
    snapshot_meta: row.snapshot_meta,
    requester: row.requester,
    reviewer: row.reviewer,
    status: row.status,
    requester_note: row.requester_note,
    review_comment: row.review_comment,
    promotion_result: row.promotion_result,
    created_at: row.created_at.toISOString(),
    decided_at: row.decided_at?.toISOString() ?? null,
  }));
  const next_cursor = hasMore ? items[items.length - 1]!.created_at : null;
  return { items, next_cursor };
}
```

- [ ] **Step 4: Implement `getShareRequest`** (owner-or-reviewer auth)

```ts
export async function getShareRequest(args: { pool: Pool; actor: string; shareId: string }): Promise<ShareRequest | { error: 'not_found' | 'forbidden' }> {
  const r = await args.pool.query(
    `SELECT * FROM share_requests WHERE share_id = $1`, [args.shareId],
  );
  if (r.rowCount === 0) return { error: 'not_found' };
  const row = r.rows[0]!;
  if (row.requester !== args.actor && row.reviewer !== args.actor) {
    return { error: 'forbidden' };
  }
  return {
    share_id: row.share_id,
    artifact_kind: row.artifact_kind,
    artifact_ref: row.artifact_ref,
    snapshot_meta: row.snapshot_meta,
    requester: row.requester,
    reviewer: row.reviewer,
    status: row.status,
    requester_note: row.requester_note,
    review_comment: row.review_comment,
    promotion_result: row.promotion_result,
    created_at: row.created_at.toISOString(),
    decided_at: row.decided_at?.toISOString() ?? null,
  };
}
```

- [ ] **Step 5: Implement `decideShareRequest`** (transactional state transition + memory promotion)

```ts
export async function decideShareRequest(a: DecideArgs): Promise<DecideResult> {
  if (a.manager === null) return { ok: false, reason: 'forbidden' };
  if (a.actor !== a.manager) return { ok: false, reason: 'forbidden' };

  const client = await a.pool.connect();
  try {
    await client.query('BEGIN');
    const sel = await client.query(
      `SELECT * FROM share_requests WHERE share_id = $1 FOR UPDATE`,
      [a.shareId],
    );
    if (sel.rowCount === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }
    const row = sel.rows[0]!;
    if (row.status !== 'pending') {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'already_decided', detail: row.status };
    }

    if (a.decision === 'reject') {
      await client.query(
        `UPDATE share_requests SET status='rejected', decided_at=now(), review_comment=$2 WHERE share_id=$1`,
        [a.shareId, a.comment ?? null],
      );
      await client.query('COMMIT');
      return { ok: true, status: 'rejected' };
    }

    // approve path — kind-dispatch
    let promotion_result: Record<string, unknown>;
    if (row.artifact_kind === 'memory') {
      const snap = row.snapshot_meta as {
        name: string; description: string; body: string;
        type: string; facets: Record<string, string[]>;
      };
      const promotedId = await insertMemoryRow(client, {
        username:          '__org__',
        project_dir:       null,
        source:            'user',
        type:              snap.type,
        source_session_id: null,
        name:              snap.name,
        description:       snap.description,
        body:              snap.body,
        facets:            snap.facets,
        content_hash:      contentHash({ body: `${snap.name}\n${snap.body}`, promptVersion: 0 }),
      });
      if (promotedId === null) {
        // dedup hit — an org row with the same content already exists; surface it
        const existing = await client.query<{ memory_id: string }>(
          `SELECT memory_id FROM memories
            WHERE username='__org__' AND project_dir IS NULL AND type=$1 AND content_hash=$2`,
          [snap.type, contentHash({ body: `${snap.name}\n${snap.body}`, promptVersion: 0 })],
        );
        promotion_result = {
          deduped: true,
          existing_memory_id: existing.rows[0]?.memory_id ?? null,
          promoted_memory_id: null,
        };
      } else {
        // append audit row linking back to the share
        await appendAudit(client, {
          memoryId: promotedId,
          actor:    '__org__',
          action:   'write',
          before:   null,
          after:    { via: 'share_promotion', share_id: a.shareId, promoted_from: row.artifact_ref },
        });
        promotion_result = { promoted_memory_id: promotedId, deduped: false };
      }
    } else {
      // skill / folder fall through here in phase 2/3
      await client.query('ROLLBACK');
      return { ok: false, reason: 'promotion_failed', detail: `kind '${row.artifact_kind}' not implemented` };
    }

    await client.query(
      `UPDATE share_requests
          SET status='approved', decided_at=now(),
              review_comment=$2, promotion_result=$3
        WHERE share_id=$1`,
      [a.shareId, a.comment ?? null, promotion_result],
    );
    await client.query('COMMIT');
    return { ok: true, status: 'approved', promotion_result };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 6: Implement `withdrawShareRequest`** (requester-only, pending-only)

```ts
export async function withdrawShareRequest(args: { pool: Pool; actor: string; shareId: string }): Promise<{ ok: boolean; reason?: 'not_found' | 'forbidden' | 'already_decided' }> {
  const client = await args.pool.connect();
  try {
    await client.query('BEGIN');
    const sel = await client.query(
      `SELECT requester, status FROM share_requests WHERE share_id=$1 FOR UPDATE`,
      [args.shareId],
    );
    if (sel.rowCount === 0) { await client.query('ROLLBACK'); return { ok: false, reason: 'not_found' }; }
    const row = sel.rows[0]!;
    if (row.requester !== args.actor) { await client.query('ROLLBACK'); return { ok: false, reason: 'forbidden' }; }
    if (row.status !== 'pending')      { await client.query('ROLLBACK'); return { ok: false, reason: 'already_decided' }; }
    await client.query(
      `UPDATE share_requests SET status='withdrawn', decided_at=now() WHERE share_id=$1`,
      [args.shareId],
    );
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 7: Implement `getShareCapabilities`** (returns is_manager + pending count)

```ts
export async function getShareCapabilities(args: { pool: Pool; actor: string; manager: string | null }): Promise<{
  is_manager: boolean;
  manager_username: string | null;
  pending_inbox_count: number;
}> {
  const is_manager = args.manager !== null && args.actor === args.manager;
  let pending_inbox_count = 0;
  if (is_manager) {
    const r = await args.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM share_requests
        WHERE reviewer = $1 AND status = 'pending'`,
      [args.actor],
    );
    pending_inbox_count = parseInt(r.rows[0]!.count, 10);
  }
  return { is_manager, manager_username: args.manager, pending_inbox_count };
}
```

- [ ] **Step 8: Write the test suite** (`share-repo.test.ts` — testcontainers PG)

Mirror the structure of `memory-repo.test.ts`'s `beforeAll`/`afterAll` with a fresh PG container. Cover:

```ts
describe('submitShareRequest', () => {
  it('happy path: queues a memory request, snapshot has frozen body+facets');
  it('returns no_manager when manager is null');
  it('returns not_implemented for kind=skill / kind=folder');
  it('returns forbidden when source memory_id is owned by a different user');
  it('returns forbidden when source memory is soft-deleted');
});

describe('listShareRequests', () => {
  it('outbox: returns own submissions across all statuses');
  it('inbox: returns reviewer=actor pending, empty for non-managers');
  it('all: returns rows where actor is requester OR reviewer');
  it('cursor pagination: limit=2 traversal equals limit=200 single-shot');
});

describe('getShareRequest', () => {
  it('returns row when actor is requester');
  it('returns row when actor is reviewer');
  it('returns {error:forbidden} when actor is neither');
  it('returns {error:not_found} for missing share_id');
});

describe('decideShareRequest', () => {
  it('approve memory: inserts org row, status→approved, promotion_result has promoted_memory_id, audit row links share_id');
  it('approve memory dedup: when org row exists, promotion_result.deduped=true, status still approves');
  it('reject memory: status→rejected, no DB row created');
  it('returns forbidden when actor != manager');
  it('returns already_decided when called twice on the same share_id');
  it('returns promotion_failed for kind=skill (not yet implemented)');
});

describe('withdrawShareRequest', () => {
  it('happy path: status→withdrawn');
  it('returns forbidden when actor != requester');
  it('returns already_decided after a previous approve/reject/withdraw');
});

describe('getShareCapabilities', () => {
  it('non-manager: is_manager=false, pending_inbox_count=0');
  it('manager: is_manager=true, count reflects pending rows where reviewer=actor');
  it('manager null: is_manager=false even if actor matches some username');
});
```

Each test uses helper `seedRequest(...)` and `seedMemory(...)` (the latter already exists in `memory-repo.test.ts` — extract to a shared `test/helpers.ts` if it's not already there, otherwise re-create locally).

- [ ] **Step 9: Run the suite**

```
cd hub/indexer && npm test -- share-repo
```
Expected: ~25 tests passing.

- [ ] **Step 10: Commit**

```
git add hub/indexer/src/share-repo.ts hub/indexer/test/share-repo.test.ts
git commit -m "feat(indexer): share-repo with submit/list/get/decide/withdraw/capabilities (memory kind)"
```

---

## Task 4: `share-api.ts` — six fastify routes

**Files:**
- Create: `hub/indexer/src/share-api.ts`
- Create: `hub/indexer/test/share-api.test.ts`

- [ ] **Step 1: Write the route file**

```ts
// share-api.ts
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type {
  submitShareRequest, listShareRequests, getShareRequest,
  decideShareRequest, withdrawShareRequest, getShareCapabilities,
} from './share-repo.js';

export interface ShareApiDeps {
  pool: Pool;
  manager: string | null;
  repo: {
    submitShareRequest:    typeof submitShareRequest;
    listShareRequests:     typeof listShareRequests;
    getShareRequest:       typeof getShareRequest;
    decideShareRequest:    typeof decideShareRequest;
    withdrawShareRequest:  typeof withdrawShareRequest;
    getShareCapabilities:  typeof getShareCapabilities;
  };
}

const SubmitBody = z.object({
  requester: z.string().min(1),
  kind:      z.enum(['memory', 'skill', 'folder']),
  ref:       z.string().min(1),
  note:      z.string().max(500).optional(),
});

const ListQuery = z.object({
  actor:  z.string().min(1),
  role:   z.enum(['outbox', 'inbox', 'all']),
  status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).optional(),
  limit:  z.coerce.number().int().positive().max(200).optional(),
  cursor: z.string().datetime().optional(),
});

const GetQuery        = z.object({ actor: z.string().min(1) });
const DecideBody      = z.object({
  actor:    z.string().min(1),
  decision: z.enum(['approve', 'reject']),
  comment:  z.string().max(2000).optional(),
});
const WithdrawBody    = z.object({ actor: z.string().min(1) });
const CapabilitiesQuery = z.object({ actor: z.string().min(1) });

export function buildShareApp(deps: ShareApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  // POST /share/submit
  app.post('/share/submit', async (req, reply) => {
    if (deps.manager === null) { reply.code(503); return { error: 'sharing disabled — no manager configured' }; }
    const p = SubmitBody.safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: 'validation failed', issues: p.error.issues }; }
    const r = await deps.repo.submitShareRequest({
      pool: deps.pool, manager: deps.manager,
      requester: p.data.requester, kind: p.data.kind, ref: p.data.ref, note: p.data.note,
    });
    if (!r.ok) {
      switch (r.reason) {
        case 'no_manager':      reply.code(503); return { error: 'sharing disabled' };
        case 'not_implemented': reply.code(501); return { error: `kind ${p.data.kind} not yet implemented` };
        case 'source_not_found':
        case 'forbidden':       reply.code(403); return { error: 'source not found or not owned by requester' };
        case 'invalid_ref':     reply.code(400); return { error: 'invalid ref' };
      }
    }
    return { share_id: r.share_id };
  });

  // GET /share/list
  app.get('/share/list', async (req, reply) => {
    const p = ListQuery.safeParse(req.query);
    if (!p.success) { reply.code(400); return { error: 'validation failed', issues: p.error.issues }; }
    return await deps.repo.listShareRequests({
      pool: deps.pool, actor: p.data.actor, manager: deps.manager,
      role: p.data.role, status: p.data.status, limit: p.data.limit, cursor: p.data.cursor,
    });
  });

  // GET /share/capabilities
  app.get('/share/capabilities', async (req, reply) => {
    const p = CapabilitiesQuery.safeParse(req.query);
    if (!p.success) { reply.code(400); return { error: 'validation failed', issues: p.error.issues }; }
    return await deps.repo.getShareCapabilities({
      pool: deps.pool, actor: p.data.actor, manager: deps.manager,
    });
  });

  // GET /share/:id  (must come AFTER literal /share/* routes per fastify radix-tree convention)
  app.get<{ Params: { id: string } }>('/share/:id', async (req, reply) => {
    const p = GetQuery.safeParse(req.query);
    if (!p.success) { reply.code(400); return { error: 'validation failed', issues: p.error.issues }; }
    const r = await deps.repo.getShareRequest({ pool: deps.pool, actor: p.data.actor, shareId: req.params.id });
    if ('error' in r) {
      if (r.error === 'not_found') { reply.code(404); return { error: 'share request not found' }; }
      if (r.error === 'forbidden') { reply.code(403); return { error: 'not the requester or reviewer' }; }
    }
    return r;
  });

  // POST /share/:id/decide
  app.post<{ Params: { id: string } }>('/share/:id/decide', async (req, reply) => {
    const p = DecideBody.safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: 'validation failed', issues: p.error.issues }; }
    const r = await deps.repo.decideShareRequest({
      pool: deps.pool, actor: p.data.actor, manager: deps.manager,
      shareId: req.params.id, decision: p.data.decision, comment: p.data.comment,
    });
    if (!r.ok) {
      switch (r.reason) {
        case 'not_found':        reply.code(404); return { error: 'share request not found' };
        case 'forbidden':        reply.code(403); return { error: 'not the manager' };
        case 'already_decided':  reply.code(409); return { error: `already ${r.detail}` };
        case 'promotion_failed': reply.code(422); return { error: r.detail ?? 'promotion failed' };
      }
    }
    return { ok: true, status: r.status, promotion_result: r.promotion_result };
  });

  // POST /share/:id/withdraw
  app.post<{ Params: { id: string } }>('/share/:id/withdraw', async (req, reply) => {
    const p = WithdrawBody.safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: 'validation failed', issues: p.error.issues }; }
    const r = await deps.repo.withdrawShareRequest({ pool: deps.pool, actor: p.data.actor, shareId: req.params.id });
    if (!r.ok) {
      switch (r.reason) {
        case 'not_found':       reply.code(404); return { error: 'share request not found' };
        case 'forbidden':       reply.code(403); return { error: 'not the requester' };
        case 'already_decided': reply.code(409); return { error: 'already decided' };
      }
    }
    return { ok: true, status: 'withdrawn' };
  });

  return app;
}
```

- [ ] **Step 2: Write the test suite** (`app.inject()` over stub repo deps)

Use the same factory shape as `memory-api.test.ts`:

```ts
function makeDeps() {
  const repo = {
    submitShareRequest:   vi.fn(async () => ({ ok: true, share_id: 'sid-1' })),
    listShareRequests:    vi.fn(async () => ({ items: [], next_cursor: null })),
    getShareRequest:      vi.fn(async () => ({ /* canned */ })),
    decideShareRequest:   vi.fn(async () => ({ ok: true, status: 'approved' })),
    withdrawShareRequest: vi.fn(async () => ({ ok: true })),
    getShareCapabilities: vi.fn(async () => ({ is_manager: true, manager_username: 'li86', pending_inbox_count: 3 })),
  };
  const deps: ShareApiDeps = { pool: {} as Pool, manager: 'li86', repo };
  return { deps, repo };
}
```

Cover one happy path + one validation failure + one error branch per route. Targeted assertions: status code, body shape, repo function called with the right args.

- [ ] **Step 3: Run tests**

```
cd hub/indexer && npm test -- share-api
```
Expected: ~20 tests passing.

- [ ] **Step 4: Commit**

```
git add hub/indexer/src/share-api.ts hub/indexer/test/share-api.test.ts
git commit -m "feat(indexer): share-api fastify routes for promotion queue"
```

---

## Task 5: Wire share-api into indexer + docker-compose env

**Files:**
- Modify: `hub/indexer/src/index.ts`
- Modify: `hub/docker-compose.yml`

- [ ] **Step 1: Wire `buildShareApp` alongside the existing memory-api**

The simplest approach: register `share-api`'s routes onto the same fastify instance (avoids running two HTTP servers / two ports). Edit `memory-api.ts`'s `buildApp` to take an optional `share` deps bag, OR — cleaner — register share routes directly in `index.ts` after `buildApp` returns:

```ts
// in hub/indexer/src/index.ts, after buildApp(...) line:
import { buildShareApp } from './share-api.js';
import {
  submitShareRequest, listShareRequests, getShareRequest,
  decideShareRequest, withdrawShareRequest, getShareCapabilities,
} from './share-repo.js';

// ...inside main(), replace the existing single `app.listen` with:
const shareApp = buildShareApp({
  pool,
  manager: cfg.memoryOrgManager,
  repo: {
    submitShareRequest, listShareRequests, getShareRequest,
    decideShareRequest, withdrawShareRequest, getShareCapabilities,
  },
});
// merge: register all shareApp routes onto memory `app` (fastify supports this via app.register).
await app.register(async (instance) => {
  for (const route of shareApp.printRoutes ? [] : []) { /* fastify lacks public copy API */ }
});
```

Actually fastify doesn't expose a clean route-copy API. Simpler: keep two separate `FastifyInstance`s, and start both on the same port via two `register` calls into a parent fastify. Easier still: use `app.register(buildShareRoutes)` where `buildShareRoutes` is a plugin function instead of `buildShareApp`. Refactor share-api:

```ts
// share-api.ts (final shape)
export function shareRoutesPlugin(deps: ShareApiDeps) {
  return async function (instance: FastifyInstance) {
    instance.post('/share/submit', /* ... */);
    instance.get('/share/list',    /* ... */);
    // ...
  };
}
```

Then in `index.ts`:

```ts
await app.register(shareRoutesPlugin({
  pool,
  manager: cfg.memoryOrgManager,
  repo: { submitShareRequest, listShareRequests, getShareRequest,
          decideShareRequest, withdrawShareRequest, getShareCapabilities },
}));
```

Update `share-api.test.ts` to use `Fastify().register(shareRoutesPlugin(deps))` for the same `app.inject()` shape as before — three lines of test setup change.

- [ ] **Step 2: Add the env to docker-compose**

```yaml
# hub/docker-compose.yml, indexer service
environment:
  ...
  MEMORY_ORG_MANAGER: li86
```

- [ ] **Step 3: Smoke-test on a running stack**

```
docker compose -f hub/docker-compose.yml build indexer && docker compose -f hub/docker-compose.yml up -d indexer
sleep 4
docker run --rm --network=claude-bioflow_bioflow-net curlimages/curl:latest -sS \
  "http://claude-bioflow-indexer:8400/share/capabilities?actor=li86"
# Expected: {"is_manager":true,"manager_username":"li86","pending_inbox_count":0}

docker run --rm --network=claude-bioflow_bioflow-net curlimages/curl:latest -sS \
  "http://claude-bioflow-indexer:8400/share/capabilities?actor=test1"
# Expected: {"is_manager":false,"manager_username":"li86","pending_inbox_count":0}
```

- [ ] **Step 4: Commit**

```
git add hub/indexer/src/index.ts hub/indexer/src/share-api.ts hub/indexer/test/share-api.test.ts hub/docker-compose.yml
git commit -m "feat(indexer): wire share-api plugin and MEMORY_ORG_MANAGER=li86 into docker-compose"
```

---

## Task 6: Adapter `share-rpc.ts` HTTP client

**Files:**
- Create: `adapter/src/share-rpc.ts`
- Create: `adapter/test/share-rpc.test.ts`
- Modify: `adapter/src/index.ts`

- [ ] **Step 1: Write the client** (mirror `memory-rpc.ts` pattern)

```ts
// adapter/src/share-rpc.ts
export class ShareRpcClient {
  private readonly timeoutMs = 5000;
  constructor(private baseUrl: string, private username: string) {}

  async submit(p: { kind: 'memory'|'skill'|'folder'; ref: string; note?: string }): Promise<unknown> {
    return this.post('/share/submit', { requester: this.username, ...p });
  }
  async list(qs: { role: 'outbox'|'inbox'|'all'; status?: string; limit?: number; cursor?: string }): Promise<unknown> {
    return this.fetchJson('/share/list', { actor: this.username, ...qs });
  }
  async get(id: string): Promise<unknown> {
    return this.fetchJson(`/share/${encodeURIComponent(id)}`, { actor: this.username });
  }
  async decide(id: string, p: { decision: 'approve'|'reject'; comment?: string }): Promise<unknown> {
    return this.post(`/share/${encodeURIComponent(id)}/decide`, { actor: this.username, ...p });
  }
  async withdraw(id: string): Promise<unknown> {
    return this.post(`/share/${encodeURIComponent(id)}/withdraw`, { actor: this.username });
  }
  async capabilities(): Promise<unknown> {
    return this.fetchJson('/share/capabilities', { actor: this.username });
  }

  // private helpers identical to memory-rpc.ts (fetchJson, post, buildUrl)
}
```

- [ ] **Step 2: Write tests** (stub HTTP server pattern from `memory-rpc.test.ts`)

Cover each method: assert URL path, method, query/body shape, error pass-through (HTTP 4xx surfaces as thrown Error).

- [ ] **Step 3: Wire into `adapter/src/index.ts`**

```ts
import { ShareRpcClient } from './share-rpc.js';
const share = new ShareRpcClient(MEMORY_API_URL, USERNAME);
// pass into RpcRouter alongside the existing `memory: MemoryRpcClient`:
const router = new RpcRouter({ ..., share });
```

- [ ] **Step 4: Run tests + commit**

```
cd adapter && npm test -- share-rpc
git add adapter/src/share-rpc.ts adapter/test/share-rpc.test.ts adapter/src/index.ts
git commit -m "feat(adapter): ShareRpcClient HTTP wrapper for share-api"
```

---

## Task 7: Adapter `rpc.ts` — six `share_*` cases

**Files:**
- Modify: `adapter/src/rpc.ts`
- Create: `adapter/test/rpc-share.test.ts`

- [ ] **Step 1: Extend `RpcRouterDeps`**

Add `share?: ShareRpcClient` to the deps interface alongside the existing `memory?:`.

- [ ] **Step 2: Add six dispatch cases in `dispatchInner`**

```ts
case 'share_submit': {
  if (!this.deps.share) throw new Error('share api not configured');
  const res = await this.deps.share.submit(params as Parameters<ShareRpcClient['submit']>[0]);
  return { success: true, ...(res as object) };
}
case 'share_list': {
  if (!this.deps.share) throw new Error('share api not configured');
  const res = await this.deps.share.list(params as Parameters<ShareRpcClient['list']>[0]);
  return { success: true, ...(res as object) };
}
case 'share_get': {
  if (!this.deps.share) throw new Error('share api not configured');
  const res = await this.deps.share.get(params.share_id as string);
  return { success: true, share: res };
}
case 'share_decide': {
  if (!this.deps.share) throw new Error('share api not configured');
  const { share_id, ...body } = params as { share_id: string; decision: 'approve'|'reject'; comment?: string };
  const res = await this.deps.share.decide(share_id, body);
  return { success: true, ...(res as object) };
}
case 'share_withdraw': {
  if (!this.deps.share) throw new Error('share api not configured');
  const res = await this.deps.share.withdraw(params.share_id as string);
  return { success: true, ...(res as object) };
}
case 'share_capabilities': {
  if (!this.deps.share) throw new Error('share api not configured');
  const res = await this.deps.share.capabilities();
  return { success: true, ...(res as object) };
}
```

- [ ] **Step 3: Write `rpc-share.test.ts`** (six smoke tests with stub `ShareRpcClient`)

- [ ] **Step 4: Run + commit**

```
cd adapter && npm test -- rpc-share
git add adapter/src/rpc.ts adapter/test/rpc-share.test.ts
git commit -m "feat(adapter): six share_* NATS RPC dispatch cases"
```

---

## Task 8: Frontend types + service + Pinia store

**Files:**
- Create: `frontend/src/types/share.ts`
- Create: `frontend/src/services/share.ts`
- Create: `frontend/src/stores/share.ts`

- [ ] **Step 1: Write types**

```ts
// frontend/src/types/share.ts
export type ArtifactKind = 'memory' | 'skill' | 'folder';
export type ShareStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface ShareRequest {
  share_id: string;
  artifact_kind: ArtifactKind;
  artifact_ref: string;
  snapshot_meta: Record<string, unknown>;  // shape varies by kind; memory: {name,description,body,type,source,hit_count,last_hit_at,facets}
  requester: string;
  reviewer: string;
  status: ShareStatus;
  requester_note: string | null;
  review_comment: string | null;
  promotion_result: Record<string, unknown> | null;
  created_at: string;
  decided_at: string | null;
}

export interface ShareCapabilities {
  is_manager: boolean;
  manager_username: string | null;
  pending_inbox_count: number;
}
```

- [ ] **Step 2: Write the service** (mirrors `services/memory.ts`)

```ts
import { natsService } from './nats';
import type { ShareRequest, ShareCapabilities, ArtifactKind, ShareStatus } from '@/types/share';

export const shareService = {
  submit:       async (p: { kind: ArtifactKind; ref: string; note?: string }) =>
    await natsService.invoke('share_submit', p as Record<string, unknown>) as { success: true; share_id: string },
  list:         async (q: { role: 'outbox'|'inbox'|'all'; status?: ShareStatus; limit?: number; cursor?: string }) =>
    await natsService.invoke('share_list', q as Record<string, unknown>) as { success: true; items: ShareRequest[]; next_cursor: string | null },
  get:          async (id: string) => {
    const r = await natsService.invoke('share_get', { share_id: id }) as { success: true; share: ShareRequest };
    return r.share;
  },
  decide:       async (id: string, p: { decision: 'approve'|'reject'; comment?: string }) =>
    await natsService.invoke('share_decide', { share_id: id, ...p }) as { success: true; status: ShareStatus; promotion_result?: Record<string, unknown> },
  withdraw:     async (id: string) =>
    await natsService.invoke('share_withdraw', { share_id: id }) as { success: true; status: ShareStatus },
  capabilities: async () =>
    await natsService.invoke('share_capabilities', {}) as { success: true } & ShareCapabilities,
} as const;
```

- [ ] **Step 3: Write the Pinia store**

```ts
// frontend/src/stores/share.ts
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { shareService } from '@/services/share';
import type { ShareRequest, ShareCapabilities } from '@/types/share';

export const useShareStore = defineStore('share', () => {
  const items = ref<ShareRequest[]>([]);
  const cursor = ref<string | null>(null);
  const view = ref<'outbox' | 'inbox'>('outbox');
  const loading = ref(false);
  const error = ref<string | null>(null);
  const selected = ref<ShareRequest | null>(null);
  const capabilities = ref<ShareCapabilities>({ is_manager: false, manager_username: null, pending_inbox_count: 0 });

  async function loadCapabilities() {
    try { const c = await shareService.capabilities(); capabilities.value = { is_manager: c.is_manager, manager_username: c.manager_username, pending_inbox_count: c.pending_inbox_count }; } catch (e) { error.value = (e as Error).message; }
  }

  async function loadFirstPage() {
    loading.value = true; cursor.value = null; error.value = null;
    try { const r = await shareService.list({ role: view.value }); items.value = r.items; cursor.value = r.next_cursor; }
    catch (e) { error.value = (e as Error).message; items.value = []; }
    finally { loading.value = false; }
  }

  async function setView(v: 'outbox' | 'inbox') { view.value = v; await loadFirstPage(); }
  async function select(id: string) { try { selected.value = await shareService.get(id); } catch (e) { error.value = (e as Error).message; } }

  async function submit(p: { kind: 'memory'|'skill'|'folder'; ref: string; note?: string }) {
    await shareService.submit(p);
    if (view.value === 'outbox') await loadFirstPage();
    await loadCapabilities();  // refresh inbox count if I'm the manager
  }
  async function decide(id: string, p: { decision: 'approve'|'reject'; comment?: string }) {
    await shareService.decide(id, p);
    if (selected.value?.share_id === id) await select(id);
    await loadFirstPage();
    await loadCapabilities();
  }
  async function withdraw(id: string) {
    await shareService.withdraw(id);
    if (selected.value?.share_id === id) await select(id);
    await loadFirstPage();
  }

  return { items, cursor, view, loading, error, selected, capabilities,
           loadCapabilities, loadFirstPage, setView, select, submit, decide, withdraw };
});
```

- [ ] **Step 4: Commit** (no tests for these scaffolding files; component tests exercise them in subsequent tasks)

```
git add frontend/src/types/share.ts frontend/src/services/share.ts frontend/src/stores/share.ts
git commit -m "feat(frontend): share types, service, and Pinia store"
```

---

## Task 9: `SharePanel.vue` + `ShareList.vue` + `ShareDetail.vue`

**Files:**
- Create: `frontend/src/components/share/SharePanel.vue`
- Create: `frontend/src/components/share/ShareList.vue`
- Create: `frontend/src/components/share/ShareDetail.vue`

- [ ] **Step 1: `SharePanel.vue`** — top-level layout, mirror `MemoryPanel.vue`'s vertical split

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useShareStore } from '@/stores/share'
import ShareList from './ShareList.vue'
import ShareDetail from './ShareDetail.vue'

const store = useShareStore()
const splitPercent = ref<number>(40)

onMounted(async () => {
  await store.loadCapabilities()
  await store.loadFirstPage()
})

async function setView(v: 'outbox' | 'inbox') { await store.setView(v) }
</script>

<template>
  <div class="share-panel">
    <div class="panel-header">
      <div class="filter-row">
        <button class="scope-tab" :class="{ active: store.view === 'outbox' }" @click="setView('outbox')">Outbox</button>
        <button v-if="store.capabilities.is_manager" class="scope-tab"
                :class="{ active: store.view === 'inbox' }" @click="setView('inbox')">
          Inbox<span v-if="store.capabilities.pending_inbox_count > 0"> ({{ store.capabilities.pending_inbox_count }})</span>
        </button>
      </div>
    </div>
    <div class="split-body">
      <div class="split-pane pane-list" :style="{ height: splitPercent + '%' }">
        <ShareList class="pane-fill" />
      </div>
      <div class="split-resizer" />
      <div class="split-pane pane-detail">
        <ShareDetail class="pane-fill" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Reuse MemoryPanel's CSS variables; copy the panel-header / scope-tab / split styles
   from MemoryPanel.vue verbatim — they're already factored against design tokens. */
</style>
```

(The CSS block is the same as `MemoryPanel.vue`'s scoped styles minus the source-chip + deleted-checkbox blocks. Copy verbatim, drop the irrelevant rules.)

- [ ] **Step 2: `ShareList.vue`** — list rows with kind icon + status pill

```vue
<script setup lang="ts">
import { useShareStore } from '@/stores/share'

const store = useShareStore()

function kindIcon(k: string): string {
  return k === 'memory' ? '◍' : k === 'skill' ? '◑' : '◐'
}

function statusClass(s: string): string {
  return s === 'pending' ? 'status-pending'
       : s === 'approved' ? 'status-approved'
       : s === 'rejected' ? 'status-rejected'
       : 'status-withdrawn'
}

function relTime(iso: string): string {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}
</script>

<template>
  <div class="share-list">
    <div v-if="store.error" class="error-banner">{{ store.error }}</div>
    <div class="list-scroll">
      <div v-if="store.items.length === 0 && !store.loading" class="empty">
        <p class="empty-title">{{ store.view === 'inbox' ? 'No pending requests' : 'You have not submitted any share requests' }}</p>
      </div>
      <button v-for="item in store.items" :key="item.share_id" class="share-row"
              :class="{ selected: store.selected?.share_id === item.share_id }"
              @click="store.select(item.share_id)">
        <div class="row-main">
          <span class="row-kind">{{ kindIcon(item.artifact_kind) }}</span>
          <span class="row-name">{{ item.artifact_kind === 'memory' ? (item.snapshot_meta as any).name : item.artifact_ref }}</span>
          <span class="row-time">{{ relTime(item.created_at) }}</span>
        </div>
        <div class="row-sub">
          <span class="row-meta">{{ store.view === 'outbox' ? `→ ${item.reviewer}` : `← ${item.requester}` }}</span>
          <span class="badge" :class="statusClass(item.status)">{{ item.status }}</span>
        </div>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Mirror MemoryList.vue's row styles. Status pill colors:
   pending=accent, approved=success, rejected=danger, withdrawn=muted. */
</style>
```

- [ ] **Step 3: `ShareDetail.vue`** — header + memory snapshot preview + action bar

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { useShareStore } from '@/stores/share'

const store = useShareStore()
const comment = ref('')

async function approve() {
  if (!store.selected) return
  await store.decide(store.selected.share_id, { decision: 'approve', comment: comment.value || undefined })
  comment.value = ''
}
async function reject() {
  if (!store.selected) return
  if (!comment.value) { if (!confirm('Reject without a comment?')) return }
  await store.decide(store.selected.share_id, { decision: 'reject', comment: comment.value || undefined })
  comment.value = ''
}
async function withdraw() {
  if (!store.selected) return
  if (!confirm('Withdraw this share request?')) return
  await store.withdraw(store.selected.share_id)
}
</script>

<template>
  <div v-if="!store.selected" class="empty-state"><span>Select a request to inspect</span></div>
  <div v-else class="share-detail">
    <div class="detail-scroll">
      <div class="detail-header">
        <h2>{{ store.selected.artifact_kind === 'memory' ? (store.selected.snapshot_meta as any).name : store.selected.artifact_ref }}</h2>
        <p class="meta">
          <span class="badge" :class="`status-${store.selected.status}`">{{ store.selected.status }}</span>
          <span>· {{ store.selected.artifact_kind }}</span>
          <span>· requested by {{ store.selected.requester }}</span>
          <span>· reviewer {{ store.selected.reviewer }}</span>
        </p>
        <p v-if="store.selected.requester_note" class="note">"{{ store.selected.requester_note }}"</p>
      </div>

      <!-- memory snapshot preview -->
      <section v-if="store.selected.artifact_kind === 'memory'" class="detail-section">
        <h3>Snapshot</h3>
        <p class="memory-desc">{{ (store.selected.snapshot_meta as any).description }}</p>
        <p class="snapshot-meta-line">
          <span>type: {{ (store.selected.snapshot_meta as any).type }}</span>
          <span>· source: {{ (store.selected.snapshot_meta as any).source }}</span>
          <span>· hit_count: {{ (store.selected.snapshot_meta as any).hit_count }}</span>
        </p>
        <pre class="memory-body">{{ (store.selected.snapshot_meta as any).body }}</pre>
      </section>

      <!-- decision (terminal states) -->
      <section v-if="store.selected.review_comment" class="detail-section">
        <h3>Review comment</h3>
        <p class="note">{{ store.selected.review_comment }}</p>
      </section>
    </div>

    <!-- action bar -->
    <div class="action-bar">
      <textarea v-if="store.selected.status === 'pending' && store.capabilities.is_manager"
                v-model="comment" placeholder="Comment (required for reject)" class="comment-box" />
      <button v-if="store.selected.status === 'pending' && store.capabilities.is_manager"
              class="btn-primary" @click="approve">Approve</button>
      <button v-if="store.selected.status === 'pending' && store.capabilities.is_manager"
              class="btn-danger" @click="reject">Reject</button>
      <button v-if="store.selected.status === 'pending' && store.selected.requester === store.capabilities.manager_username"
              class="btn-secondary" @click="withdraw">Withdraw</button>
      <!-- requester sees Withdraw too: needs the actor != manager check; in v1 we identify "requester is me" by checking
           the row's requester against the local actor — but the frontend doesn't carry actor. Workaround: put
           the actor's username in the capabilities response for client-side comparison. (Add to share-repo
           getShareCapabilities + types in Task 8 if not already.) Use store.capabilities.actor_username here. -->
    </div>
  </div>
</template>
```

NOTE the comment in step 3: we need `actor_username` on `ShareCapabilities` so the frontend can render the Withdraw button only when `selected.requester === actor`. Add the field:

- `getShareCapabilities` in `share-repo.ts` (Task 3) returns `{ is_manager, manager_username, pending_inbox_count, actor_username: actor }`.
- `ShareApiDeps` test stub returns it.
- `frontend/src/types/share.ts` (Task 8) adds `actor_username: string` to `ShareCapabilities`.
- The store's `capabilities` ref carries it.

If Task 3 is already committed, this is a quick follow-up commit. The plan reviewer should call this out during the Task 3 review and have it included before commit.

- [ ] **Step 4: Run dev server and visually verify in browser**

```
cd frontend && npm run dev  # opens on http://localhost:5173
# Open the panel (no entry point yet — manually navigate by setting localStorage rightPanel=share, see Task 11)
```
Visually: empty panel renders, no errors in console. Real submit flow tested in Task 10.

- [ ] **Step 5: Commit**

```
git add frontend/src/components/share/
git commit -m "feat(frontend): SharePanel/List/Detail components for promotion queue UI"
```

---

## Task 10: MemoryDetail Share button + submit modal

**Files:**
- Modify: `frontend/src/components/memory/MemoryDetail.vue`

- [ ] **Step 1: Add the Share button + modal**

In MemoryDetail.vue's `<script setup>` block, add:

```ts
import { useShareStore } from '@/stores/share'
const shareStore = useShareStore()
const showShareModal = ref(false)
const shareNote = ref('')

async function handleShare() {
  if (!store.selected) return
  if (store.selected.source !== 'user' && store.selected.source !== 'distilled') return
  showShareModal.value = true
  shareNote.value = ''
}

async function submitShare() {
  if (!store.selected) return
  await shareStore.submit({ kind: 'memory', ref: store.selected.memory_id, note: shareNote.value || undefined })
  showShareModal.value = false
  // Toast or visible feedback — for v1 just close. The Outbox in Share panel will show it.
}
```

In the action bar template, between Edit and Forget:

```vue
<button
  class="btn-action"
  :disabled="store.selected.deleted_at !== null"
  :title="store.selected.deleted_at !== null ? 'Cannot share a deleted memory.' : 'Share with the org for review'"
  @click="handleShare"
>Share</button>
```

Add the modal at the bottom of the `<template>`, outside `.memory-detail`:

```vue
<div v-if="showShareModal" class="modal-overlay" @click.self="showShareModal = false">
  <div class="modal">
    <h3>Share with the org?</h3>
    <p>This sends the memory to <strong>{{ shareStore.capabilities.manager_username }}</strong> for review. You can withdraw while it's pending.</p>
    <textarea v-model="shareNote" placeholder="Optional: why is this worth sharing?" maxlength="500" class="modal-textarea" />
    <div class="modal-actions">
      <button class="btn-secondary" @click="showShareModal = false">Cancel</button>
      <button class="btn-primary" @click="submitShare">Submit</button>
    </div>
  </div>
</div>
```

Add minimal modal styles or reuse design-token styles already in the project.

- [ ] **Step 2: Manual verification**

Restart dev server. From the Memory panel: select a user-authored row → click Share → fill note → Submit. Modal closes. Open Share panel (next task wires the entry point). Verify the row shows in Outbox with status=pending.

- [ ] **Step 3: Commit**

```
git add frontend/src/components/memory/MemoryDetail.vue
git commit -m "feat(frontend): Share button + submit modal on MemoryDetail"
```

---

## Task 11: MainLayout — Share tab integration with badge

**Files:**
- Modify: `frontend/src/components/layout/MainLayout.vue`

- [ ] **Step 1: Add `'share'` to `RightPanel` union**

```ts
type RightPanel = 'files' | 'notebook' | 'agents' | 'memory' | 'share'
```

- [ ] **Step 2: Import `useShareStore` for the badge**

```ts
import { useShareStore } from '@/stores/share'
const shareStore = useShareStore()
onMounted(() => { shareStore.loadCapabilities() })
```

- [ ] **Step 3: Add the toolbar button + render branch**

In the right-panel toolbar (alongside Memory, Files, etc.):

```vue
<button class="panel-tab" :class="{ active: rightPanel === 'share' }" @click="rightPanel = 'share'" :title="'Share with the org'">
  Share<span v-if="shareStore.capabilities.is_manager && shareStore.capabilities.pending_inbox_count > 0"
            class="badge-count">{{ shareStore.capabilities.pending_inbox_count }}</span>
</button>
```

In the panel render switch:

```vue
<SharePanel v-else-if="rightPanel === 'share'" />
```

Add the `<script>` import:

```ts
import SharePanel from '@/components/share/SharePanel.vue'
```

Add the badge style:

```css
.badge-count {
  margin-left: 4px;
  background: var(--accent);
  color: white;
  border-radius: var(--radius-pill);
  padding: 0 6px;
  font-size: var(--text-2xs);
  font-weight: var(--fw-semi);
}
```

- [ ] **Step 4: Manual end-to-end smoke test**

```
# As li86 (manager): open chat, no badge initially.
# As test1 (non-manager): open Memory → select user row → Share → submit.
# Switch to li86: Share tab now shows "Share (1)" badge.
# Click Share tab → Inbox tab → click the request → Approve with comment "good".
# Refresh: Org tab in Memory panel shows the promoted row with username='__org__'.
# As test1: open Memory → Org tab → row appears.
```

- [ ] **Step 5: Final commit**

```
git add frontend/src/components/layout/MainLayout.vue
git commit -m "feat(frontend): Share tab with manager badge in MainLayout"
```

---

## Final review

After all 11 tasks:

- [ ] Run the full indexer test suite: `cd hub/indexer && npm test` — expect 240+ tests passing (220 existing + ~25 share-repo + ~20 share-api).
- [ ] Run the adapter test suite: `cd adapter && npm test` — expect existing count + ~15 new (share-rpc + rpc-share).
- [ ] Frontend build clean: `cd frontend && npm run build` — no TS errors, dist/ regenerates.
- [ ] Hit the four production users (li86 + test1/2/3) in the live stack, do the Task 11 step 4 end-to-end manually.
- [ ] Update `docs/QA_log.md` only if a learning-oriented question came up during implementation (per CLAUDE.md §3).
- [ ] Memory: do NOT save a feedback memory about this work — the change is in code and self-documenting; per `feedback_no_overdesign.md` and the auto-memory exclusion list.

When all green: dispatch the final `superpowers:code-reviewer` agent with scope = "phase 1 share-promotion implementation, see plan and spec." Land the merge to main, recreate the four user containers (`hub/scripts/recreate-user.sh <user>`), tag a snapshot commit message identifying phase 1 complete.

---

## Appendix: rough timing

| Task | Est | Notes |
|---|---:|---|
| 1 migration | 30m | one SQL file, one smoke test |
| 2 config | 15m | 3 lines + 3 tests |
| 3 share-repo | 2h | the bulk; six functions + ~25 tests |
| 4 share-api | 1h | six routes + ~20 tests |
| 5 wire + compose | 30m | plugin refactor of share-api + smoke curl |
| 6 share-rpc client | 45m | identical pattern to memory-rpc |
| 7 rpc dispatch | 30m | six cases + tests |
| 8 frontend types/service/store | 45m | scaffolding |
| 9 SharePanel/List/Detail | 1.5h | three components, copy MemoryPanel CSS |
| 10 MemoryDetail Share button | 30m | one button + modal |
| 11 MainLayout integration | 30m | tab + badge + smoke test |
| **Total** | **~9h** | one focused day |

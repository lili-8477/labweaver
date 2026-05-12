# Share-promotion — update-existing-skill kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Today an org skill at `shared/skills/<name>/` is one-shot: if it exists, a `kind=skill` submission with the same `<name>` returns HTTP 422 collision — the manager has to reject with a rename suggestion. There's no path to ship `single-cell v2` as a replacement for an existing `single-cell v1` except direct file edits by an operator. This slice adds a new artifact kind `skill_update` whose approve path atomically replaces the existing dir on disk.

**Architecture:**

1. **New artifact kind `skill_update`** (migration 0012 updates the CHECK constraint on `share_requests.artifact_kind`). Distinct from `skill` so the UI, analytics, and audit can tell apart "new skill install" from "atomic replace of existing skill".
2. **Submit validation:** source is the requester's `~/.claude/skills/<name>/` (same as `skill`). Target `shared/skills/<name>/` MUST EXIST — otherwise the user should submit a fresh `kind=skill` instead. New reason: `target_not_found`.
3. **Approve atomic replace** in `share-fs.ts`'s new helper `atomicReplaceSkillDir({srcTar, sharedSkillsDir, name})`:
   - Untar to `<sharedSkillsDir>/.<name>.new.<share_id>/`
   - Rename existing `<sharedSkillsDir>/<name>/` → `<sharedSkillsDir>/.<name>.old.<share_id>/`
   - Rename `.new.<share_id>` → `<name>/`
   - Delete `.old.<share_id>/`
   - On any rename failure: best-effort restore from `.old`, leave the .new for next admin's manual cleanup.
4. **Frontend** offers "Submit update" from SkillsPanel when the user's `~/.claude/skills/<name>/` collides with an existing org skill. Adds a new NATS RPC `org_skills_list` that enumerates `~/.claude/skills-shared/` so the panel knows the collision set.
5. **Spec coverage:** §2 non-goals row marked this as "v2" deferred. This slice is that v2.

**Out of scope:**
- Cross-tenant or per-user manager-of-updates (multi-manager is N-of-1 and applies uniformly).
- Version history: the replaced files are deleted, not archived. A `share_requests` row exists for forensic reference (the snapshot tarball survives the standard 30-day TTL). To "view what was replaced" you query that row.
- Diff UI showing old vs new content. Manager reviews the new content as-is; comparing to the existing `shared/skills/<name>/` is left as a future enhancement.
- Skill _removal_ ("retire this skill"). Out of scope; admin edits files directly.
- A separate `decided_at + N` cooldown on consecutive replacements. Each submission is independent.

---

## File Structure

**Created:**
- `hub/indexer/migrations/0012_share_artifact_kind_skill_update.sql` — adds `'skill_update'` to the artifact_kind CHECK constraint.
- `hub/indexer/test/migrations-0012-smoke.test.ts` — testcontainers smoke.
- `adapter/src/org-skills-rpc.ts` — `listOrgSkills(workspaceRoot)` enumerating `<workspaceRoot>/shared/skills/<name>/SKILL.md` for the new RPC. Mirrors `skills-rpc.ts` shape.
- `adapter/test/org-skills-rpc.test.ts` — 3 tests (missing dir → [], lists dirs with SKILL.md, descriptions parsed from frontmatter).

**Modified (backend):**
- `hub/indexer/src/share-repo.ts` — extend `ArtifactKind` union; route `kind === 'skill_update'` to a new helper; map a new `target_not_found` reason.
- `hub/indexer/src/share-repo-skill.ts` — add `submitSkillUpdateShareRequest` and `approveSkillUpdateShareRequest`. Both reuse phase-2 helpers (`walkSkillFiles`, `packSkillTarball`, etc.) and the new atomic-replace helper.
- `hub/indexer/src/share-fs.ts` — add `atomicReplaceSkillDir` helper.
- `hub/indexer/test/share-fs.test.ts` — 4-5 tests for the new helper (round-trip replace, leaves no .old, ENOENT-target handled, restore-on-failure best effort).
- `hub/indexer/test/share-repo.test.ts` — extend test suite with `skill_update` submit + approve cases (~6 tests).
- `hub/indexer/src/share-api.ts` — extend the Zod enum on `submit` route's `kind` param; map the new `target_not_found` reason to HTTP 404.
- `hub/indexer/test/share-api.test.ts` — 1 new test for the 404 mapping.
- `hub/indexer/src/share-cleanup.ts` — extend the SQL filter to include `'skill_update'` so its tarballs also age out at 30 days post-decision.
- `hub/indexer/test/share-cleanup.test.ts` — 1 new test for `'skill_update'` cleanup.

**Modified (adapter):**
- `adapter/src/rpc.ts` — register `org_skills_list` dispatch case.
- `adapter/test/rpc.test.ts` (or wherever dispatch is tested) — 1 new test.
- `adapter/src/index.ts` — wire the new helper if any new env vars are needed (probably none — `workspaceRoot` is already available).

**Modified (frontend):**
- `frontend/src/types/share.ts` — extend `ArtifactKind` with `'skill_update'`.
- `frontend/src/types/skills.ts` — no change (SkillSummary stays the same shape).
- `frontend/src/services/skills.ts` — add `listOrg()` method calling the new RPC.
- `frontend/src/stores/skills.ts` — track org skill set + add `submitUpdate(name, note?)` action.
- `frontend/src/components/skills/SkillRow.vue` — when user's skill name collides with an org skill, show "Submit update" instead of "Share"; modal text mentions atomic replace.
- `frontend/src/components/skills/SkillsPanel.vue` — load org skills alongside user skills on mount.
- `frontend/src/components/share/ShareDetail.vue` — when `artifact_kind === 'skill_update'`, badge as "skill update" instead of just "skill".

---

## Task 1: Migration 0012 + type/enum extensions

**Files:**
- Create: `hub/indexer/migrations/0012_share_artifact_kind_skill_update.sql`
- Create: `hub/indexer/test/migrations-0012-smoke.test.ts`
- Modify: `hub/indexer/src/share-repo.ts` (extend `ArtifactKind`)
- Modify: `hub/indexer/src/share-api.ts` (extend submit Zod enum + snapshot/file kind gate)
- Modify: `hub/indexer/src/share-cleanup.ts` (extend SQL filter to include skill_update)
- Modify: `hub/indexer/test/share-cleanup.test.ts` (1 new test)
- Modify: `frontend/src/types/share.ts` (extend `ArtifactKind`)

- [ ] **Step 1: Write the migration**

`hub/indexer/migrations/0012_share_artifact_kind_skill_update.sql`:

```sql
-- 0012_share_artifact_kind_skill_update.sql
-- Add 'skill_update' to share_requests.artifact_kind. Distinct from 'skill'
-- so we can tell apart "new skill install" from "atomic replace of an existing
-- org skill". See phase-4 update-existing-skill plan.

ALTER TABLE share_requests
  DROP CONSTRAINT share_requests_artifact_kind_check;

ALTER TABLE share_requests
  ADD CONSTRAINT share_requests_artifact_kind_check
  CHECK (artifact_kind IN ('memory', 'skill', 'folder', 'skill_update'));
```

- [ ] **Step 2: Write the migration smoke test**

`hub/indexer/test/migrations-0012-smoke.test.ts` — mirror `migrations-0011-smoke.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('migration 0012 share artifact_kind skill_update', () => {
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

  it('accepts skill_update kind', async () => {
    const r = await pool.query(
      `INSERT INTO share_requests (artifact_kind, artifact_ref, snapshot_meta,
                                   requester, reviewer)
       VALUES ('skill_update', 'x', '{}'::jsonb, 'alice', 'li86')
       RETURNING share_id`,
    );
    expect(r.rowCount).toBe(1);
  });

  it('still rejects garbage kind', async () => {
    await expect(pool.query(
      `INSERT INTO share_requests (artifact_kind, artifact_ref, snapshot_meta,
                                   requester, reviewer)
       VALUES ('frobnitz', 'x', '{}'::jsonb, 'alice', 'li86')`,
    )).rejects.toThrow(/share_requests_artifact_kind_check/);
  });
});
```

- [ ] **Step 3: Extend `ArtifactKind` types and Zod enums**

In `hub/indexer/src/share-repo.ts`, change:

```ts
export type ArtifactKind = "memory" | "skill" | "folder";
```

to:

```ts
export type ArtifactKind = "memory" | "skill" | "folder" | "skill_update";
```

In `hub/indexer/src/share-api.ts`, the submit route's `kind` Zod enum:

```ts
kind: z.enum(['memory', 'skill', 'folder']),
```

→

```ts
kind: z.enum(['memory', 'skill', 'folder', 'skill_update']),
```

Same file, the snapshot/file route's kind gate:

```ts
if (got.artifact_kind !== 'skill' && got.artifact_kind !== 'folder') {
```

→

```ts
if (got.artifact_kind !== 'skill' && got.artifact_kind !== 'folder' && got.artifact_kind !== 'skill_update') {
```

(skill_update tarballs are reachable through the same snapshot/file route for manager preview.)

In `hub/indexer/src/share-cleanup.ts`, the SQL filter:

```ts
WHERE artifact_kind IN ('skill', 'folder')
```

→

```ts
WHERE artifact_kind IN ('skill', 'folder', 'skill_update')
```

(skill_update produces a tarball at submit just like skill — same cleanup rules apply.)

In `frontend/src/types/share.ts`:

```ts
export type ArtifactKind = 'memory' | 'skill' | 'folder';
```

→

```ts
export type ArtifactKind = 'memory' | 'skill' | 'folder' | 'skill_update';
```

- [ ] **Step 4: Add one share-cleanup test for skill_update**

In `hub/indexer/test/share-cleanup.test.ts`, inside the `cleanupOldSnapshots` describe, add a new test:

```ts
it("cleans skill_update tarballs (treated like skill+folder)", async () => {
  const id = await seedRow({ kind: 'skill_update' as any, decidedDaysAgo: 60, withTarball: true });
  const r = await cleanupOldSnapshots({ pool, snapshotsDir, ttlDays: 30 });
  expect(r).toMatchObject({ deleted: 1 });
  // Tarball is gone.
});
```

The `as any` cast is because the existing test helper's `kind` param type is narrower than the actual DB enum after migration 0012; widen the helper's type at the same time:

In the `seedRow` helper, change:

```ts
kind: 'skill' | 'folder' | 'memory';
```

→

```ts
kind: 'skill' | 'folder' | 'memory' | 'skill_update';
```

(Then the `as any` cast in the new test can be removed.)

- [ ] **Step 5: Run tests**

```
cd /home/lili/claude-bioflow/hub/indexer && npm test -- migrations-0012 share-cleanup
cd /home/lili/claude-bioflow/frontend && npm run build
```

Expected: 2 new migration tests + the new cleanup test pass; existing cleanup tests still pass; frontend build clean.

- [ ] **Step 6: Commit**

```
git -C /home/lili/claude-bioflow add \
  hub/indexer/migrations/0012_share_artifact_kind_skill_update.sql \
  hub/indexer/test/migrations-0012-smoke.test.ts \
  hub/indexer/src/share-repo.ts \
  hub/indexer/src/share-api.ts \
  hub/indexer/src/share-cleanup.ts \
  hub/indexer/test/share-cleanup.test.ts \
  frontend/src/types/share.ts
git -C /home/lili/claude-bioflow commit -m "feat(indexer): add skill_update artifact_kind via migration 0012"
```

No `Co-Authored-By` trailer.

---

## Task 2: `share-fs.atomicReplaceSkillDir` helper + tests

**Files:**
- Modify: `hub/indexer/src/share-fs.ts`
- Modify: `hub/indexer/test/share-fs.test.ts`

- [ ] **Step 1: Implement the helper**

Append after `extractSkillTarball` in `hub/indexer/src/share-fs.ts`:

```ts
import { rename, rm as rmFs } from "node:fs/promises";  // augment existing import

/** Atomically replace a directory under `sharedSkillsDir` with the contents of
 *  `srcTar`. The replace is done via untar-to-sibling + rename-swap:
 *
 *    1. untar to <sharedSkillsDir>/.<name>.new.<shareId>/
 *    2. rename <sharedSkillsDir>/<name>/ → <sharedSkillsDir>/.<name>.old.<shareId>/
 *    3. rename <sharedSkillsDir>/.<name>.new.<shareId>/ → <sharedSkillsDir>/<name>/
 *    4. rm -rf <sharedSkillsDir>/.<name>.old.<shareId>/
 *
 *  There is a window between steps 2 and 3 (a few milliseconds at most) where
 *  the target name does not exist. Any read of <name> in that window gets
 *  ENOENT — acceptable for the use case (single-tenant indexer, skill files
 *  read lazily by Claude Code on tool registration).
 *
 *  On failure between steps 2 and 3, we best-effort restore from .old. The
 *  .new dir is left in place for manual cleanup.
 *
 *  Returns the list of paths inside the new target (relative to <name>/). */
export async function atomicReplaceSkillDir(opts: {
  srcTar:           string;
  sharedSkillsDir:  string;
  name:             string;     // skill folder basename (already path-safe — caller used safeJoin)
  shareId:          string;     // for temp-dir naming
}): Promise<string[]> {
  const newDir = path.join(opts.sharedSkillsDir, `.${opts.name}.new.${opts.shareId}`);
  const oldDir = path.join(opts.sharedSkillsDir, `.${opts.name}.old.${opts.shareId}`);
  const target = path.join(opts.sharedSkillsDir, opts.name);

  // Step 1: untar to .new — its top-level entry is <name>/, so destParent
  // is sharedSkillsDir but the dir lands inside .<name>.new.<shareId>/<name>/.
  // To flatten, untar to a fresh parent and then rename the inner <name>/
  // out to newDir.
  await mkdir(newDir, { recursive: true });
  const written = await extractSkillTarball({
    srcTar:     opts.srcTar,
    destParent: newDir,
  });
  // extractSkillTarball wrote .new/<name>/. Hoist <name> contents out so newDir
  // itself becomes the new tree.
  const innerExtracted = path.join(newDir, opts.name);
  // Move the inner dir up: rename newDir/<name>/* into newDir/, then rmdir innerExtracted.
  // Easiest: rename inner -> sibling tmp, rm newDir, rename tmp -> newDir.
  const hoistTmp = path.join(opts.sharedSkillsDir, `.${opts.name}.hoist.${opts.shareId}`);
  await rename(innerExtracted, hoistTmp);
  await rmFs(newDir, { recursive: true, force: true });
  await rename(hoistTmp, newDir);

  // Step 2: move existing target aside.
  await rename(target, oldDir);

  // Step 3: install new.
  try {
    await rename(newDir, target);
  } catch (e) {
    // Restore best-effort and rethrow.
    try { await rename(oldDir, target); } catch { /* swallow */ }
    throw e;
  }

  // Step 4: delete .old.
  await rmFs(oldDir, { recursive: true, force: true });

  return written;
}
```

(Note: `mkdir` is already imported from `node:fs/promises`; just add `rename` and `rm as rmFs` to that import.)

- [ ] **Step 2: Tests for `atomicReplaceSkillDir`**

In `hub/indexer/test/share-fs.test.ts`, add a new `describe("atomicReplaceSkillDir", ...)` block at the bottom:

```ts
import { atomicReplaceSkillDir } from "../src/share-fs.js";   // augment existing import

describe("atomicReplaceSkillDir", () => {
  it("replaces an existing skill dir with new contents from a tarball", async () => {
    // Build the "old" skill dir.
    const sharedSkillsDir = path.join(root, "shared-skills");
    await mkdir(path.join(sharedSkillsDir, "single-cell"), { recursive: true });
    await writeFile(path.join(sharedSkillsDir, "single-cell", "SKILL.md"), "old\n");
    await writeFile(path.join(sharedSkillsDir, "single-cell", "v1.py"), "v=1");

    // Build the new contents and pack a tarball.
    const newSrc = path.join(root, "src-single-cell");
    await mkdir(newSrc, { recursive: true });
    await writeFile(path.join(newSrc, "SKILL.md"), "new\n");
    await writeFile(path.join(newSrc, "v2.py"), "v=2");
    const tarPath = path.join(root, "snap.tar.gz");
    await packSkillTarball({ skillDir: newSrc, destTar: tarPath });

    // Replace.
    await atomicReplaceSkillDir({
      srcTar: tarPath, sharedSkillsDir, name: "single-cell", shareId: "abc",
    });

    // The target now has the new files; the old ones are gone.
    expect(await readFile(path.join(sharedSkillsDir, "single-cell", "SKILL.md"), "utf8")).toBe("new\n");
    expect(await readFile(path.join(sharedSkillsDir, "single-cell", "v2.py"), "utf8")).toBe("v=2");
    await expect(access(path.join(sharedSkillsDir, "single-cell", "v1.py"))).rejects.toThrow();
  });

  it("leaves no .new or .old siblings on success", async () => {
    const sharedSkillsDir = path.join(root, "shared-skills");
    await mkdir(path.join(sharedSkillsDir, "alpha"), { recursive: true });
    await writeFile(path.join(sharedSkillsDir, "alpha", "SKILL.md"), "x");
    const newSrc = path.join(root, "src-alpha");
    await mkdir(newSrc, { recursive: true });
    await writeFile(path.join(newSrc, "SKILL.md"), "y");
    const tarPath = path.join(root, "snap.tar.gz");
    await packSkillTarball({ skillDir: newSrc, destTar: tarPath });

    await atomicReplaceSkillDir({
      srcTar: tarPath, sharedSkillsDir, name: "alpha", shareId: "abc123",
    });

    const entries = await readdir(sharedSkillsDir);
    expect(entries).toEqual(["alpha"]);   // no .alpha.new.abc123 / .alpha.old.abc123 residue
  });

  it("rejects when target directory does not exist (ENOENT on step 2)", async () => {
    const sharedSkillsDir = path.join(root, "shared-skills");
    await mkdir(sharedSkillsDir, { recursive: true });
    // No 'gamma' dir present in shared-skills.
    const newSrc = path.join(root, "src-gamma");
    await mkdir(newSrc, { recursive: true });
    await writeFile(path.join(newSrc, "SKILL.md"), "x");
    const tarPath = path.join(root, "snap.tar.gz");
    await packSkillTarball({ skillDir: newSrc, destTar: tarPath });

    await expect(atomicReplaceSkillDir({
      srcTar: tarPath, sharedSkillsDir, name: "gamma", shareId: "abc",
    })).rejects.toThrow(/ENOENT/);
  });

  it("returns the list of paths written (from extractSkillTarball)", async () => {
    const sharedSkillsDir = path.join(root, "shared-skills");
    await mkdir(path.join(sharedSkillsDir, "beta"), { recursive: true });
    await writeFile(path.join(sharedSkillsDir, "beta", "SKILL.md"), "old");
    const newSrc = path.join(root, "src-beta");
    await mkdir(path.join(newSrc, "scripts"), { recursive: true });
    await writeFile(path.join(newSrc, "SKILL.md"), "new");
    await writeFile(path.join(newSrc, "scripts", "run.sh"), "echo hi");
    const tarPath = path.join(root, "snap.tar.gz");
    await packSkillTarball({ skillDir: newSrc, destTar: tarPath });

    const written = await atomicReplaceSkillDir({
      srcTar: tarPath, sharedSkillsDir, name: "beta", shareId: "abc",
    });
    expect(written).toEqual(expect.arrayContaining([
      expect.stringContaining("SKILL.md"),
      expect.stringContaining("scripts/run.sh"),
    ]));
  });
});
```

`readdir` and `access` are already imported in `share-fs.test.ts` for other tests — confirm before assuming, add if needed.

- [ ] **Step 3: Run tests**

```
cd /home/lili/claude-bioflow/hub/indexer && npm test -- share-fs
```

Expected: 17 existing tests + 4 new = 21 passing.

- [ ] **Step 4: Commit**

```
git -C /home/lili/claude-bioflow add \
  hub/indexer/src/share-fs.ts \
  hub/indexer/test/share-fs.test.ts
git -C /home/lili/claude-bioflow commit -m "feat(share-fs): atomicReplaceSkillDir for skill-update approve path"
```

No `Co-Authored-By` trailer.

---

## Task 3: `submitSkillUpdateShareRequest` + `target_not_found` reason

**Files:**
- Modify: `hub/indexer/src/share-repo-skill.ts`
- Modify: `hub/indexer/src/share-repo.ts`
- Modify: `hub/indexer/src/share-api.ts`
- Modify: `hub/indexer/test/share-repo.test.ts`

- [ ] **Step 1: Extend `SubmitResult` reason union**

In `hub/indexer/src/share-repo.ts`, find the SubmitResult type. Add `"target_not_found"` to its reason union:

```ts
export type SubmitResult =
  | { ok: true; share_id: string }
  | { ok: false;
      reason:
        | "no_manager"
        | "not_implemented"
        | "forbidden"
        | "invalid_ref"
        | "source_not_found"
        | "missing_manifest"
        | "snapshot_failed"
        | "oversize"
        | "target_not_found";        // NEW
      detail?: string };
```

- [ ] **Step 2: Add the new helper to `share-repo-skill.ts`**

In `hub/indexer/src/share-repo-skill.ts`, add:

```ts
export async function submitSkillUpdateShareRequest(args: SubmitArgs): Promise<SubmitResult> {
  // Same source validation as submitSkillShareRequest.
  const userSkillsRoot = path.join(args.workspacesRoot, args.requester, ".claude", "skills");
  const resolved = safeJoin(userSkillsRoot, args.ref);
  if (resolved === null) {
    return { ok: false, reason: "invalid_ref" };
  }

  let st;
  try { st = await stat(resolved); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "source_not_found" };
    }
    throw e;
  }
  if (!st.isDirectory()) {
    return { ok: false, reason: "source_not_found", detail: "ref is not a directory" };
  }

  const manifest = await readSkillManifest(resolved);
  if (manifest === null) {
    return { ok: false, reason: "missing_manifest", detail: "no SKILL.md at top level" };
  }

  // The key difference from submitSkillShareRequest: target MUST already exist.
  const target = path.join(args.workspacesRoot, "shared", "skills", args.ref);
  try {
    const ts = await stat(target);
    if (!ts.isDirectory()) {
      return { ok: false, reason: "target_not_found", detail: `${target} exists but is not a directory` };
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "target_not_found", detail: `no existing org skill at shared/skills/${args.ref} — submit as kind='skill' instead` };
    }
    throw e;
  }

  const files = await walkSkillFiles(resolved);
  const share_id = randomUUID();
  const tarPath = path.join(args.shareSnapshotsDir, `${share_id}.tar.gz`);
  try {
    await packSkillTarball({ skillDir: resolved, destTar: tarPath });
  } catch (e) {
    return { ok: false, reason: "snapshot_failed", detail: (e as Error).message };
  }

  const snapshot_meta: Record<string, unknown> = {
    root_name: path.basename(resolved),
    manifest,
    files,
  };

  await args.pool.query(
    `INSERT INTO share_requests
       (share_id, artifact_kind, artifact_ref, snapshot_meta,
        requester, reviewer, requester_note)
     VALUES ($1, 'skill_update', $2, $3, $4, $5, $6)`,
    [share_id, args.ref, snapshot_meta, args.requester, args.managers[0], args.note ?? null],
  );
  return { ok: true, share_id };
}
```

(Imports already in scope from the existing skill helper.)

- [ ] **Step 3: Route the dispatcher to the new helper**

In `hub/indexer/src/share-repo.ts`'s `submitShareRequest`:

Find the existing dispatch chain:

```ts
if (args.kind === "skill") {
  return await submitSkillShareRequest(args);
}
if (args.kind === "folder") {
  return await submitFolderShareRequest(args);
}
if (args.kind !== "memory") {
  return { ok: false, reason: "not_implemented" };
}
```

Insert ABOVE the not_implemented fallthrough:

```ts
if (args.kind === "skill_update") {
  return await submitSkillUpdateShareRequest(args);
}
```

Also add the import line at the top of share-repo.ts:

```ts
import {
  submitSkillShareRequest,
  approveSkillShareRequest,
  submitSkillUpdateShareRequest,   // NEW
} from "./share-repo-skill.js";
```

- [ ] **Step 4: Map `target_not_found` in share-api.ts**

In the submit handler's reason-to-HTTP switch in `hub/indexer/src/share-api.ts`, add:

```ts
case 'target_not_found':
  reply.code(404); return { error: 'target not found', detail: result.detail };
```

- [ ] **Step 5: Tests for skill_update submit**

In `hub/indexer/test/share-repo.test.ts`, add a new `describe("submitShareRequest skill_update branch", ...)` block after the skill submit block:

```ts
describe("submitShareRequest skill_update branch", () => {
  let workspacesRoot: string;
  let shareSnapshotsDir: string;
  const maxFolderBytes = 100 * 1024 * 1024;

  beforeEach(async () => {
    workspacesRoot    = await mkdtemp(path.join(tmpdir(), "ws-"));
    shareSnapshotsDir = await mkdtemp(path.join(tmpdir(), "snap-"));
    // alice's source skill
    const skill = path.join(workspacesRoot, "alice", ".claude", "skills", "single-cell");
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), "# v2\n");
    await writeFile(path.join(skill, "qc.py"), "v=2");
    // existing org skill
    const orgSkill = path.join(workspacesRoot, "shared", "skills", "single-cell");
    await mkdir(orgSkill, { recursive: true });
    await writeFile(path.join(orgSkill, "SKILL.md"), "# v1\n");
  });

  it("happy path: writes pending skill_update row", async () => {
    const r = await submitShareRequest({
      pool, managers: ["li86"], requester: "alice",
      kind: "skill_update", ref: "single-cell",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("type guard");
    const row = (await pool.query(
      `SELECT artifact_kind FROM share_requests WHERE share_id=$1`, [r.share_id])).rows[0];
    expect(row.artifact_kind).toBe("skill_update");
  });

  it("rejects with target_not_found when no existing org skill", async () => {
    const r = await submitShareRequest({
      pool, managers: ["li86"], requester: "alice",
      kind: "skill_update", ref: "no-such",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes,
    });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe("target_not_found");
  });

  it("rejects ../ path traversal", async () => {
    const r = await submitShareRequest({
      pool, managers: ["li86"], requester: "alice",
      kind: "skill_update", ref: "../../etc",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes,
    });
    expect(r).toEqual({ ok: false, reason: "invalid_ref" });
  });

  it("rejects missing manifest", async () => {
    const skill = path.join(workspacesRoot, "alice", ".claude", "skills", "no-manifest");
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, "qc.py"), "x");
    // also create matching org skill so we hit missing_manifest before target_not_found
    await mkdir(path.join(workspacesRoot, "shared", "skills", "no-manifest"), { recursive: true });
    const r = await submitShareRequest({
      pool, managers: ["li86"], requester: "alice",
      kind: "skill_update", ref: "no-manifest",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes,
    });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe("missing_manifest");
  });
});
```

- [ ] **Step 6: Test for share-api 404 mapping**

In `hub/indexer/test/share-api.test.ts`, inside the POST /share/submit describe block, add:

```ts
it('returns 404 when skill_update target does not exist', async () => {
  vi.mocked(repoMock.submitShareRequest).mockResolvedValueOnce({
    ok: false, reason: 'target_not_found', detail: 'no existing org skill at shared/skills/foo',
  });
  const res = await app.inject({
    method: 'POST', url: '/share/submit',
    payload: { requester: 'alice', kind: 'skill_update', ref: 'foo' },
  });
  expect(res.statusCode).toBe(404);
  expect(res.json()).toMatchObject({ error: 'target not found' });
});
```

- [ ] **Step 7: Run tests**

```
cd /home/lili/claude-bioflow/hub/indexer && npm test -- share-repo share-api
```

Expected: 4 new skill_update submit tests + 1 new api test pass; existing tests still pass.

- [ ] **Step 8: Commit**

```
git -C /home/lili/claude-bioflow add \
  hub/indexer/src/share-repo.ts \
  hub/indexer/src/share-repo-skill.ts \
  hub/indexer/src/share-api.ts \
  hub/indexer/test/share-repo.test.ts \
  hub/indexer/test/share-api.test.ts
git -C /home/lili/claude-bioflow commit -m "feat(share-repo): submitSkillUpdateShareRequest with target-exists check"
```

No `Co-Authored-By` trailer.

---

## Task 4: `approveSkillUpdateShareRequest` (uses atomic replace)

**Files:**
- Modify: `hub/indexer/src/share-repo-skill.ts`
- Modify: `hub/indexer/src/share-repo.ts`
- Modify: `hub/indexer/test/share-repo.test.ts`

- [ ] **Step 1: Add the approve helper**

In `hub/indexer/src/share-repo-skill.ts`, append:

```ts
import { atomicReplaceSkillDir } from "./share-fs.js";   // augment existing import

export async function approveSkillUpdateShareRequest(args: {
  row:                ShareRow;
  workspacesRoot:     string;
  shareSnapshotsDir:  string;
}): Promise<
  | { ok: true; promotion_result: Record<string, unknown> }
  | { ok: false; reason: "promotion_failed" | "target_not_found"; detail?: string }
> {
  const { row } = args;

  const meta = row.snapshot_meta as Record<string, unknown>;
  if (
    typeof meta.root_name !== "string" ||
    typeof meta.manifest  !== "string" ||
    !Array.isArray(meta.files)
  ) {
    return { ok: false, reason: "promotion_failed", detail: "snapshot_meta missing root_name/manifest/files" };
  }
  const rootName = meta.root_name;

  const sharedSkills = path.join(args.workspacesRoot, "shared", "skills");
  const targetDir = safeJoin(sharedSkills, rootName);
  if (targetDir === null) {
    return { ok: false, reason: "promotion_failed", detail: "snapshot root_name is invalid" };
  }

  // Target must still exist (a parallel admin could have rm'd it between submit and approve).
  try {
    const st = await stat(targetDir);
    if (!st.isDirectory()) {
      return { ok: false, reason: "target_not_found", detail: `${targetDir} exists but is not a directory` };
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "target_not_found",
               detail: `target ${targetDir} no longer exists; submit as new skill instead` };
    }
    throw e;
  }

  const tarPath = path.join(args.shareSnapshotsDir, `${row.share_id}.tar.gz`);
  let written: string[];
  try {
    written = await atomicReplaceSkillDir({
      srcTar:           tarPath,
      sharedSkillsDir:  sharedSkills,
      name:             rootName,
      shareId:          row.share_id,
    });
  } catch (e) {
    return { ok: false, reason: "promotion_failed",
             detail: `atomic replace failed: ${(e as Error).message}` };
  }

  return {
    ok: true,
    promotion_result: {
      dest_path:    targetDir,
      copied_files: written,
      replaced:     true,
    },
  };
}
```

- [ ] **Step 2: Route the dispatcher**

In `hub/indexer/src/share-repo.ts`'s `decideShareRequest`, find the existing approve dispatch (after the `skill` branch and before the `!== "memory"` fallthrough):

```ts
if (row.artifact_kind === "skill") {
  // ...existing skill approve dispatch...
}
if (row.artifact_kind === "folder") {
  // ...existing folder approve dispatch...
}
```

Add a skill_update branch BETWEEN skill and folder (or anywhere before the memory fallthrough — order doesn't matter):

```ts
if (row.artifact_kind === "skill_update") {
  const result = await approveSkillUpdateShareRequest({
    row,
    workspacesRoot:    args.workspacesRoot,
    shareSnapshotsDir: args.shareSnapshotsDir,
  });
  if (!result.ok) {
    await client.query("ROLLBACK");
    return result;
  }
  await client.query(
    `UPDATE share_requests
        SET status = 'approved', decided_at = now(),
            review_comment = $1, promotion_result = $2
      WHERE share_id = $3`,
    [args.comment ?? null, result.promotion_result, args.shareId],
  );
  await client.query("COMMIT");
  return { ok: true, status: "approved", promotion_result: result.promotion_result };
}
```

Update the import line in `share-repo.ts` to bring in the new helper:

```ts
import {
  submitSkillShareRequest,
  approveSkillShareRequest,
  submitSkillUpdateShareRequest,
  approveSkillUpdateShareRequest,   // NEW
} from "./share-repo-skill.js";
```

Also: `DecideResult`'s reason union currently doesn't include `target_not_found`. Add it:

```ts
export type DecideResult =
  | { ok: true; status: ShareStatus; promotion_result?: Record<string, unknown> }
  | { ok: false;
      reason:
        | "not_found"
        | "forbidden"
        | "already_decided"
        | "promotion_failed"
        | "collision"
        | "target_not_found";        // NEW
      detail?: string };
```

And in `share-api.ts`'s decide handler, map it:

```ts
if (result.reason === 'target_not_found') {
  reply.code(404);
  return { error: 'target not found', detail: result.detail };
}
```

(Place near the `'collision'` branch.)

- [ ] **Step 3: Tests for skill_update approve**

In `hub/indexer/test/share-repo.test.ts`, add a new `describe("decideShareRequest skill_update approve branch", ...)` block after the folder approve block:

```ts
describe("decideShareRequest skill_update approve branch", () => {
  let workspacesRoot: string;
  let shareSnapshotsDir: string;
  const maxFolderBytes = 100 * 1024 * 1024;

  beforeEach(async () => {
    workspacesRoot    = await mkdtemp(path.join(tmpdir(), "ws-"));
    shareSnapshotsDir = await mkdtemp(path.join(tmpdir(), "snap-"));
    // existing org skill v1
    const orgSkill = path.join(workspacesRoot, "shared", "skills", "demo");
    await mkdir(orgSkill, { recursive: true });
    await writeFile(path.join(orgSkill, "SKILL.md"), "v1");
    await writeFile(path.join(orgSkill, "old.py"), "v=1");
    // alice's source — v2
    const skill = path.join(workspacesRoot, "alice", ".claude", "skills", "demo");
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), "v2");
    await writeFile(path.join(skill, "new.py"), "v=2");
  });

  it("approves and atomically replaces the existing org skill", async () => {
    const submitR = await submitShareRequest({
      pool, managers: ["li86"], requester: "alice",
      kind: "skill_update", ref: "demo",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes,
    });
    if (!submitR.ok) throw new Error("setup failed");

    const decideR = await decideShareRequest({
      pool, actor: "li86", managers: ["li86"],
      shareId: submitR.share_id, decision: "approve", comment: "ship v2",
      workspacesRoot, shareSnapshotsDir,
    });
    expect(decideR.ok).toBe(true);

    // New content present, old content gone.
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(path.join(workspacesRoot, "shared", "skills", "demo", "SKILL.md"), "utf8")).toBe("v2");
    expect(await readFile(path.join(workspacesRoot, "shared", "skills", "demo", "new.py"), "utf8")).toBe("v=2");
    await expect(readFile(path.join(workspacesRoot, "shared", "skills", "demo", "old.py"), "utf8"))
      .rejects.toThrow();
  });

  it("returns target_not_found when org skill was deleted between submit and approve", async () => {
    const submitR = await submitShareRequest({
      pool, managers: ["li86"], requester: "alice",
      kind: "skill_update", ref: "demo",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes,
    });
    if (!submitR.ok) throw new Error("setup failed");
    // Admin removes the org skill before the manager approves.
    const { rm } = await import("node:fs/promises");
    await rm(path.join(workspacesRoot, "shared", "skills", "demo"), { recursive: true });

    const decideR = await decideShareRequest({
      pool, actor: "li86", managers: ["li86"],
      shareId: submitR.share_id, decision: "approve",
      workspacesRoot, shareSnapshotsDir,
    });
    expect(decideR.ok).toBe(false);
    expect((decideR as any).reason).toBe("target_not_found");
  });
});
```

- [ ] **Step 4: Run tests**

```
cd /home/lili/claude-bioflow/hub/indexer && npm test -- share-repo share-api
```

Expected: 2 new approve tests + all existing tests still pass.

- [ ] **Step 5: Commit**

```
git -C /home/lili/claude-bioflow add \
  hub/indexer/src/share-repo.ts \
  hub/indexer/src/share-repo-skill.ts \
  hub/indexer/src/share-api.ts \
  hub/indexer/test/share-repo.test.ts
git -C /home/lili/claude-bioflow commit -m "feat(share-repo): approveSkillUpdateShareRequest with atomic replace"
```

No `Co-Authored-By` trailer.

---

## Task 5: Frontend — `org_skills_list` RPC + SkillsPanel "Submit update" UX

**Files:**
- Create: `adapter/src/org-skills-rpc.ts`
- Create: `adapter/test/org-skills-rpc.test.ts`
- Modify: `adapter/src/rpc.ts`
- Modify: `frontend/src/services/skills.ts`
- Modify: `frontend/src/stores/skills.ts`
- Modify: `frontend/src/components/skills/SkillRow.vue`
- Modify: `frontend/src/components/skills/SkillsPanel.vue`
- Modify: `frontend/src/components/share/ShareDetail.vue` (badge "skill update")

- [ ] **Step 1: Adapter — `org-skills-rpc.ts`**

Create `adapter/src/org-skills-rpc.ts` mirroring the existing `skills-rpc.ts`:

```ts
// Lists org-wide skills under <workspaceRoot>/shared/skills/<name>/SKILL.md.
// Mirrors skills-rpc.ts but reads from the org tier. Empty array when the
// directory does not exist (e.g. fresh deployment with no promoted skills).

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillSummary } from "./skills-rpc.js";

export async function listOrgSkills(workspaceRoot: string): Promise<SkillSummary[]> {
  const orgSkillsDir = join(workspaceRoot, "shared", "skills");
  let entries;
  try {
    entries = await readdir(orgSkillsDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: SkillSummary[] = [];
  for (const it of entries) {
    if (!it.isDirectory()) continue;
    const skill = join(orgSkillsDir, it.name);
    let manifest: string;
    try {
      manifest = await readFile(join(skill, "SKILL.md"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    out.push({
      name:        it.name,
      description: extractDescription(manifest),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function extractDescription(manifest: string): string {
  const fmMatch = manifest.match(/^---\n(?<fm>[\s\S]*?)\n---\n/);
  const fm = fmMatch?.groups?.fm;
  if (!fm) return "";
  const dm = fm.match(/^description:\s*(?<val>.+?)\s*$/m);
  const val = dm?.groups?.val;
  if (!val) return "";
  return val.replace(/^['"]|['"]$/g, "");
}
```

(`extractDescription` is duplicated from `skills-rpc.ts` for now — YAGNI on a shared helper.)

- [ ] **Step 2: Adapter — `org-skills-rpc.test.ts`**

Mirror `skills-rpc.test.ts`. 3 tests: empty dir, dirs with SKILL.md, missing frontmatter.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { listOrgSkills } from "../src/org-skills-rpc.js";

let workspaceRoot: string;
beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "ws-"));
});

describe("listOrgSkills", () => {
  it("returns [] when shared/skills does not exist", async () => {
    expect(await listOrgSkills(workspaceRoot)).toEqual([]);
  });

  it("lists each subdir that contains SKILL.md", async () => {
    const make = async (n: string, body: string) => {
      const d = path.join(workspaceRoot, "shared", "skills", n);
      await mkdir(d, { recursive: true });
      await writeFile(path.join(d, "SKILL.md"), body);
    };
    await make("alpha", `---\ndescription: alpha org skill\n---\nbody`);
    await make("beta",  `---\ndescription: beta\n---\nbody`);
    const r = await listOrgSkills(workspaceRoot);
    expect(r).toEqual([
      { name: "alpha", description: "alpha org skill" },
      { name: "beta",  description: "beta" },
    ]);
  });

  it("returns empty description when frontmatter is missing", async () => {
    const d = path.join(workspaceRoot, "shared", "skills", "x");
    await mkdir(d, { recursive: true });
    await writeFile(path.join(d, "SKILL.md"), "no frontmatter\n");
    expect(await listOrgSkills(workspaceRoot)).toEqual([{ name: "x", description: "" }]);
  });
});
```

- [ ] **Step 3: Adapter — RPC dispatch**

In `adapter/src/rpc.ts`, add the import and a new dispatch case (right after the existing `skills_list` case):

```ts
import { listOrgSkills } from "./org-skills-rpc.js";   // augment imports

// ...inside the dispatch switch, after skills_list:
case "org_skills_list": {
  const skills = await listOrgSkills(this.deps.workspaceRoot);
  return { success: true, skills };
}
```

(The `RpcDeps` interface already has `workspaceRoot` — phase 1 wired it. Verify by reading.)

- [ ] **Step 4: Frontend — service + store**

In `frontend/src/services/skills.ts`, add:

```ts
export const skillsService = {
  list: async (): Promise<SkillSummary[]> => { /* existing */ },

  listOrg: async (): Promise<SkillSummary[]> => {
    const r = await natsService.invoke('org_skills_list', {}) as
      { success: true; skills: SkillSummary[] };
    return r.skills;
  },
} as const;
```

In `frontend/src/stores/skills.ts`, extend to track org skills:

```ts
export const useSkillsStore = defineStore('skills', () => {
  const skills    = ref<SkillSummary[]>([]);
  const orgSkills = ref<SkillSummary[]>([]);     // NEW
  const loading   = ref(false);
  const error     = ref<string | null>(null);

  async function load() {
    loading.value = true;
    error.value   = null;
    try {
      const [user, org] = await Promise.all([
        skillsService.list(),
        skillsService.listOrg(),
      ]);
      skills.value    = user;
      orgSkills.value = org;
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  /** Returns true if the given user skill name collides with an existing org skill. */
  function isOrgSkill(name: string): boolean {
    return orgSkills.value.some(s => s.name === name);
  }

  async function submitShare(name: string, note?: string) {
    const share = useShareStore();
    return await share.submit({ kind: 'skill', ref: name, note });
  }

  async function submitUpdate(name: string, note?: string) {
    const share = useShareStore();
    return await share.submit({ kind: 'skill_update', ref: name, note });
  }

  return { skills, orgSkills, loading, error, load, isOrgSkill, submitShare, submitUpdate };
});
```

- [ ] **Step 5: Frontend — SkillRow UX**

In `frontend/src/components/skills/SkillRow.vue`, branch on `isOrgSkill`. When the user's skill name matches an existing org skill, show "Submit update" instead of "Share" and call `submitUpdate` instead of `submitShare`. The modal text adapts to mention the atomic replace.

Concrete change: compute a boolean `isUpdate = computed(() => skills.isOrgSkill(props.skill.name))` and:
- Button label: `{{ isUpdate ? 'Submit update' : 'Share' }}`
- Modal heading: `Submit update to <name>?` vs `Share <name> with the org?`
- Modal description (when isUpdate=true): "This will atomically replace the existing org skill at /workspace/shared/skills/{{ skill.name }} when the manager approves."
- onSubmit calls `skills.submitUpdate(name, note)` when `isUpdate`, else `skills.submitShare(name, note)`.

- [ ] **Step 6: Frontend — ShareDetail badge**

In `frontend/src/components/share/ShareDetail.vue`, the artifact_kind chip displays the raw value. For `skill_update`, render "skill update" (with a space, not underscore):

```vue
<span class="meta-chip">{{ store.selected.artifact_kind === 'skill_update' ? 'skill update' : store.selected.artifact_kind }}</span>
```

(Or compute it once at the top of `<script setup>` — both work.)

- [ ] **Step 7: Frontend — SkillsPanel.vue**

The panel already calls `skills.load()` on mount; after Step 4's store changes, `load()` already fetches both user and org. No template change needed in SkillsPanel.vue.

If the panel currently calls `skills.list()` directly somewhere instead of `skills.load()`, switch to `load()`. Verify by reading.

- [ ] **Step 8: Build clean**

```
cd /home/lili/claude-bioflow/frontend && npm run build
cd /home/lili/claude-bioflow/adapter && npm test -- org-skills-rpc
```

Expected: frontend builds clean; 3 new adapter tests pass.

- [ ] **Step 9: Commit**

```
git -C /home/lili/claude-bioflow add \
  adapter/src/org-skills-rpc.ts \
  adapter/test/org-skills-rpc.test.ts \
  adapter/src/rpc.ts \
  frontend/src/services/skills.ts \
  frontend/src/stores/skills.ts \
  frontend/src/components/skills/SkillRow.vue \
  frontend/src/components/skills/SkillsPanel.vue \
  frontend/src/components/share/ShareDetail.vue
git -C /home/lili/claude-bioflow commit -m "feat(frontend): Submit-update flow for existing org skills"
```

No `Co-Authored-By` trailer.

---

## Final review

- [ ] Full indexer suite: `cd hub/indexer && npm test` — expect 355 + ~12 new = 367 passing (2 migration + 4 share-fs atomic + 1 share-cleanup + 4 submit + 2 approve + 1 share-api).
- [ ] Full adapter suite: `cd adapter && npm test` — expect 139 + 3 new = 142 passing.
- [ ] Frontend build clean.
- [ ] Live smoke (after merge + rebuild):
  - As li86 (or current manager), confirm shared/skills/<some-skill>/ exists.
  - As a regular user with the same skill in their `~/.claude/skills/`, open SkillsPanel → row shows "Submit update".
  - Submit → modal explains atomic replace → submit.
  - Manager: Inbox shows the new request with badge "skill update". Approve.
  - Verify `shared/skills/<name>/` now has the new contents; no `.new` / `.old` siblings remain.
- [ ] Negative path: delete the target org skill between submit and approve; verify decide returns 404 target_not_found.

When green: merge to main, rebuild indexer image, recreate container. Adapter unchanged in dispatch addition? Wait — adding `org_skills_list` IS an adapter src change, so user containers DO need recreating to pick up the new RPC. Plan for that during the merge step.

---

## Appendix: rough timing

| Task | Est | Notes |
|---|---:|---|
| 1 migration + types | 30m | mechanical extensions across ~5 files |
| 2 atomicReplaceSkillDir | 1h | new fs helper + 4 tests |
| 3 submit + target_not_found | 1h | new helper + 4 tests + api mapping |
| 4 approve + atomic replace | 45m | new helper + 2 tests + dispatch |
| 5 frontend + adapter RPC | 1.5h | adapter helper + 3 tests + 3 frontend files |
| Final review | 30m | suite + smoke |

Total: ~5 hours. Similar shape to phase 2/3.

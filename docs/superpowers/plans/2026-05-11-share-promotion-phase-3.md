# Share-to-org promotion — phase 3 (folder kind) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the share-promotion queue to the **folder kind** so users can submit a project folder from `local_projects/<name>/` for org review; on approve the indexer untars the frozen snapshot to `shared/projects/<name>/` (which is mounted **read-write** at `/workspace/shared/projects/` in every user container — the existing collaboration commons).

**Architecture:** Same queue + helpers + API + frontend that phase 2 (skill kind) already ships. The folder branch reuses `safeJoin`, `walkSkillFiles` (filesystem-agnostic — the name is historical), `packSkillTarball`, `extractSkillTarball`, and `extractSingleFile` unchanged. New work: (a) `share-repo` gains `submitFolderShareRequest` + `approveFolderShareRequest` mirroring the skill variants, but reads `README.md` instead of `SKILL.md` and enforces a **100 MB total size cap** at submit time; (b) `share-api` maps a new `oversize` reason to HTTP 413; (c) `ShareDetail.vue` replaces the phase-3 placeholder with a folder preview (file tree + optional README) using the existing `fetchSnapshotFile` route; (d) the existing `FileContextMenu.vue` gains a "Share with org" item that fires only for top-level `local_projects/<name>/` directories, opening the same submit-modal pattern as `SkillRow.vue`.

**Phase scope:** folder kind end-to-end. `submit`/`decide` for `kind: 'folder'` go from `501 not implemented` to fully working. Memory and skill flows are untouched.

**Tech Stack:** Same as phase 2 — TypeScript / Node 20, fastify, `tar` v7, vitest + `@testcontainers/postgresql`, Vue 3 Composition API + pinia. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-05-07-share-promotion.md` §5.3 (folder mechanics) and §12 (phase split row "phase 3"). The 100 MB cap is configurable via `SHARE_MAX_FOLDER_BYTES`.

**Phase 1+2 surface (already shipped, do NOT re-implement):**
- `share_requests` table; `share-fs.ts` helpers; `submitShareRequest` + `decideShareRequest` with memory + skill branches; `share-api.ts` with submit/list/get/decide/withdraw/capabilities + snapshot/file routes; adapter `/share-snapshot/:id/file` proxy and `skills_list` RPC; frontend types/services/stores/panel/detail.
- The indexer's workspaces mount is already `:rw` (phase 2 Task 1) — no compose change needed for phase 3.
- `shared/projects/` is ALREADY mounted at `/workspace/shared/projects/` (rw) in every user container via `add-user.sh:299` and `recreate-user.sh:162`. After approve, the new folder is immediately visible to all users without container restarts.
- `ShareDetail.vue` already has a `kind === 'folder'` branch that renders "Folder preview not available yet — coming in phase 3." This plan replaces it.

**Out of phase 3 scope:**
- Snapshot tarball cleanup cron (30-day TTL) → phase 4.
- Multi-manager, update-existing kind, line-by-line review → phase 4.
- Sub-directory or per-file shares — top-level project units only per spec §5.3.

---

## File Structure

**Modified:**
- `hub/indexer/src/config.ts` — add `shareMaxFolderBytes: number` field; default 100 * 1024 * 1024; reads `SHARE_MAX_FOLDER_BYTES` env.
- `hub/indexer/test/config.test.ts` — 3 tests for the new field.
- `hub/indexer/src/share-fs.ts` — add `readFolderReadme(dir)` mirroring `readSkillManifest`. Reuse all other helpers unchanged.
- `hub/indexer/test/share-fs.test.ts` — 2 tests for `readFolderReadme`.
- `hub/indexer/src/share-repo.ts` — extend `SubmitResult` reason union with `'oversize'`; add `submitFolderShareRequest` and `approveFolderShareRequest`; wire into the existing `kind === 'folder'` dispatch.
- `hub/indexer/test/share-repo.test.ts` — 7 new tests (4 folder submit + 3 folder approve).
- `hub/indexer/src/share-api.ts` — extend `ShareApiDeps` with `shareMaxFolderBytes`; thread into `submitShareRequest`; map `'oversize'` → HTTP 413.
- `hub/indexer/src/index.ts` — pass `cfg.shareMaxFolderBytes` into `shareRoutesPlugin`.
- `hub/indexer/test/share-api.test.ts` — 1 new test (oversize → 413) + extend the deps factory.
- `frontend/src/components/files/FileContextMenu.vue` — accept a new optional `shareable: boolean` prop; render a "Share with org" item when true; emit `share`.
- `frontend/src/components/files/FileTree.vue` — compute `shareable` for top-level `local_projects/<name>/` directories only; wire `@share="(openShareModal(...), closeCtxMenu())"`.
- `frontend/src/components/share/ShareDetail.vue` — replace the phase-3 placeholder with a folder preview (file tree, optional README, click-to-fetch).
- `hub/docker-compose.yml` — add `SHARE_MAX_FOLDER_BYTES: "104857600"` env on the indexer service (explicit, so operators see the cap in the compose file).

**Created:**
- `frontend/src/components/files/ShareFolderModal.vue` — a small modal mirroring the inline submit modal in `SkillRow.vue`. Reusable because FileContextMenu is far from its trigger (no inline-modal idiom available).

---

## Task 1: Config + `readFolderReadme` helper

**Files:**
- Modify: `hub/indexer/src/config.ts`
- Modify: `hub/indexer/test/config.test.ts`
- Modify: `hub/indexer/src/share-fs.ts`
- Modify: `hub/indexer/test/share-fs.test.ts`
- Modify: `hub/docker-compose.yml`

- [ ] **Step 1: Add `shareMaxFolderBytes` to `Config`**

In `hub/indexer/src/config.ts`, alongside `shareSnapshotsDir`:

```ts
shareMaxFolderBytes: number;
```

In `loadConfig()` body:

```ts
const shareMaxFolderBytes = parseIntVar(env, "SHARE_MAX_FOLDER_BYTES", 100 * 1024 * 1024);
```

Add `shareMaxFolderBytes,` to the returned object. (Reuse the existing `parseIntVar` helper.)

- [ ] **Step 2: Add config tests**

In `hub/indexer/test/config.test.ts`:

```ts
it('shareMaxFolderBytes defaults to 100 MB', () => {
  const cfg = loadConfig({ PG_URL: 'postgres://x' });
  expect(cfg.shareMaxFolderBytes).toBe(100 * 1024 * 1024);
});

it('shareMaxFolderBytes reads SHARE_MAX_FOLDER_BYTES env', () => {
  const cfg = loadConfig({ PG_URL: 'postgres://x', SHARE_MAX_FOLDER_BYTES: '5242880' });
  expect(cfg.shareMaxFolderBytes).toBe(5 * 1024 * 1024);
});

it('shareMaxFolderBytes rejects non-integer SHARE_MAX_FOLDER_BYTES', () => {
  expect(() => loadConfig({ PG_URL: 'postgres://x', SHARE_MAX_FOLDER_BYTES: 'huge' }))
    .toThrow(/integer/);
});
```

- [ ] **Step 3: Add `readFolderReadme` helper**

In `hub/indexer/src/share-fs.ts`, append after `readSkillManifest`:

```ts
/** Reads README.md if present, returns its full text; else null.
 *  Folder-kind analogue of readSkillManifest. README is optional — folders
 *  without one still snapshot (the file tree is the source of truth). */
export async function readFolderReadme(folderDir: string): Promise<string | null> {
  try {
    return await readFile(path.join(folderDir, "README.md"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
```

- [ ] **Step 4: Tests for `readFolderReadme`**

In `hub/indexer/test/share-fs.test.ts`, add after the `readSkillManifest` describe block:

```ts
describe("readFolderReadme", () => {
  it("returns the file body when README.md exists", async () => {
    const folder = path.join(root, "f");
    await mkdir(folder);
    await writeFile(path.join(folder, "README.md"), "# project");
    expect(await readFolderReadme(folder)).toBe("# project");
  });
  it("returns null when README.md is absent (unlike SKILL.md, README is optional)", async () => {
    const folder = path.join(root, "f");
    await mkdir(folder);
    expect(await readFolderReadme(folder)).toBeNull();
  });
});
```

Import `readFolderReadme` in the test file's imports.

- [ ] **Step 5: Wire env into compose**

In `hub/docker-compose.yml` under the `indexer:` `environment:` block, add:

```yaml
      SHARE_MAX_FOLDER_BYTES: "104857600"
```

(100 MB. Explicit so operators can tune without recompiling.)

- [ ] **Step 6: Run tests**

```
cd hub/indexer && npm test -- config share-fs
```

Expected: 3 new config tests + 2 new share-fs tests passing.

- [ ] **Step 7: Commit**

```
git add hub/indexer/src/config.ts hub/indexer/test/config.test.ts \
        hub/indexer/src/share-fs.ts hub/indexer/test/share-fs.test.ts \
        hub/docker-compose.yml
git commit -m "feat(indexer): add SHARE_MAX_FOLDER_BYTES config and readFolderReadme helper"
```

---

## Task 2: `share-repo.submitShareRequest` — folder branch

**Files:**
- Modify: `hub/indexer/src/share-repo.ts`
- Modify: `hub/indexer/test/share-repo.test.ts`

- [ ] **Step 1: Widen `SubmitArgs` and `SubmitResult`**

In `share-repo.ts`:

Add `maxFolderBytes: number` to `SubmitArgs` (alongside `workspacesRoot`, `shareSnapshotsDir`).

Add `"oversize"` to the `SubmitResult` reason union.

Extend the `./share-fs.js` import line to include `readFolderReadme`.

- [ ] **Step 2: Replace the folder fallthrough with the real branch**

Currently `submitShareRequest` dispatches `skill` then falls through `not_implemented` for non-memory kinds. Insert a `folder` branch BEFORE the `!== "memory"` short-circuit:

```ts
  if (args.kind === "folder") {
    return await submitFolderShareRequest(args);
  }
```

- [ ] **Step 3: Implement `submitFolderShareRequest`**

Add at the bottom of `share-repo.ts`, mirroring `submitSkillShareRequest`:

```ts
async function submitFolderShareRequest(args: SubmitArgs): Promise<SubmitResult> {
  // Resolve <workspaces>/<requester>/local_projects/<ref>; reject traversal.
  const userProjectsRoot = path.join(args.workspacesRoot, args.requester, "local_projects");
  const resolved = safeJoin(userProjectsRoot, args.ref);
  if (resolved === null) {
    return { ok: false, reason: "invalid_ref" };
  }

  // TOCTOU note: stat → walk → pack are not atomic. Single-tenant container
  // model — acceptable. See same note in submitSkillShareRequest.
  let st;
  try {
    st = await stat(resolved);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "source_not_found" };
    }
    throw e;
  }
  if (!st.isDirectory()) {
    return { ok: false, reason: "source_not_found", detail: "ref is not a directory" };
  }

  // walkSkillFiles is named historically — it is kind-agnostic. Walks the
  // tree, hashes contents, returns sorted entries with size_bytes.
  const files = await walkSkillFiles(resolved);
  const total_bytes = files.reduce((n, f) => n + f.size_bytes, 0);
  if (total_bytes > args.maxFolderBytes) {
    return {
      ok: false,
      reason: "oversize",
      detail: `folder total ${total_bytes} bytes exceeds cap ${args.maxFolderBytes}`,
    };
  }

  const readme = await readFolderReadme(resolved);

  const share_id = randomUUID();
  const tarPath = path.join(args.shareSnapshotsDir, `${share_id}.tar.gz`);
  try {
    await packSkillTarball({ skillDir: resolved, destTar: tarPath });
  } catch (e) {
    return { ok: false, reason: "snapshot_failed", detail: (e as Error).message };
  }

  const snapshot_meta: Record<string, unknown> = {
    root_name: path.basename(resolved),
    readme,             // null when no README.md at top level
    files,
    total_bytes,
  };

  await args.pool.query(
    `INSERT INTO share_requests
       (share_id, artifact_kind, artifact_ref, snapshot_meta,
        requester, reviewer, requester_note)
     VALUES ($1, 'folder', $2, $3, $4, $5, $6)`,
    [share_id, args.ref, snapshot_meta, args.requester, args.manager, args.note ?? null],
  );
  return { ok: true, share_id };
}
```

Note the snapshot_meta shape difference vs. skill: `readme` (nullable) + `total_bytes` (number), no `manifest`.

- [ ] **Step 4: Add tests for folder submit**

In `share-repo.test.ts`, add a new `describe("submitShareRequest folder branch")` block after the skill submit block:

```ts
describe("submitShareRequest folder branch", () => {
  let workspacesRoot: string;
  let shareSnapshotsDir: string;
  const maxFolderBytes = 100 * 1024 * 1024;

  beforeEach(async () => {
    workspacesRoot    = await mkdtemp(path.join(tmpdir(), "ws-"));
    shareSnapshotsDir = await mkdtemp(path.join(tmpdir(), "snap-"));
    // Pre-seed alice's local_projects/pbmc/
    const proj = path.join(workspacesRoot, "alice", "local_projects", "pbmc");
    await mkdir(proj, { recursive: true });
    await writeFile(path.join(proj, "README.md"), "# pbmc analysis\n");
    await writeFile(path.join(proj, "notebook.ipynb"), '{"cells":[]}\n');
  });

  it("happy path: packs a tarball and writes a pending folder row", async () => {
    const r = await submitShareRequest({
      pool, manager: "li86", requester: "alice",
      kind: "folder", ref: "pbmc",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes,
    });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) throw new Error("type guard");

    const row = (await pool.query(
      `SELECT artifact_kind, snapshot_meta, status FROM share_requests WHERE share_id=$1`,
      [r.share_id])).rows[0];
    expect(row.artifact_kind).toBe("folder");
    const meta = row.snapshot_meta as {
      root_name: string; readme: string | null;
      files: { path: string }[]; total_bytes: number;
    };
    expect(meta.root_name).toBe("pbmc");
    expect(meta.readme).toMatch(/pbmc analysis/);
    expect(meta.files.map((f) => f.path).sort()).toEqual(["README.md", "notebook.ipynb"]);
    expect(meta.total_bytes).toBeGreaterThan(0);
  });

  it("happy path with no README.md sets readme=null", async () => {
    const proj = path.join(workspacesRoot, "alice", "local_projects", "no-readme");
    await mkdir(proj, { recursive: true });
    await writeFile(path.join(proj, "data.csv"), "a,b\n1,2\n");
    const r = await submitShareRequest({
      pool, manager: "li86", requester: "alice",
      kind: "folder", ref: "no-readme",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("type guard");
    const row = (await pool.query(
      `SELECT snapshot_meta FROM share_requests WHERE share_id=$1`, [r.share_id])).rows[0];
    expect((row.snapshot_meta as any).readme).toBeNull();
  });

  it("rejects ../ path traversal with invalid_ref", async () => {
    const r = await submitShareRequest({
      pool, manager: "li86", requester: "alice",
      kind: "folder", ref: "../../etc",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes,
    });
    expect(r).toEqual({ ok: false, reason: "invalid_ref" });
  });

  it("rejects folder exceeding maxFolderBytes with oversize", async () => {
    // Use a small cap so we don't have to generate 100MB.
    const r = await submitShareRequest({
      pool, manager: "li86", requester: "alice",
      kind: "folder", ref: "pbmc",
      workspacesRoot, shareSnapshotsDir,
      maxFolderBytes: 10,           // 10-byte cap
    });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe("oversize");
    expect((r as any).detail).toMatch(/exceeds cap 10/);
  });
});
```

Add `maxFolderBytes: 100 * 1024 * 1024` to existing memory + skill test call sites so they still typecheck. (The memory and skill branches ignore it.)

- [ ] **Step 5: Run tests**

```
cd hub/indexer && npm test -- share-repo
```

Expected: 4 new folder tests + existing memory + skill tests all pass.

- [ ] **Step 6: Commit**

```
git add hub/indexer/src/share-repo.ts hub/indexer/test/share-repo.test.ts
git commit -m "feat(share-repo): folder submit — size cap + pack tarball with readme+tree"
```

---

## Task 3: `share-repo.decideShareRequest` — folder approve branch

**Files:**
- Modify: `hub/indexer/src/share-repo.ts`
- Modify: `hub/indexer/test/share-repo.test.ts`

- [ ] **Step 1: Widen `DecideArgs`**

In `share-repo.ts`, `DecideArgs` (already has `workspacesRoot`, `shareSnapshotsDir`) needs no new fields — folder approve uses the same shared workspaces root.

- [ ] **Step 2: Add folder dispatch in `decideShareRequest` approve path**

In the approve path of `decideShareRequest`, insert AFTER the `skill` branch and BEFORE the `!== "memory"` fallthrough:

```ts
    if (row.artifact_kind === "folder") {
      const result = await approveFolderShareRequest({
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

(Mirrors the skill dispatch exactly — caller owns transaction; helper is pure.)

- [ ] **Step 3: Implement `approveFolderShareRequest`**

Add at the bottom of `share-repo.ts`, mirroring `approveSkillShareRequest`:

```ts
async function approveFolderShareRequest(args: {
  row:                ShareRow;
  workspacesRoot:     string;
  shareSnapshotsDir:  string;
}): Promise<
  | { ok: true; promotion_result: Record<string, unknown> }
  | { ok: false; reason: "promotion_failed" | "collision"; detail?: string }
> {
  const { row } = args;

  // Validate snapshot shape.
  const meta = row.snapshot_meta as Record<string, unknown>;
  if (
    typeof meta.root_name !== "string" ||
    !Array.isArray(meta.files) ||
    typeof meta.total_bytes !== "number"
  ) {
    return { ok: false, reason: "promotion_failed",
             detail: "snapshot_meta missing root_name/files/total_bytes" };
  }
  const rootName = meta.root_name;

  // Defence-in-depth: root_name was basename()'d at submit, but validate again.
  const sharedProjects = path.join(args.workspacesRoot, "shared", "projects");
  const destDir = safeJoin(sharedProjects, rootName);
  if (destDir === null) {
    return { ok: false, reason: "promotion_failed", detail: "snapshot root_name is invalid" };
  }

  // Collision check — same rule as skill: any existing path is a collision.
  try {
    await stat(destDir);
    return {
      ok: false, reason: "collision",
      detail: `shared/projects/${rootName} already exists`,
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  const tarPath = path.join(args.shareSnapshotsDir, `${row.share_id}.tar.gz`);
  let written: string[];
  try {
    written = await extractSkillTarball({ srcTar: tarPath, destParent: sharedProjects });
  } catch (e) {
    return { ok: false, reason: "promotion_failed",
             detail: `untar failed: ${(e as Error).message}` };
  }

  return {
    ok: true,
    promotion_result: {
      dest_path:    destDir,
      copied_files: written,
      total_bytes:  meta.total_bytes,
    },
  };
}
```

- [ ] **Step 4: Tests for folder approve**

In `share-repo.test.ts`, add `describe("decideShareRequest folder approve branch")` AFTER the skill approve block:

```ts
describe("decideShareRequest folder approve branch", () => {
  let workspacesRoot: string;
  let shareSnapshotsDir: string;
  const maxFolderBytes = 100 * 1024 * 1024;

  beforeEach(async () => {
    workspacesRoot    = await mkdtemp(path.join(tmpdir(), "ws-"));
    shareSnapshotsDir = await mkdtemp(path.join(tmpdir(), "snap-"));
    await mkdir(path.join(workspacesRoot, "shared", "projects"), { recursive: true });
    const proj = path.join(workspacesRoot, "alice", "local_projects", "demo");
    await mkdir(proj, { recursive: true });
    await writeFile(path.join(proj, "README.md"), "# demo");
    await writeFile(path.join(proj, "run.sh"), "#!/bin/bash\necho hi\n");
  });

  it("approves a pending folder request and untars to shared/projects/", async () => {
    const submitR = await submitShareRequest({
      pool, manager: "li86", requester: "alice",
      kind: "folder", ref: "demo",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes,
    });
    if (!submitR.ok) throw new Error("setup failed");

    const decideR = await decideShareRequest({
      pool, actor: "li86", manager: "li86",
      shareId: submitR.share_id, decision: "approve", comment: "lgtm",
      workspacesRoot, shareSnapshotsDir,
    });
    expect(decideR.ok).toBe(true);
    if (!decideR.ok) throw new Error("type guard");
    expect(decideR.promotion_result?.dest_path).toBe(
      path.join(workspacesRoot, "shared", "projects", "demo"));

    const { readFile } = await import("node:fs/promises");
    const readme = await readFile(
      path.join(workspacesRoot, "shared", "projects", "demo", "README.md"), "utf8");
    expect(readme).toMatch(/demo/);
  });

  it("rejects approve when shared/projects/<name> already exists (collision)", async () => {
    await mkdir(path.join(workspacesRoot, "shared", "projects", "demo"), { recursive: true });
    const submitR = await submitShareRequest({
      pool, manager: "li86", requester: "alice",
      kind: "folder", ref: "demo",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes,
    });
    if (!submitR.ok) throw new Error("setup failed");
    const decideR = await decideShareRequest({
      pool, actor: "li86", manager: "li86",
      shareId: submitR.share_id, decision: "approve",
      workspacesRoot, shareSnapshotsDir,
    });
    expect(decideR.ok).toBe(false);
    expect((decideR as any).reason).toBe("collision");
  });

  it("snapshot survives source deletion", async () => {
    const submitR = await submitShareRequest({
      pool, manager: "li86", requester: "alice",
      kind: "folder", ref: "demo",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes,
    });
    if (!submitR.ok) throw new Error("setup failed");
    const { rm } = await import("node:fs/promises");
    await rm(path.join(workspacesRoot, "alice", "local_projects", "demo"), { recursive: true });

    const decideR = await decideShareRequest({
      pool, actor: "li86", manager: "li86",
      shareId: submitR.share_id, decision: "approve",
      workspacesRoot, shareSnapshotsDir,
    });
    expect(decideR.ok).toBe(true);
  });
});
```

- [ ] **Step 5: Run tests**

```
cd hub/indexer && npm test -- share-repo
```

Expected: 3 new folder approve tests pass; existing skill + memory tests still green.

- [ ] **Step 6: Commit**

```
git add hub/indexer/src/share-repo.ts hub/indexer/test/share-repo.test.ts
git commit -m "feat(share-repo): folder approve — untar snapshot to shared/projects with collision check"
```

---

## Task 4: `share-api` — thread `maxFolderBytes`, map `oversize` → 413

**Files:**
- Modify: `hub/indexer/src/share-api.ts`
- Modify: `hub/indexer/src/index.ts`
- Modify: `hub/indexer/test/share-api.test.ts`

- [ ] **Step 1: Extend `ShareApiDeps`**

In `share-api.ts`:

```ts
export interface ShareApiDeps {
  pool:                Pool;
  manager:             string | null;
  workspacesRoot:      string;
  shareSnapshotsDir:   string;
  shareMaxFolderBytes: number;          // NEW
  repo: { /* unchanged */ };
}
```

In the submit handler's `deps.repo.submitShareRequest({...})` call, add:

```ts
  maxFolderBytes: deps.shareMaxFolderBytes,
```

In the submit handler's reason-to-HTTP switch, add:

```ts
        case 'oversize':
          reply.code(413); return { error: 'folder too large', detail: result.detail };
```

(HTTP 413 = Payload Too Large; semantically correct for a size-cap rejection.)

- [ ] **Step 2: Wire `cfg.shareMaxFolderBytes` from `index.ts`**

In `hub/indexer/src/index.ts`, in the `shareRoutesPlugin({...})` call, add:

```ts
  shareMaxFolderBytes: cfg.shareMaxFolderBytes,
```

- [ ] **Step 3: Update share-api test deps factory**

In `hub/indexer/test/share-api.test.ts`, wherever the deps object is built, add:

```ts
  shareMaxFolderBytes: 100 * 1024 * 1024,
```

Add ONE new test for the oversize → 413 mapping (mock `submitShareRequest` to return `{ ok: false, reason: 'oversize', detail: '...' }`; assert 413):

```ts
it('returns 413 when folder submission exceeds size cap', async () => {
  vi.mocked(repoMock.submitShareRequest).mockResolvedValueOnce({
    ok: false, reason: 'oversize', detail: 'folder total 200000000 bytes exceeds cap 104857600',
  });
  const res = await app.inject({
    method: 'POST', url: '/share/submit',
    payload: { requester: 'alice', kind: 'folder', ref: 'big-project' },
  });
  expect(res.statusCode).toBe(413);
  expect(res.json()).toMatchObject({ error: 'folder too large' });
});
```

(Place inside the existing `POST /share/submit` describe block. Adapt to whatever mocking style that block uses.)

- [ ] **Step 4: Run tests**

```
cd hub/indexer && npm run typecheck
cd hub/indexer && npm test -- share-api
```

Expected: no new typecheck errors; new oversize test passes; existing share-api tests still pass.

- [ ] **Step 5: Commit**

```
git add hub/indexer/src/share-api.ts hub/indexer/src/index.ts hub/indexer/test/share-api.test.ts
git commit -m "feat(share-api): thread shareMaxFolderBytes and map oversize → 413"
```

---

## Task 5: Frontend — Files-panel Share context menu + submit modal

**Files:**
- Modify: `frontend/src/components/files/FileContextMenu.vue`
- Modify: `frontend/src/components/files/FileTree.vue`
- Create: `frontend/src/components/files/ShareFolderModal.vue`

- [ ] **Step 1: Extend `FileContextMenu.vue` with a `share` action**

Add `shareable: boolean` to props (optional with default `false`):

```ts
const props = defineProps<{
  x: number
  y: number
  type: 'file' | 'directory'
  shareable?: boolean
}>()
```

Add `share` to the `defineEmits` union:

```ts
(e: 'share'): void
```

Add a handler:

```ts
function pick(action: 'rename' | 'move-to' | 'new-file' | 'new-folder' | 'delete' | 'share') {
  switch (action) {
    // ... existing cases ...
    case 'share':       emit('share');      break
  }
  emit('close')
}
```

In the template, insert a separator + the Share button at the TOP of the menu (so it's visually distinct from destructive ops). Only render when `shareable === true`:

```vue
<template>
  <div ref="root" class="ctx-menu" :style="{ left: x + 'px', top: y + 'px' }" role="menu">
    <button
      v-if="shareable"
      class="ctx-item ctx-item-accent"
      role="menuitem"
      @click="pick('share')"
    >Share with org</button>
    <div v-if="shareable" class="ctx-sep" />
    <button class="ctx-item" role="menuitem" @click="pick('rename')">Rename</button>
    <!-- ... existing items unchanged ... -->
  </div>
</template>
```

Add scoped CSS:

```css
.ctx-item-accent { color: var(--accent); font-weight: var(--fw-semi); }
.ctx-item-accent:hover { background: var(--accent-soft); }
```

- [ ] **Step 2: Create `ShareFolderModal.vue`**

`frontend/src/components/files/ShareFolderModal.vue`:

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { useShareStore } from '@/stores/share'

const props = defineProps<{ folderName: string }>()
const emit  = defineEmits<{ (e: 'close'): void }>()

const note       = ref('')
const submitting = ref(false)
const errorMsg   = ref('')

const share = useShareStore()

async function onSubmit() {
  submitting.value = true
  errorMsg.value = ''
  try {
    await share.submit({ kind: 'folder', ref: props.folderName, note: note.value || undefined })
    emit('close')
  } catch (e) {
    errorMsg.value = (e as Error).message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="emit('close')">
      <div class="modal">
        <h3>Share <strong>{{ folderName }}</strong> with the org?</h3>
        <p class="modal-desc">
          The folder will be tarballed and queued for org review. On approve it
          lands at <code>/workspace/shared/projects/{{ folderName }}</code>.
        </p>
        <textarea v-model="note" rows="3" placeholder="Why are you sharing this? (optional)" />
        <p v-if="errorMsg" class="modal-error">{{ errorMsg }}</p>
        <div class="modal-actions">
          <button @click="emit('close')" :disabled="submitting">Cancel</button>
          <button class="primary" @click="onSubmit" :disabled="submitting">
            {{ submitting ? 'Submitting…' : 'Submit' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center; z-index: 1000;
}
.modal {
  background: var(--bg-primary); border: 1px solid var(--border);
  border-radius: var(--radius); padding: var(--space-4); width: min(440px, 90vw);
  display: flex; flex-direction: column; gap: var(--space-2);
}
.modal-desc { font-size: var(--text-xs); color: var(--text-muted); margin: 0; }
.modal-desc code { font-family: var(--font-mono); }
.modal textarea { width: 100%; padding: var(--space-2); resize: vertical; }
.modal-error { color: var(--danger); font-size: var(--text-xs); margin: 0; }
.modal-actions { display: flex; gap: var(--space-2); justify-content: flex-end; }
.modal-actions button {
  padding: var(--space-1) var(--space-3); border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--bg-secondary); cursor: pointer;
}
.modal-actions button.primary { background: var(--accent); color: white; border-color: var(--accent); }
.modal-actions button:disabled { opacity: 0.5; cursor: default; }
</style>
```

- [ ] **Step 3: Wire `share` in `FileTree.vue`**

Add the import:

```ts
import ShareFolderModal from './ShareFolderModal.vue'
```

Add state for the modal:

```ts
const shareModal = ref<{ folderName: string } | null>(null)
```

Add a helper that computes whether a given entry is a top-level `local_projects/<name>/`. The entries in FileTree's `FlatEntry` model carry a `path` string. A top-level project is one whose path is exactly `local_projects/<name>` (no further slashes after `<name>`):

```ts
function isShareableProject(fe: FlatEntry): boolean {
  if (fe.entry.type !== 'directory') return false
  const m = fe.path.match(/^local_projects\/([^/]+)$/)
  return m !== null
}

function openShareModalFor(fe: FlatEntry) {
  const m = fe.path.match(/^local_projects\/([^/]+)$/)
  if (m) shareModal.value = { folderName: m[1] }
}
```

(Read FileTree.vue's existing `FlatEntry` definition first — adapt the `fe.path` access if it's structured differently.)

In the `<FileContextMenu>` element, pass the new prop and listener:

```vue
<FileContextMenu
  v-if="ctxMenu"
  :x="ctxMenu.x"
  :y="ctxMenu.y"
  :type="ctxMenu.fe.entry.type"
  :shareable="isShareableProject(ctxMenu.fe)"
  @rename="(startRename(ctxMenu.fe), closeCtxMenu())"
  @move-to="(openMoveTo(ctxMenu.fe), closeCtxMenu())"
  @new-file="(startNewItemIn(ctxMenu.fe, 'file'), closeCtxMenu())"
  @new-folder="(startNewItemIn(ctxMenu.fe, 'directory'), closeCtxMenu())"
  @delete="(handleDelete(ctxMenu.fe), closeCtxMenu())"
  @share="(openShareModalFor(ctxMenu.fe), closeCtxMenu())"
  @close="closeCtxMenu()"
/>
```

Render the modal at the FileTree root level:

```vue
<ShareFolderModal
  v-if="shareModal"
  :folder-name="shareModal.folderName"
  @close="shareModal = null"
/>
```

- [ ] **Step 4: Smoke build**

```
cd /home/lili/claude-bioflow/frontend && npm run build
```

Expected: clean TS build.

- [ ] **Step 5: Commit**

```
git add frontend/src/components/files/
git commit -m "feat(frontend): Share-with-org context menu on top-level local_projects/ folders"
```

---

## Task 6: ShareDetail — folder preview

**File:** Modify: `frontend/src/components/share/ShareDetail.vue`

- [ ] **Step 1: Add a `folderSnap` computed + type**

In `frontend/src/types/share.ts`, append:

```ts
// Phase 3: folder snapshot shape inside snapshot_meta when artifact_kind='folder'.
export interface FolderSnapshotMeta {
  root_name:   string;
  readme:      string | null;
  files:       SkillSnapshotFile[];      // reuse — same {path, sha256, size_bytes}
  total_bytes: number;
}
```

In `ShareDetail.vue`'s `<script setup>`, add:

```ts
import type { FolderSnapshotMeta } from '@/types/share'

const folderSnap = computed<FolderSnapshotMeta | null>(() => {
  if (!store.selected || store.selected.artifact_kind !== 'folder') return null
  return store.selected.snapshot_meta as FolderSnapshotMeta
})
```

- [ ] **Step 2: Replace the folder placeholder with a real preview**

The current placeholder is:

```vue
<section v-else-if="store.selected.artifact_kind === 'folder'" class="detail-section">
  <p class="preview-unavailable">
    Folder preview not available yet — coming in phase 3.
  </p>
</section>
```

Replace with:

```vue
<section v-else-if="store.selected.artifact_kind === 'folder' && folderSnap" class="detail-section">
  <div class="snap-meta">
    <span class="meta-chip">{{ folderSnap.files.length }} files</span>
    <span class="meta-chip">{{ humanSize(folderSnap.total_bytes) }}</span>
  </div>

  <template v-if="folderSnap.readme">
    <h3 class="section-label">README.md</h3>
    <pre class="manifest-body">{{ folderSnap.readme }}</pre>
  </template>

  <h3 class="section-label" style="margin-top: var(--space-4)">Files</h3>
  <ul class="file-list">
    <li v-for="f in folderSnap.files" :key="f.path">
      <button class="file-row" @click="openFile(f.path)">
        <span class="file-path">{{ f.path }}</span>
        <span class="file-size">{{ humanSize(f.size_bytes) }}</span>
      </button>
    </li>
  </ul>

  <div v-if="filePreview" class="file-preview">
    <h4 class="section-label">{{ filePreview.path }}</h4>
    <pre class="manifest-body">{{ filePreview.body }}</pre>
    <button class="close-preview" @click="filePreview = null">Close</button>
  </div>
</section>
```

The `filePreview` state, `openFile`, and `humanSize` are already defined for the skill branch — reuse them. The `fetchSnapshotFile` route already supports folders because the indexer's `GET /share/:id/snapshot/file` route gates on `artifact_kind !== 'skill'` returning 400 — **this needs a one-line tweak:** change the gate to allow `'skill'` OR `'folder'`.

- [ ] **Step 3: Update the snapshot/file route's kind gate**

In `hub/indexer/src/share-api.ts`, find the snapshot/file handler. The line:

```ts
if (got.artifact_kind !== 'skill') {
  reply.code(400);
  return { error: 'snapshot/file only valid for skill kind' };
}
```

Change to:

```ts
if (got.artifact_kind !== 'skill' && got.artifact_kind !== 'folder') {
  reply.code(400);
  return { error: 'snapshot/file only valid for skill or folder kinds' };
}
```

- [ ] **Step 4: Extend the snapshot/file test to also exercise folder**

In `hub/indexer/test/share-api.test.ts`, add ONE test asserting a folder snapshot file can be fetched (mirrors the existing skill happy-path test but seeds a folder share):

```ts
it('streams a file from a folder snapshot', async () => {
  // (use the existing fixture pattern; submit a folder share, then fetch a file)
  const folderProj = path.join(workspacesRoot, "alice", "local_projects", "p");
  await mkdir(folderProj, { recursive: true });
  await writeFile(path.join(folderProj, "README.md"), "# project");

  const submit = await submitShareRequest({
    pool, manager: 'li86', requester: 'alice',
    kind: 'folder', ref: 'p',
    workspacesRoot, shareSnapshotsDir, maxFolderBytes: 100 * 1024 * 1024,
  });
  if (!submit.ok) throw new Error('setup failed');

  app = await buildApp({ pool, manager: 'li86', workspacesRoot, shareSnapshotsDir,
                         shareMaxFolderBytes: 100 * 1024 * 1024 });

  const res = await app.inject({
    method: 'GET',
    url:    `/share/${submit.share_id}/snapshot/file?actor=alice&path=p/README.md`,
  });
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain('project');
});
```

- [ ] **Step 5: Update the existing `kind !== 'skill'` test to use a memory share**

The existing test in that describe block asserts a memory share returns 400 from the snapshot/file route (since memory has no tarball). After the kind-gate change, that test still passes — the error message just changed to mention both kinds. Update its assertion if it checks the message string verbatim.

- [ ] **Step 6: Smoke build + tests**

```
cd hub/indexer && npm test -- share-api
cd /home/lili/claude-bioflow/frontend && npm run build
```

Expected: indexer share-api tests pass (one new + adjusted message); frontend builds clean.

- [ ] **Step 7: Manual end-to-end smoke (live stack)**

```
cd hub
docker compose up -d --build indexer adapter nginx
# Recreate user containers to pick up the new adapter (no new RPC in phase 3,
# but the indexer image needs rebuilding for the kind-gate change).
hub/scripts/recreate-user.sh li86
```

In the browser as test1:
1. Files panel → right-click `local_projects/<some-project>/` → "Share with org" item appears.
2. Click → modal → submit. Toast/log shows submission.
3. Switch to li86: Share tab badge `(1)`. Click → Inbox → Detail shows file count + total size + README + file tree.
4. Click a file → preview pane shows its content.
5. Approve. As any user: `/workspace/shared/projects/<name>/` is populated and writable.

- [ ] **Step 8: Commit**

```
git add frontend/src/components/share/ShareDetail.vue \
        frontend/src/types/share.ts \
        hub/indexer/src/share-api.ts \
        hub/indexer/test/share-api.test.ts
git commit -m "feat(share): folder snapshot preview in ShareDetail; allow folder kind in snapshot/file"
```

---

## Final review

After all 6 tasks:

- [ ] `cd hub/indexer && npm test` — expect ~14 new tests (3 config + 2 share-fs + 7 share-repo folder + 2 share-api folder).
- [ ] `cd adapter && npm test` — unchanged (no adapter changes in phase 3).
- [ ] `cd frontend && npm run build` clean.
- [ ] Manual end-to-end smoke (Task 6 Step 7) hits all four production users via `recreate-user.sh`.
- [ ] Verify oversize path: create a `local_projects/big/` with a file > `SHARE_MAX_FOLDER_BYTES` (default 100 MB), attempt to share, confirm error toast with "folder too large".
- [ ] Verify collision path: submit two folder shares with the same `<name>` from different users, approve the first, attempt to approve the second → 422 collision, manager rejects with rename suggestion.

When all green: dispatch `superpowers:code-reviewer` agent with scope = "phase 3 share-promotion (folder kind), see plan and spec." Land the merge to main.

Per the phase 2 code-reviewer note, **after this phase is in main**, consider splitting `share-repo.ts` into `share-repo-skill.ts` and `share-repo-folder.ts` (it'll be ~750+ LOC by end of phase 3). Defer to a follow-up refactor commit.

---

## Appendix: rough timing

| Task | Est | Notes |
|---|---:|---|
| 1 config + readme helper | 30m | three files + 5 tests |
| 2 folder submit branch | 1h | repo edit + 4 tests |
| 3 folder approve branch | 45m | repo edit + 3 tests |
| 4 share-api oversize | 30m | switch case + thread deps + 1 test |
| 5 Files-panel Share menu | 1.5h | FileContextMenu + FileTree wiring + new modal |
| 6 ShareDetail folder preview | 45m | one section + type + small indexer route tweak |

Total: ~5 hours of focused work, smaller than phase 2 because most plumbing is reused.

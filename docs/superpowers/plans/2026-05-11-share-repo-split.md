# share-repo.ts — split skill + folder helpers into per-kind modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut `hub/indexer/src/share-repo.ts` (currently 787 LOC) down to a focused dispatcher + memory-branch by moving the kind-specific helpers into sibling modules:

- `share-repo-skill.ts` — `submitSkillShareRequest` + `approveSkillShareRequest`
- `share-repo-folder.ts` — `submitFolderShareRequest` + `approveFolderShareRequest`

Behaviour-preserving refactor. Tests assert on the public surface (`submitShareRequest`, `decideShareRequest`, etc.) which stays in `share-repo.ts` — so no test changes expected.

**Architecture:** Three runtime files (`share-repo.ts` + two siblings), one-way runtime import graph (dispatcher → helpers). The two helpers need a handful of types from `share-repo.ts` (`SubmitArgs`, `SubmitResult`, `ShareRow`, `DecideResult`). To avoid a runtime cycle we use TypeScript's `import type` — pure-type imports are erased to nothing at runtime, so the dispatcher → helper edge is the only real dependency.

**Rationale:** Two prior cumulative reviews (phase 2 final and phase 3 final) flagged this as the right move after phase 3 lands the symmetric skill+folder helper pattern. We're there. The file has grown to 787 LOC with skill+folder helpers contributing ~250 of those; splitting them out leaves the dispatcher file at ~540 LOC and makes per-kind work navigable.

**Out of scope:**
- Splitting the memory branch out. Memory submit is ~30 LOC inline in `submitShareRequest`; extracting it would create asymmetry without benefit.
- Moving `listShareRequests`, `getShareRequest`, `withdrawShareRequest`, `getShareCapabilities`. These are kind-agnostic — they stay in `share-repo.ts`.
- Moving the `ShareRequest` / `ShareStatus` / `ArtifactKind` exports — these are the public type contract and stay in `share-repo.ts`.
- A separate `share-repo-types.ts`. Would mean four files when three suffice via `import type`.
- Renaming `share-repo.ts` itself. The public surface stays.
- Touching `share-repo.test.ts` (it imports the public surface — no changes needed).

---

## File Structure

**Created:**
- `hub/indexer/src/share-repo-skill.ts` — exports `submitSkillShareRequest` and `approveSkillShareRequest`. Imports types from `./share-repo.js` via `import type` (no runtime dep).
- `hub/indexer/src/share-repo-folder.ts` — exports `submitFolderShareRequest` and `approveFolderShareRequest`. Same pattern.

**Modified:**
- `hub/indexer/src/share-repo.ts` — remove the four kind-specific helper bodies; add `import { submitSkillShareRequest, approveSkillShareRequest } from "./share-repo-skill.js"` and the folder equivalent. The dispatchers (`submitShareRequest`, `decideShareRequest`) keep their existing call sites unchanged.

**Untouched:**
- `hub/indexer/test/share-repo.test.ts` — tests assert on the public surface only.
- `hub/indexer/src/share-api.ts`, `hub/indexer/src/index.ts` — only see the public surface.

---

## Task 1: Split

**Files:**
- Create: `hub/indexer/src/share-repo-skill.ts`
- Create: `hub/indexer/src/share-repo-folder.ts`
- Modify: `hub/indexer/src/share-repo.ts`

- [ ] **Step 1: Create `share-repo-skill.ts`**

Move the bodies of `submitSkillShareRequest` (lines ~176–229 in current share-repo.ts) and `approveSkillShareRequest` (lines ~602–653) into a new file. Export both.

Imports needed at the top of the new file (mirroring what's used inside the two helpers):

```ts
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { stat } from "node:fs/promises";
import type { PoolClient } from "pg";
import {
  safeJoin,
  walkSkillFiles,
  readSkillManifest,
  packSkillTarball,
  extractSkillTarball,
} from "./share-fs.js";
import type { SubmitArgs, SubmitResult, ShareRow, DecideResult } from "./share-repo.js";
```

Then paste the two helper function bodies verbatim from share-repo.ts. Change each from `async function` to `export async function` (currently they're private; the new file needs to expose them).

`approveSkillShareRequest`'s return type uses a structural shape: `Promise<{ ok: true; promotion_result: Record<string, unknown> } | { ok: false; reason: "promotion_failed" | "collision"; detail?: string }>`. Keep this structural type — it doesn't need to be exported as a named alias.

- [ ] **Step 2: Create `share-repo-folder.ts`**

Same pattern. Move `submitFolderShareRequest` (lines ~231–293) and `approveFolderShareRequest` (lines ~655–712) into the new file.

Imports needed:

```ts
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { stat } from "node:fs/promises";
import {
  safeJoin,
  walkSkillFiles,
  readFolderReadme,
  packSkillTarball,
  extractSkillTarball,
} from "./share-fs.js";
import type { SubmitArgs, SubmitResult, ShareRow } from "./share-repo.js";
```

Make both helpers `export async function`.

- [ ] **Step 3: Trim `share-repo.ts`**

In `hub/indexer/src/share-repo.ts`:

1. Delete the four moved function bodies (`submitSkillShareRequest`, `submitFolderShareRequest`, `approveSkillShareRequest`, `approveFolderShareRequest`).

2. Add the two new imports at the top with the other source imports:

```ts
import {
  submitSkillShareRequest,
  approveSkillShareRequest,
} from "./share-repo-skill.js";
import {
  submitFolderShareRequest,
  approveFolderShareRequest,
} from "./share-repo-folder.js";
```

3. Confirm `ShareRow` (currently a local interface around line 27) is `export interface ShareRow` so the helper files' `import type` resolves. If it's not yet exported, add the `export` keyword.

4. Now-unused imports in share-repo.ts: after moving the helpers out, some of the top-level imports may no longer be referenced by anything left in share-repo.ts. Audit and remove:
   - `randomUUID` — used by memory branch in `submitShareRequest`? Verify; if yes, keep. If only used by the moved helpers, remove.
   - `safeJoin`, `walkSkillFiles`, `readSkillManifest`, `readFolderReadme`, `packSkillTarball`, `extractSkillTarball` — these were only used by the moved helpers. Remove.
   - `stat` from `node:fs/promises` — only by the moved helpers. Remove.
   - `path` — verify; if used elsewhere keep, else remove.

   Be precise: TypeScript will fail to compile on unused imports if `noUnusedLocals` is on (it isn't required to be — check tsconfig), but they're noise either way. Clean them up.

- [ ] **Step 4: Build clean (typecheck + tests pass)**

```
cd /home/lili/claude-bioflow/hub/indexer && npm run typecheck
cd /home/lili/claude-bioflow/hub/indexer && npm test -- share-repo
```

Expected:
- Typecheck: no new errors in share-repo.ts / share-repo-skill.ts / share-repo-folder.ts. Pre-existing strict-mode noise in unrelated test files is fine.
- share-repo tests: ALL 47 tests pass unchanged (the public surface didn't move).

Then a full suite check:

```
cd /home/lili/claude-bioflow/hub/indexer && npm test
```

Expected: 355 total tests pass (same count as end of phase-4 auto-close).

- [ ] **Step 5: Commit**

```
git -C /home/lili/claude-bioflow add \
  hub/indexer/src/share-repo.ts \
  hub/indexer/src/share-repo-skill.ts \
  hub/indexer/src/share-repo-folder.ts
git -C /home/lili/claude-bioflow commit -m "refactor(share-repo): extract per-kind helpers into share-repo-skill/folder.ts"
```

No `Co-Authored-By` trailer.

---

## Final review

- [ ] `share-repo.ts` is now in the ~540 LOC range (down from 787).
- [ ] Each helper file is self-contained: imports its own utilities, declares no module-level mutable state, exports exactly the two functions the dispatcher needs.
- [ ] `import type` is used for `SubmitArgs`/`SubmitResult`/`ShareRow`/`DecideResult` in the helper files — verifies no runtime circular dep.
- [ ] Full test suite passes (355).
- [ ] No frontend, adapter, or migration changes — refactor is local to the indexer's repo layer.

When green: merge to main, rebuild + recreate indexer.

---

## Appendix: rough timing

| Task | Est | Notes |
|---|---:|---|
| 1 split | 1h | 3 files, mechanical move + import audit |

Total: ~1 hour. Smallest practical refactor — moving ~250 LOC of helper bodies to siblings.

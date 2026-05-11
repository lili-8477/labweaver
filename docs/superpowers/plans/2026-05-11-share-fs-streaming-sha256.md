# share-fs `walkSkillFiles` — streaming sha256 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the pre-cap memory allocation in `walkSkillFiles`. Today each file is fully loaded into a `Buffer` to compute sha256 + size; a 100 MB project folder allocates ~100 MB of heap before `submitFolderShareRequest`'s size-cap check fires. Switch to a streaming pipeline that hashes the file in 64 KB chunks and reads `size` from the existing `lstat` result.

**Architecture:** Replace `readFile + buf.byteLength + createHash().update(buf)` with `pipeline(createReadStream(abs), createHash())` + `st.size`. `st` is already produced by the symlink-hardening `lstat` call from phase-2 Task 2; no extra stat call. sha256 over a stream produces the byte-identical digest to sha256 over a buffer (the algorithm is byte-order deterministic), so existing tests that assert specific hash bytes continue to pass unchanged.

**Spec rationale:** Phase 2 + 3 reviewers flagged this as a deferred DoS-hardening item. Phase 3 made it user-reachable: a malicious or accidentally-large local project can OOM the indexer before the 100 MB cap rejects the submission. The indexer is single-process and shared across all users, so any one user's submission can degrade everyone.

**Out of scope:**
- The 100 MB cap itself (already enforced post-walk in `submitFolderShareRequest`).
- Reducing the file count (no change to `IGNORE_BASENAMES`).
- `packSkillTarball` — already streams via `tar.create` with a file cwd; never buffers.
- `extractSingleFile` — already streams via the tar parser.
- A per-walk file-count cap. Could be added later; not required for this slice.

---

## File Structure

**Modified:**
- `hub/indexer/src/share-fs.ts` — swap buffered hash for streaming pipeline in `walkSkillFiles`.
- `hub/indexer/test/share-fs.test.ts` — add one test that pins the sha256 of a known fixture so we'd catch a streaming-implementation regression. (Existing tests assert the hash format `/^[0-9a-f]{64}$/`; we want an exact match.)

---

## Task 1: Stream the hash in `walkSkillFiles`

**Files:**
- Modify: `hub/indexer/src/share-fs.ts`
- Modify: `hub/indexer/test/share-fs.test.ts`

- [ ] **Step 1: Switch `walkSkillFiles` to streaming**

In `hub/indexer/src/share-fs.ts`:

(a) Add to the existing `node:fs` import block:

```ts
import {
  createReadStream,
  // ... existing entries ...
} from "node:fs";
```

(b) Make sure `pipeline` from `node:stream/promises` is imported (it is, used by `extractSingleFile`).

(c) Inside `walkSkillFiles`, replace the file-reading branch. Current code:

```ts
} else if (st.isFile()) {
  const rel = path.relative(real, abs).split(path.sep).join("/");
  const buf = await readFile(abs);
  entries.push({
    path:       rel,
    sha256:     createHash("sha256").update(buf).digest("hex"),
    size_bytes: buf.byteLength,
  });
}
```

Replace with:

```ts
} else if (st.isFile()) {
  const rel = path.relative(real, abs).split(path.sep).join("/");
  const hash = createHash("sha256");
  await pipeline(createReadStream(abs), hash);
  entries.push({
    path:       rel,
    sha256:     hash.digest("hex"),
    size_bytes: st.size,
  });
}
```

Notes:
- `createHash` instances are writable streams in Node — `pipeline` can write into them directly.
- `st.size` comes from the `lstat` already performed at the top of the loop body. No extra syscall.
- After `pipeline` resolves, the hash object has consumed all bytes and `.digest("hex")` finalizes it.
- `readFile` is no longer used in `walkSkillFiles` — if no other helper in the file uses it for hashing, leave it imported (it's still used by `readSkillManifest` and `readFolderReadme`).

- [ ] **Step 2: Add a pin-the-hash test**

In `hub/indexer/test/share-fs.test.ts`, inside the existing `describe("walkSkillFiles", ...)` block, add ONE new test that asserts an exact sha256 value for known content (the `/^[0-9a-f]{64}$/` regex test already in place would have masked a streaming-vs-buffered regression that produced wrong bytes):

```ts
it("computes the correct sha256 (streaming-equivalent to buffered)", async () => {
  const skill = path.join(root, "s");
  await mkdir(skill);
  // "hello\n" — sha256: 5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03
  await writeFile(path.join(skill, "SKILL.md"), "hello\n");
  const r = await walkSkillFiles(skill);
  expect(r).toHaveLength(1);
  expect(r[0]!.sha256).toBe(
    "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
  );
  expect(r[0]!.size_bytes).toBe(6);
});
```

(Hash value verified externally: `printf 'hello\n' | sha256sum` produces `5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03`. The file is 6 bytes: `h`, `e`, `l`, `l`, `o`, `\n`.)

- [ ] **Step 3: Run tests**

```
cd /home/lili/claude-bioflow/hub/indexer && npm test -- share-fs share-repo
```

Expected:
- All existing share-fs tests pass unchanged (sha256 bytes are identical between buffered and streamed implementations).
- The new pin-the-hash test passes.
- share-repo tests (which use walkSkillFiles via submitSkillShareRequest and submitFolderShareRequest) still pass — they don't assert specific hash values, just structural fields.

- [ ] **Step 4: Commit**

```
git -C /home/lili/claude-bioflow add hub/indexer/src/share-fs.ts hub/indexer/test/share-fs.test.ts
git -C /home/lili/claude-bioflow commit -m "perf(share-fs): stream sha256 in walkSkillFiles to bound memory"
```

No `Co-Authored-By` trailer.

---

## Final review

- [ ] Full indexer test suite: `cd /home/lili/claude-bioflow/hub/indexer && npm test`. Expect 339 + 1 new = 340 passing.
- [ ] No live-stack smoke needed — pure behavior-preserving refactor of a single helper.

When green: merge to main, rebuild indexer image, recreate the container (so the running process picks up the new bundle). User containers untouched (adapter isn't involved).

---

## Appendix: rough timing

| Task | Est | Notes |
|---|---:|---|
| 1 stream the hash | 30m | one file change, one new test |

Total: ~30 minutes. Smallest slice in the share-promotion series.

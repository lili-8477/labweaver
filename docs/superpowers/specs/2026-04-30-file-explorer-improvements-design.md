# File Explorer Improvements — Design

**Status:** Approved
**Date:** 2026-04-30
**Component:** `frontend/src/components/files/FileTree.vue`, `adapter/src/fs-rpc.ts`

## Problem

User feedback on the current file panel (`FileTree.vue`):

1. Cannot move files around easily.
2. Cannot create a new file inside a specific directory — the `+` toolbar button always uses the same shared input strip and lands files at workspace root.
3. Cannot rename files at all (no UI, no backend op).
4. Only file uploads work; directory uploads are not supported.

## Goals

Add the four missing capabilities with the smallest viable surface — one new backend op, one new frontend interaction model (context menu + drag-row-to-folder).

## Non-goals

- Multi-select for bulk operations (move / delete several).
- Cut / copy / paste keyboard model.
- Overwrite-conflict resolution dialog ("overwrite / keep both / skip").
- Cross-filesystem move atomicity (`fs.rename` already handles the single-FS case; the workspace bind-mount is a single FS).

## Architecture

One backend op covers items 1 and 3 (move = different parent, rename = same parent, new name). Frontend changes concentrate the new affordances in a row-level context menu plus drag-row-to-folder, so all four user requests share one UX vocabulary.

### Backend

Extend `FileManager.managePath` in `adapter/src/fs-rpc.ts`:

- New op: `move`. Args: `from` (rel path), `to` (rel path).
- Both paths resolved through the existing `this.resolve()` guard (workspace-scope, path-traversal blocked).
- Reject if any segment of `from` or `to` matches the existing `isHidden(seg)` deny-list.
- `fs.stat(to)` — if exists, throw `target_exists`. No overwrite.
- `fs.mkdir(dirname(to), { recursive: true })`, then `fs.rename(from, to)`.
- Return `{ success: true }`.

`dispatch` accepts `from` / `to` args alongside the existing `path` / `sub_dir` / `file_path` keys (the dispatcher already accepts a union of arg names; extend it).

### Frontend

#### Row-level context menu

- Right-click any row → menu at cursor. Hover state on each row also shows a `⋯` button that opens the same menu (touch / keyboard parity).
- Items:
  - **Rename**
  - **Move to…**
  - **New File** (in this dir)
  - **New Folder** (in this dir)
  - **Delete**
- For directory rows, "New File / New Folder" creates inside that directory; for file rows, creates as siblings (same parent).
- Dismisses on click-outside, Escape, or item-selection.

#### Inline rename

- Selecting Rename swaps the row's name `<span>` for an `<input>` pre-filled with the current name. The cursor selects the basename (excluding extension) so retyping is fast.
- Enter → call `manage_path { op: "move", from: <oldPath>, to: <parent>/<newName> }`. On success, refresh the affected directory.
- Escape → revert without calling the backend.
- On error (e.g. `target_exists`), revert the input to the original name and show the error in a thin `.tree-error` strip rendered just above the upload tray. The strip auto-dismisses after 5 s and is shared with Move to… and drag-row-to-folder errors.

#### Move to… modal

- Small modal with a directory-only tree, built by reusing `list_files` and filtering `type === "directory"`. Lazily expand on click.
- Footer: **Cancel** / **Move**. Move is disabled when:
  - selection is empty
  - selection equals source path
  - selection equals source's current parent (no-op move)
  - selection is a descendant of the source (would be a move-into-self)
- On confirm: call `move` with `from = source`, `to = <selectedDir>/<basename(source)>`.

#### Drag-row-to-folder

- `dragstart` on `.entry-row` sets `dataTransfer.setData('application/x-bioflow-path', <rowPath>)` and `dataTransfer.effectAllowed = 'move'`.
- Existing `onDragOver` / `onDrop` handlers are extended to dispatch by `dataTransfer.types`:
  - Contains `Files` (existing path) → upload from OS.
  - Contains `application/x-bioflow-path` (new path) → internal move.
- Drop target resolution:
  - drop on a folder row → move into that folder
  - drop on a file row → move into its parent
  - drop on the empty pane → no-op for internal moves (the existing pane-drop path stays reserved for OS-file uploads, where the `local_projects/` default makes sense; for moves, "to root" is a rare intent and is reachable through Move to…)
- No-op when source path equals target dir, when target is the source itself, or when target is a descendant of the source.

#### New File / New Folder anchored to directory

- The existing `new-item` input strip remains the canonical UI.
- Context-menu **New File** / **New Folder** sets `newItemPath` pre-filled with `<dir>/` and `newItemType` accordingly, then opens the strip with the cursor placed after the slash so the user only types the name.
- Toolbar `+` / folder buttons retain existing behavior (open empty input).

#### Directory upload

Two changes:

1. **Toolbar button**: add a second upload button (folder icon) with a separate `<input type="file" webkitdirectory multiple ref="dirInput">`. On change, iterate `input.files`. Each `File` has a `webkitRelativePath` (e.g. `myfolder/sub/file.txt`); upload each under `<DEFAULT_DROP_DIR>/<webkitRelativePath>`. Reuse the existing `queueUpload` loop — the upload server already accepts arbitrary nested paths under `local_projects/`.

2. **Drag-drop folders**: in `onDrop`, when `dataTransfer.items` is present, walk each `DataTransferItem.webkitGetAsEntry()` recursively, collecting `(File, relativePath)` pairs:
   - `FileSystemFileEntry` → `entry.file(cb)` to get the `File`; record `relativePath = <currentSubpath>`.
   - `FileSystemDirectoryEntry` → `entry.createReader().readEntries(cb)`, recurse with `<currentSubpath>/<entry.name>`.
   - When all walks complete, queue each pair as `queueUpload(file, dropDir + '/' + relativePath.parentDir)`.
   - The walk is async; show a brief "Preparing upload…" state, then queue all at once. Existing sequential upload queue handles the rest.

### Conflict policy

- **Move / Rename target exists** → backend rejects with `target_exists`; frontend surfaces a one-line inline error. No prompt, no overwrite. Avoids accidental clobber and matches typical IDE behavior.
- **Upload target exists** → unchanged. The upload server overwrites silently (this is existing behavior; not in scope to change here).

### Path-scope reminder

- `move_path` operates over the full workspace-scoped tree (the same scope as all other `file_manager` ops).
- The HTTP upload server still only accepts writes under `local_projects/`. Directory uploads land there. This split is preserved, not unified.

## Testing

### Backend

`adapter/test/fs-rpc.test.ts`:

- `manage_path { op: "move" }` — happy path (file move + dir move + rename).
- `target_exists` rejects with the expected error.
- Path-escape attempt (`from: "../etc/passwd"` and `to: "../etc/passwd"`) rejected by `resolve`.
- Hidden-name segment rejected (`from: "local_projects/.env"`, `to: "local_projects/.env.bak"`).

### Frontend

Component test (extend whatever exists for `FileTree.vue`, or add minimal unit coverage):

- Drag a file row onto a folder row → calls `manage_path` with the right `from` / `to`.
- Inline rename → calls `manage_path`; on `target_exists` error, input reverts and error surface shows.
- Directory upload picker → queues N uploads with preserved subpaths.
- Folder drag-drop → walks entries and queues uploads with preserved subpaths.
- Context menu New File pre-fills `<dir>/` in the input strip.

## Files touched

- `adapter/src/fs-rpc.ts` — add `move` to `managePath`, wire `from` / `to` in `dispatch`.
- `adapter/test/fs-rpc.test.ts` — new tests.
- `frontend/src/stores/files.ts` — add `movePath(from, to)` calling `manage_path`.
- `frontend/src/components/files/FileTree.vue` — context menu, inline rename, drag-row-to-folder, directory-upload picker, folder drag-drop walker.
- `frontend/src/components/files/MoveToModal.vue` — new component (directory-only tree picker).
- `frontend/src/services/upload.ts` — no changes; the existing queue handles per-file uploads with arbitrary destDirs.

## Open risks

- `webkitGetAsEntry` is non-standard but works in Chromium, WebKit, and Firefox. Acceptable for an internal devcontainer UI; no fallback.
- `webkitRelativePath` likewise. Same coverage.
- Drag-drop dispatch by MIME type assumes browsers reliably populate `dataTransfer.types` on drop; verified in Chromium / Firefox.
- Inline rename collides with the directory-toggle click handler if not careful — rename mode must stop click propagation on the input.

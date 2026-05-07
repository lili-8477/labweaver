# claude-bioflow share-to-org promotion — design

Date: 2026-05-07
Status: draft for review
Builds on:

- `2026-05-05-agent-memory-design.md` — memory rows already carry an org tier (`username='__org__'`), but only operator-administered direct DB inserts can populate it today. This spec adds the user-facing promotion path.
- Existing per-user vs shared workspace mount split in `hub/scripts/add-user.sh`: per-user skills at `<user>/.claude/skills/`, org skills at `shared/skills/`; per-user projects at `<user>/local_projects/`, org projects at `shared/projects/`.

## 1. Goal

Add a **review-gated promotion path** that lets any per-user container submit a memory row, a skill folder, or a project folder for inclusion in the org-shared tier. A designated **manager** user reviews the submission against a frozen snapshot, approves or rejects with a comment, and on approval the artifact materialises in the shared store where every user sees it.

After this lands:
- A regular user clicks **Share** in the panel on a row/skill/folder → the queue holds the request.
- li86 (or whoever is `MEMORY_ORG_MANAGER`) opens an **Inbox** view, reviews preview + diff, clicks Approve or Reject.
- Approved memory rows appear under **Org** for every user immediately. Approved skills / project folders become read-visible in every user's `~/.claude/skills-shared/` and `/workspace/shared/projects/` (already mounted everywhere).

This makes the org tier a *curated commons* rather than an admin-only black box.

## 2. Non-goals

| Feature | Disposition |
|---|---|
| Multiple managers / N-of-M approval | Future. v1 = single manager, env-configured. |
| Bidirectional sync (org → user "fork") | Out of scope. Org is broadcast-only. |
| Diff-with-comments inline review (line-by-line) | v2. v1 shows full snapshot; reject-with-comment is enough. |
| Subagent-definition sharing (`.claude/agents/<name>.md`) | Deferred. Subagents auto-execute in user sessions; sharing one is an attack surface that needs sandboxing first. |
| Hook sharing (`.claude/hooks/`) | Same reason. |
| Sharing individual files (notebooks, scripts) outside a folder | Use folder kind; no per-file path needed. |
| Versioned/replaceable shared skills (org has `single-cell` v1, request to bump to v2) | v2. v1: name collision → reject with comment. |
| Auto-promotion via a "trusted" flag | Not planned; the gate is the point. |
| Cross-org sharing (multiple orgs in one deployment) | Out of scope. Single org per deployment. |

## 3. Architecture

```
                  ┌──────────────────── per-user container ────────────────────┐
                  │                                                            │
  /workspace ─────┤  Frontend "Share" panel ───── NATS ─── adapter ───── HTTP ─┤
                  │     (Outbox / Inbox)                       │               │
                  └────────────────────────────────────────────┼───────────────┘
                                                               │
                                       ┌───────────────────────┴───────────────┐
                                       │  indexer (the trusted file-ops agent) │
                                       │                                       │
                                       │  POST /share/submit       (queue)     │
                                       │  GET  /share/list         (filter)    │
                                       │  GET  /share/:id          (detail)    │
                                       │  POST /share/:id/decide   (manager)   │
                                       │  POST /share/:id/withdraw (requester) │
                                       │                                       │
                                       │  share_requests (PG)                  │
                                       │  workspaces/ (mounted rw)             │
                                       └───────────────────────┬───────────────┘
                                                               │ on approve:
                                  ┌────────────────────────────┼────────────────────────────┐
                                  │                            │                            │
            memory: INSERT row    │   skill: cp -r              │   folder: cp -r            │
              with username       │   <user>/.claude/skills/<x>/│   <user>/local_projects/<x>/│
              = '__org__'         │   → shared/skills/<x>/      │   → shared/projects/<x>/   │
                                  │                            │                            │
                                  ▼                            ▼                            ▼
                       memories table              shared/skills/   (read-only mount)   shared/projects/  (rw mount)
                                                   propagates to every user instantly
```

Trust boundary: the indexer is the only process with write access to `shared/`. The frontend never touches the file system — it speaks to the adapter, which forwards to the indexer's HTTP API. The username on every request is server-injected from the adapter's `USERNAME` env (same model as memory), so a curious user can't impersonate the manager.

## 4. Data model

### 4.1 `share_requests` table (migration 0010)

```sql
CREATE TABLE share_requests (
  share_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What is being shared.
  artifact_kind   text NOT NULL CHECK (artifact_kind IN ('memory', 'skill', 'folder')),
  artifact_ref    text NOT NULL,
  -- Reference semantics per kind:
  --   memory: the source memory_id (uuid as text)
  --   skill:  the skill folder NAME (basename, e.g. "single-cell"). Resolves to
  --           hub/workspaces/<requester>/.claude/skills/<artifact_ref>/.
  --   folder: the project folder NAME under local_projects/. Resolves to
  --           hub/workspaces/<requester>/local_projects/<artifact_ref>/.

  -- Frozen snapshot at submission time. Manager reviews this, not whatever
  -- the source looks like at decision time. JSON shape varies by kind:
  --   memory: { name, description, body, type, source, facets, scope_tier_at_source }
  --   skill:  { manifest: <SKILL.md text>, files: [{path, sha256, size_bytes}] }
  --   folder: { tree: [{path, sha256, size_bytes}], readme: <body or null>, total_bytes }
  -- For skill+folder we DO NOT inline file bodies in the JSONB (could be MB).
  -- Instead, the snapshot points to a frozen tarball at
  --   hub/workspaces/shared/.share-snapshots/<share_id>.tar.gz
  -- which the manager Detail view streams via GET /share/:id/snapshot/<path>.
  snapshot_meta   jsonb NOT NULL,

  -- Identities. Both are usernames; the manager is set per-deployment via env.
  requester       text NOT NULL,
  reviewer        text NOT NULL,                        -- frozen at submission

  -- State machine.
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  requester_note  text,                                 -- why am I sharing this?
  review_comment  text,                                 -- manager's response (rejection reason / approval rationale)

  -- The result of approve, for forensic / reproduce-from-snapshot. NULL until decided.
  --   memory:  { promoted_memory_id }
  --   skill:   { dest_path, copied_files }
  --   folder:  { dest_path, copied_files, total_bytes }
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

**Why frozen snapshot:** the requester might delete the source memory or rewrite the skill while the request sits in the queue. The manager must review *what was submitted*, not whatever exists at decision time. The `promote` step on approve also reads from the snapshot, not the source — so a race between submit and approve cannot land mutated content under the org tier.

**Snapshot lifecycle:** snapshots persist for the request's life and 30 days after decision (rejected snapshots become valuable forensic material if a user later asks "why was my X rejected"). A scheduled cleanup query removes snapshot tarballs older than 30 days from `decided_at`.

### 4.2 No new audit table

`share_requests.status` + `decided_at` + `review_comment` is the audit trail for promotions. We do NOT replicate `memory_audit_log` here — the share table is itself append-only-ish (only the row's own decision fields mutate, in one transition).

When promotion of a memory creates a new org row, the new row gets an entry in the existing `memory_audit_log` with `action='write'` and a `before` reference linking back to `share_id` for traceability:

```jsonb
{ "via": "share_promotion", "share_id": "<uuid>", "promoted_from": "<src_memory_id>" }
```

## 5. Per-kind mechanics

### 5.1 memory

- **Submit:** requester picks a memory row in the panel, clicks Share, optionally writes a note. Server validates `username == requester` (or `'__org__'`-no, can't share org rows) and copies the row's `(name, description, body, type, facets)` into `snapshot_meta`. If the source is `source='distilled'`, allow it — the agent thought it was important enough to distill, the manager decides if it's org-worthy.
- **Approve:** server inserts a new memory row with `username='__org__'`, `project_dir=NULL`, `source='user'` (treated as user-authored at the org tier), copies name/description/body/facets verbatim from snapshot, fresh `created_at`. Logs an audit row with the share_id link. Records `promotion_result.promoted_memory_id`.
- **Reject:** no DB write, status → 'rejected', comment stored.
- **Withdraw:** requester can withdraw while pending. Sets status → 'withdrawn'.
- **Collisions:** if a memory with the same `(username='__org__', project_dir=NULL, type, content_hash)` exists, the INSERT is suppressed by the existing UNIQUE; promotion_result records `{deduped: true, existing_memory_id: <id>}`. Approve still succeeds — the goal was achieved.

### 5.2 skill

- **Submit:** requester names a skill (basename of a folder under their `~/.claude/skills/`). Server tarballs `hub/workspaces/<requester>/.claude/skills/<name>/` to `shared/.share-snapshots/<share_id>.tar.gz`, records `manifest` (the SKILL.md body) and a file index in `snapshot_meta`. Reject if source path doesn't exist or isn't a directory.
- **Approve:** server checks for collision at `shared/skills/<name>/`. If exists, fail the decision with a 409 — the manager must reject with a comment instead, asking the requester to rename. If absent, untar the snapshot to `shared/skills/<name>/`. Records `promotion_result = {dest_path, copied_files: [...]}`.
- **Reject:** snapshot stays for 30d, no file ops.
- **Read visibility:** every user already mounts `shared/skills/` read-only at `~/.claude/skills-shared/`, so Claude Code auto-discovers the new skill within seconds of approval (no per-user container restart needed — Claude Code reads skills lazily on tool registration).
- **Edit-after-promote:** out of scope. To update an org skill, the manager edits files directly under `shared/skills/<name>/`. (Future v2: an "update" share kind that targets an existing org skill by name.)

### 5.3 folder (project)

Same shape as skill, just different source/dest paths.

- **Submit:** source = `hub/workspaces/<requester>/local_projects/<name>/`. Tarball → `shared/.share-snapshots/<share_id>.tar.gz`. Record `total_bytes`, top-level `README.md` body if present.
- **Reject submission:** if source > 100 MB, reject at submit time (configurable via `SHARE_MAX_FOLDER_BYTES` env, default 100 MB). Sharing notebooks with embedded base64 images can blow this up fast. Manager can override per-request only by asking the requester to slim it down — there's no force-approve for size.
- **Approve:** untar to `shared/projects/<name>/`. Same collision rule as skill.
- **Read visibility:** `shared/projects/` is mounted read-write at `/workspace/shared/projects/` (no `:ro`), so users *can* edit the org project after promotion. That matches the existing intent: `shared/projects/` is the collaboration commons. Promotions seed it; users edit collaboratively from there.

## 6. Manager identity

Single manager for v1, configurable via env var on the indexer service:

```yaml
# hub/docker-compose.yml
indexer:
  environment:
    MEMORY_ORG_MANAGER: li86
```

The indexer reads it at boot, validates it's a known username (must have a workspace under `/workspaces/`), and stamps `reviewer` on every submit with this value. Every `decide` call's actor is checked against this same value before the state transition is applied; mismatched actors get `403 forbidden`.

For multi-manager later: change `MEMORY_ORG_MANAGER` to a comma-separated list, and `share_requests.reviewer` becomes a list-membership check rather than equality. Schema doesn't change. The frontend's "am I a manager?" capability check (§ 9) becomes a server-side answer rather than a string compare.

If `MEMORY_ORG_MANAGER` is unset: `/share/*` endpoints return `503 service unavailable` with `error: 'sharing disabled — no manager configured'`. The Share button in the panel hides itself in that case (frontend reads capabilities at session start).

## 7. Lifecycle / state machine

```
                  ┌──────────────┐  withdraw    ┌────────────┐
                  │              │ ────────────▶│ withdrawn  │  (terminal)
       submit     │   pending    │              └────────────┘
   ─────────────▶ │              │              ┌────────────┐
                  │              │ ───approve──▶│  approved  │  (terminal)
                  │              │              └────────────┘
                  │              │              ┌────────────┐
                  │              │ ────reject──▶│  rejected  │  (terminal)
                  └──────────────┘              └────────────┘
```

Transitions are protected by `SELECT ... FOR UPDATE` on the `share_requests` row inside a transaction; concurrent decide calls on the same id either all succeed-equally (idempotent: same actor, same decision, same comment → same result) or one wins and the others get `409 conflict: already <status>`.

Rejecting an already-decided request returns 409. Withdrawing an already-decided request returns 409. The state machine is strictly forward.

## 8. API surface

### 8.1 Indexer HTTP (private docker network, no auth — adapter is the trust boundary)

```
POST /share/submit
  body: {
    requester: string,        // server-trusted in the adapter; rejected by indexer if absent
    kind: 'memory' | 'skill' | 'folder',
    ref: string,              // memory_id | skill name | folder name
    note?: string             // ≤500c
  }
  → 200 { share_id }
  → 400 { error, issues }     // missing source, oversize folder, etc.
  → 503 { error }             // no manager configured

GET /share/list?actor=<username>&role=outbox|inbox|all&status=pending|...&limit=...&cursor=...
  outbox: where requester = actor (any status)
  inbox:  where reviewer  = actor and status = pending
  all:    where requester = actor OR reviewer = actor
  → 200 { items: [...], next_cursor }

GET /share/:id?actor=<username>
  Owner-or-reviewer-only. Returns the row + snapshot_meta. Does NOT stream
  the snapshot tarball — that's a separate endpoint to keep this cheap.
  → 200 { share: {...}, snapshot_meta: {...} }
  → 403 { error }             // actor is neither requester nor reviewer

GET /share/:id/snapshot/file?actor=<username>&path=<relative_path>
  Streams a single file from the frozen snapshot tarball.
  Used by the Detail view to render skill/folder previews on demand
  (don't unpack the whole tarball, the manager only opens a few files).
  Range-aware so the frontend can preview the first 1 MB of a notebook.
  → 200 file bytes
  → 404 path not in snapshot

POST /share/:id/decide
  body: { actor, decision: 'approve' | 'reject', comment?: string }
  → 200 { ok: true, status, promotion_result? }
  → 403 actor != reviewer
  → 409 already-decided
  → 422 promotion failed (e.g. skill name collision); status stays 'pending', client retries decide with a different decision or asks requester to rename

POST /share/:id/withdraw
  body: { actor }
  → 200 { ok: true, status: 'withdrawn' }
  → 403 actor != requester
  → 409 already-decided
```

### 8.2 Adapter NATS RPC

Mirrors HTTP one-to-one with the same trust pattern as memory_*:

```
share_submit    → {success: true, share_id}
share_list      → {success: true, items, next_cursor}
share_get       → {success: true, share, snapshot_meta}
share_decide    → {success: true, status, promotion_result?}
share_withdraw  → {success: true, status}
share_capabilities  → {success: true, is_manager: boolean,
                                       manager_username: string|null,
                                       pending_inbox_count: number}
```

`actor` is server-injected by the adapter from `process.env.USERNAME`; the frontend never sends it. `share_capabilities` is the bootstrap call the panel makes once at mount to decide whether to render the Inbox tab AND to render a badge `(N)` on the Share tab button when the current user is the manager and the inbox is non-empty. `pending_inbox_count` is `0` for non-managers (they have no inbox to count).

Snapshot file streaming uses HTTP directly (via the existing nginx proxy), not NATS — NATS is wrong for byte streams.

### 8.3 No MCP tool

Sharing is an explicit user action ("I want this in the org"). It's not something the agent should decide on its own. We deliberately do not expose `share_submit` as an MCP tool — keep it human-driven via the panel. (If a future use case justifies "agent suggests sharing," revisit.)

## 9. UI surface

New right-panel **Share** tab next to the existing **Memory** tab.

```
┌─ Share ───────────────────────────────────┐
│  [ Outbox ]  [ Inbox (3) ]                │   ← Inbox tab only if is_manager
├───────────────────────────────────────────┤
│  ◍ memory  use mm10 for mouse...         │   ← list rows; left edge icon = kind
│   pending · 2h ago · awaiting li86       │
│ ───                                       │
│  ◉ skill   single-cell-qc                │
│   approved · 1d ago · "great writeup"    │
│ ───                                       │
│  ◐ folder  pbmc3k_celltypist             │
│   rejected · 3d ago · "drop the bam"     │
└───────────────────────────────────────────┘
```

Click any row → split-pane detail showing:
- Header: kind, ref, requester, reviewer, status, timestamps.
- For `memory`: the snapshot's name/description/body/facets (renders identical to MemoryDetail).
- For `skill`: SKILL.md body verbatim + file tree; click a filename to fetch its snapshot bytes via `/share/:id/snapshot/file`.
- For `folder`: file tree + README preview; same on-demand file streaming.
- Action bar (manager + status='pending' only): textarea for `review_comment`, [Approve] [Reject] buttons.
- Action bar (requester + status='pending'): [Withdraw] button.
- For terminal states: comment + decided_at shown read-only.

**Share button placement** (the entry points that submit a request):
- Memory rows: existing MemoryDetail action bar gains a `[Share]` button next to Forget. Disabled for distilled rows? No — distilled is fine to share; manager judges value.
- Skills: needs a dedicated "Skills" panel that lists `~/.claude/skills/` per user with a Share button per skill. **This panel does not exist today.** v1 ships a minimal listing component (name + description from SKILL.md frontmatter + Share button) — no full skill editor.
- Folders: the existing Files panel knows project folder paths. Add a Share button to each `local_projects/<name>/` directory's context menu. Top-level only — sharing a sub-directory of a project doesn't make sense (the org-projects mount expects whole-project units).

Submit flow on any of these buttons:
1. Modal: "Share <name> with the org?" + textarea for `requester_note` + [Cancel] [Submit].
2. On submit: `share_submit` RPC → toast "submitted, awaiting <manager>".
3. The Share panel's Outbox now shows the new pending row.

## 10. Trust boundaries

| Layer | Trusts | Enforces |
|---|---|---|
| Frontend | adapter (it never gets to choose `actor`) | nothing — just renders |
| Adapter | env-injected `USERNAME` | injects `actor`/`requester` on every share_* call |
| Indexer | `MEMORY_ORG_MANAGER` env (operator-set at compose time) | all auth checks: requester ownership of source, reviewer == manager on decide, status transitions |
| File system | indexer's writable mount `/workspaces` | only the indexer touches `shared/skills/` and `shared/projects/` |

The indexer needs to write `shared/skills/` and `shared/projects/`. Today its compose mount is `./workspaces:/workspaces:ro`. Change to `:rw` (drop the `:ro` suffix). The promotion code is the only writer; reads (existing JSONL projection, etc.) don't need rw but they're harmless.

Validation at submit time:
- `kind=memory`: `SELECT 1 FROM memories WHERE memory_id=$ref AND username=$requester AND deleted_at IS NULL`. Must exist, must be requester-owned, must be live.
- `kind=skill`: `path.resolve('/workspaces/<requester>/.claude/skills/' + ref)` must (a) be a directory, (b) resolve INSIDE that directory after path normalisation (defends against `../../../etc/passwd` style refs).
- `kind=folder`: same path-traversal guard against `local_projects/`.

The path-traversal guard is non-optional. We use `path.resolve` and then check `resolved.startsWith(safe_root)` after both have been canonicalised. A failed check is a 400 with `error: 'invalid ref'` (don't leak which guard tripped).

## 11. MVP slice (memory-only)

Phase 1 of this work ships memory promotion only. Skills and folders defer to phase 2.

**Why MVP=memory:**
- It's a ~20-line addition to `memory-repo.ts` to implement the `INSERT ... SELECT` for the approve path; no file ops, no tarballs, no path-traversal guards.
- The queue infrastructure (table, state machine, API, UI) is the same regardless of artifact kind. Building it once with one kind exercised end-to-end shrinks the scope of the first review checkpoint.
- The frontend Share button on memory rows reuses 100% of MemoryPanel's plumbing.

What's in the MVP:
- Migration 0010 `share_requests` table (full schema, all kinds covered).
- Indexer routes for all five HTTP endpoints; the kind-dispatch switch in `submit` and `decide` handles `memory` only and returns `501 not implemented` for `skill`/`folder`.
- Adapter NATS bridge for share_*.
- Frontend Share panel (Outbox + Inbox + Detail), Share button on MemoryDetail.
- `MEMORY_ORG_MANAGER=li86` in compose.

What MVP defers to phase 2:
- Tarball snapshotting under `shared/.share-snapshots/`.
- Path-traversal guards (only relevant once kind != memory).
- Indexer mount becomes `:rw` (only needed when we start writing files).
- Skills panel.
- Folder Share entry point in Files panel.

## 12. Phase split

| Phase | Scope | Estimated tasks (writing-plans output) |
|---|---|---|
| 1 (MVP) | memory-only end-to-end | ~10–12 tasks, similar shape to sub-phase C. |
| 2 | skill kind: tarball snapshots, path-traversal guards, indexer mount swap, Skills panel | ~8 tasks. |
| 3 | folder kind: same machinery as skill but on `local_projects/`, Files-panel context menu, size cap | ~6 tasks. |
| 4 (later) | multi-manager, update-existing-skill kind, snapshot cleanup cron, line-by-line review | TBD; not in scope of this spec. |

Each phase is shippable on its own. After phase 1 you can promote memories to org through the panel; phase 2 adds skills; phase 3 adds folders.

## 13. Resolved decisions

Locked-in answers to the open questions raised during review (2026-05-07):

1. **Distilled memory rows are shareable.** The manager is the quality gate; `hit_count > 0` on a distilled row is an organic quality signal. The Inbox Detail view surfaces `source: distilled · hit_count: N · last_hit_at: …` next to the Approve button so the manager isn't blind-stamping autogen.
2. **Skill name collisions fail with 422; manager rejects with rename suggestion.** Auto-suffix produces `single-cell-2`, `single-cell-3` and nobody cleans them up. One round-trip is cheap because skill promotions are rare.
3. **Withdraw window is unlimited; no auto-close in v1.** Auto-rejection on idle is the conceptually correct framing (it's the reviewer failing, not the requester) but adds a cron + a fifth status. Defer to v2 if the queue actually gets stale.
4. **Inbox badge count, no realtime.** `share_capabilities` returns `pending_inbox_count: number`; the Share tab button renders `(N)` when manager + count > 0. Refreshes when the panel opens — no polling, no NATS subscription. Slack/email pings, push notifications, etc. → v2 only if asked.
5. **No org→user "fork" verb.** Building one encourages fragmentation of the canonical org tier. The three one-liners (`cp -r` for skills/folders, fresh `/memorize` for memory) are sufficient and put the friction in exactly the right place.

## 14. Reference: file paths touched

- `hub/indexer/migrations/0010_share_requests.sql` — new
- `hub/indexer/src/share-repo.ts` — new (state machine, snapshot helpers)
- `hub/indexer/src/share-api.ts` — new (HTTP routes)
- `hub/indexer/src/index.ts` — wire repo + api
- `adapter/src/share-rpc.ts` — new
- `adapter/src/rpc.ts` — six new `share_*` cases
- `frontend/src/types/share.ts` — new
- `frontend/src/services/share.ts` — new
- `frontend/src/stores/share.ts` — new (Pinia)
- `frontend/src/components/share/SharePanel.vue` — new
- `frontend/src/components/share/ShareList.vue` — new (Outbox + Inbox tab toggle)
- `frontend/src/components/share/ShareDetail.vue` — new (kind-specific previews, action bar)
- `frontend/src/components/memory/MemoryDetail.vue` — modify (add Share button)
- `frontend/src/components/layout/MainLayout.vue` — modify (add 'share' to RightPanel union)
- `hub/docker-compose.yml` — modify (add `MEMORY_ORG_MANAGER`, drop `:ro` from indexer mount in phase 2)

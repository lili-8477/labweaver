# claude-bioflow session memory — Phase 2 design

Date: 2026-04-22
Status: draft for review
Builds on: `2026-04-22-claude-bioflow-session-memory-phase-1-design.md` (indexer landed)

## 1. Goal

Retire `adapter/src/sessions.ts` (the JSON sidecar) and serve `list_chats` /
`create_chat` / `delete_chat` / `update_chat_name` / `get_chat_messages` /
`set_active_agent` from Postgres. The indexer already populates `sessions`
and `token_usage_log`; Phase 2 adds a thin `chats` table for user-owned
identity and wires the adapter to it. No new HTTP service, no new auth
layer — the adapter already sits behind NATS-over-WebSocket per user.

After Phase 2, a user can open a session on one device and see it from
another: the authoritative state lives in Postgres, not in the devcontainer's
local `.pantheon/chats/*.json`.

## 2. Why a `chats` table (can't we use `sessions`?)

Chat identity (user-facing `chat_id`, name, active agent) and session
aggregates (SDK-assigned `session_id`, message count, tokens) diverge:

- **`chat_id` ≠ `session_id` in general.** The adapter assigns `chat_id`
  when the user clicks "New chat"; the SDK assigns `session_id` on the
  first turn, and they can mismatch after a failed resume. The sidecar
  stores `{chat_id, session_uuid}`; that mapping must survive retirement.
- **Empty chats have no JSONL and therefore no `sessions` row yet.**
  `list_chats` must still show them.
- **Name, active_agent** are user-owned — not derivable from JSONL.

One new table: `chats`. `sessions` is unchanged from Phase 1.

## 3. Non-goals (Phase 2)

| Feature | Phase |
|---|---|
| HTTP API (`GET /api/sessions`, etc.) | 3+ (deferred; adapter-direct-PG makes it unnecessary for now) |
| Cross-file `parent_session_id` linkage for subagents | 3 (requires JSONL re-scan; `is_sidechain` flag is enough to hide them from the main list) |
| Soft-delete, undelete, audit log | 4 |
| MinIO / S3 cold storage | 3 |
| Metrics endpoint | not scoped |

## 4. Architecture

```
frontend ──WebSocket──► nginx ──► per-user adapter container
                                    │
                                    ├── NATS: unchanged (chat I/O)
                                    ├── PG:   NEW — sessions + chats + token_usage_log
                                    └── JSONL: unchanged (get_chat_messages reads directly)
```

- **Adapter** gains a `pg.Pool` constructed from `PG_URL` (injected by
  `hub/scripts/add-user.sh`). All sidecar reads/writes are replaced with
  SQL.
- **Indexer** extends its parser to also recognise `type === "summary"`
  JSONL entries and propagate them to `sessions.title` (best-effort; user
  renames via the adapter take precedence).
- **Sidecar** (`adapter/src/sessions.ts`) is deleted. Existing
  `.pantheon/chats/*.json` files are ignored; a one-shot migration script
  imports them into PG on first adapter boot after the upgrade (opt-in via
  env var, runs once per container).
- **Frontend** is not touched. NATS RPC wire shape is unchanged:
  `list_chats` returns the same `ChatInfo[]` shape; `chat_id` is still the
  public id.

## 5. Schema change

### 5.1 `migrations/0004_chats.sql`

```sql
CREATE TABLE chats (
  chat_id        UUID PRIMARY KEY,
  username       TEXT NOT NULL,
  session_id     UUID,                        -- populated once SDK emits it
  name           TEXT NOT NULL DEFAULT 'New chat',
  active_agent   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ                  -- reserved for Phase 4 soft-delete
);

CREATE INDEX chats_username_last_used_idx
  ON chats (username, last_used_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX chats_session_id_idx
  ON chats (session_id) WHERE session_id IS NOT NULL;
```

Notes:

- No FK from `chats.session_id` to `sessions.session_id`. Chats can exist
  before any JSONL writes produce a session row; forcing a FK would mean
  creating empty `sessions` rows as placeholders. Keep it loose.
- `deleted_at` is Phase-4 scaffolding; Phase 2 only hard-deletes.
- `last_used_at` is updated by the adapter on every chat activity (send
  message, rename). `sessions.last_active` stays as "when JSONL last
  wrote" — a different semantic.

### 5.2 `sessions` — no migration, but behaviour extension

Phase 1 leaves `sessions.title` always NULL. Phase 2:

- Indexer parses `type:"summary"` JSONL entries (skipped in Phase 1) and
  writes the summary string to `sessions.title` with a last-write-wins
  upsert clause:
  ```sql
  title = COALESCE(EXCLUDED.title, sessions.title)
  ```
  With EXCLUDED.title set to the most recent summary's text (or NULL if
  none in this pass). User-set titles live in `chats.name`, so there's no
  conflict.

### 5.3 Union view for `list_chats`

The adapter queries one join per `list_chats` call:

```sql
SELECT
  c.chat_id                         AS id,
  c.name                            AS name,
  c.active_agent                    AS active_agent,
  c.last_used_at                    AS last_activity_date,
  COALESCE(s.project_display, '')   AS project_name,
  s.is_sidechain                    AS is_sidechain,
  s.model                           AS model
FROM chats c
LEFT JOIN sessions s ON s.session_id = c.session_id
WHERE c.username = $1
  AND c.deleted_at IS NULL
  AND (s.is_sidechain IS DISTINCT FROM true)     -- hide subagent chats
ORDER BY c.last_used_at DESC
LIMIT $2 OFFSET $3;
```

## 6. Adapter changes

### 6.1 File tree diff

```
adapter/
├── package.json                       # + "pg": "^8.13.1"
├── src/
│   ├── db.ts                          # NEW — Pool + typed chat/session queries
│   ├── sessions.ts                    # DELETE
│   ├── rpc.ts                         # modify — SessionStore → db
│   ├── claude.ts                      # modify — capture session_id → chats.session_id
│   └── index.ts                       # modify — load PG_URL from env, wire pool
└── test/
    ├── db.test.ts                     # NEW — chat CRUD + list_chats view
    └── sidecar-import.test.ts         # NEW — one-shot .pantheon/chats/*.json → PG
```

### 6.2 Chat lifecycle in PG terms

| RPC | Current (sidecar) | Phase 2 (PG) |
|---|---|---|
| `create_chat` | Write `.pantheon/chats/<id>.json` | `INSERT INTO chats (chat_id, username, name) VALUES (...) ON CONFLICT DO NOTHING` |
| `list_chats` | `readdir` sidecar dir, parse each | One join query (§5.3) |
| `update_chat_name` | Merge into sidecar JSON | `UPDATE chats SET name=$2, last_used_at=now() WHERE chat_id=$1` |
| `set_active_agent` | Merge into sidecar JSON | `UPDATE chats SET active_agent=$2 WHERE chat_id=$1` |
| `delete_chat` | `unlink` sidecar | `DELETE FROM chats WHERE chat_id=$1` (CASCADE is not set; orphaned sessions rows remain — they're the truth of JSONL, not ours to delete) |
| `get_chat_messages` | `sidecar.session_uuid ?? chat_id` → JSONL parse | `SELECT session_id FROM chats WHERE chat_id=$1` then same JSONL parse |
| SDK `onSessionId(sid)` callback | `sessions.update(chat_id, {session_uuid})` | `UPDATE chats SET session_id=$2, last_used_at=now() WHERE chat_id=$1 AND (session_id IS NULL OR session_id != $2)` |

Notes:

- `delete_chat` leaves `sessions` / `token_usage_log` rows in place. The
  JSONL file on disk is the source of truth for session data; if the user
  is merely hiding a chat from their list, the session aggregates are
  still meaningful for billing rollups. Phase 4 soft-delete is where the
  UX "undo" lives.
- `get_chat_messages` still streams JSONL via `readSessionMessages` — the
  sidecar was never the source for message content, only the id mapping.

### 6.3 PG_URL provisioning

`hub/scripts/add-user.sh` already writes a per-user `.env`. Extend it:

```bash
# Existing
ANTHROPIC_API_KEY=sk-ant-...

# NEW — points at the hub postgres over the shared docker network.
PG_URL=postgres://bioflow:${POSTGRES_PASSWORD}@claude-bioflow-postgres:5432/bioflow
```

Per-user adapter container joins the hub's `bioflow-net` (already the
case — `add-user.sh` line 78). DB user `bioflow` is shared; tenant
scoping is enforced by every adapter query including `WHERE username=$1`.
Each adapter knows its own `${USERNAME}` from the `ID_HASH`-derived
identity the harness already computes.

### 6.4 Username inside the adapter

The adapter container receives `USERNAME=<user>` as an env var (new — add
to `add-user.sh` docker run). All PG queries filter by it. No
cross-tenant reads are possible even if a request crafts a bogus
`chat_id` — the WHERE clause filters it out.

### 6.5 One-shot sidecar import (`sidecar-import.ts`)

On adapter boot, if `$SIDECAR_IMPORT_ON_BOOT=1` (default off after first
successful run, controlled by a sentinel file), scan
`.pantheon/chats/*.json`, upsert each into `chats`, then delete the
sidecar file. Idempotent via `ON CONFLICT (chat_id) DO NOTHING`. Log a
summary. The operator rolls users one-by-one by starting them with the
env var, then unsetting it.

Alternative: don't bother — users accept a "lose empty chats" cost and
continue. Defer the call until an operator asks.

Recommend: **keep the importer**, since it's 50 LOC and spares support
pain. Defer deleting the code itself until Phase 3.

## 7. Indexer changes

### 7.1 Parse `type:"summary"` entries

`src/jsonl-parser.ts` skips `summary` today. Extend `ParsedEntry` with an
optional `title?: string` field, and emit:

```ts
if (type === "summary") {
  const summary = obj.summary;
  const leafUuid = obj.leafUuid;
  if (typeof summary !== "string" || typeof leafUuid !== "string") return null;
  return { type: "summary", uuid: leafUuid, sessionId: leafUuid /* summary
    entries don't carry sessionId directly — we join later */, ... };
}
```

Hmm — actually `summary` entries reference a `leafUuid` (the last user
message), not `sessionId`. Looking up the session for that uuid requires
a second DB query. Simpler: track the current session's latest summary
per file and emit it as part of the `SessionUpsert.title_candidate`
field. The projector does the collection (pure), the db layer does the
COALESCE.

Decide in implementation: if `summary` entries reliably carry a
`sessionId` alongside `leafUuid`, use that; else skip title derivation in
Phase 2 and let user renames (via `update_chat_name` → `chats.name`) own
the UI title. The frontend prefers `chats.name` over `sessions.title`
anyway. **Recommended: skip indexer title derivation in Phase 2; revisit
in Phase 3 after inspecting real summary entries.**

### 7.2 No other indexer changes

Phase 2 leaves the indexer's watcher, projector aggregation, and commit
semantics untouched. Phase 1's three-fix round already ensured
correctness under rotation, truncation, and oversized lines.

## 8. Error handling (new surfaces)

| Failure | Behaviour |
|---|---|
| Adapter boots, PG unreachable | Exponential backoff up to 5 min, then exit 1; container restart policy retries. Matches indexer's pattern. |
| `list_chats` fails (PG dropped mid-query) | Return `{success: false, error: "..."}` via the RPC; frontend shows an error. |
| `create_chat` fails after `chats` insert but before response | Insert is committed; client retries with a different `chat_id`; orphaned chat row is harmless (operator can purge). |
| Sidecar JSON is malformed during import | Skip, log, continue. Don't block the user's session. |
| Tenant boundary violation (a query forgets `WHERE username`) | Compile-time: wrap all queries in a `ChatsRepo` class that always injects `username` from the adapter's startup env. Runtime: no `username`-free query path exists. |

## 9. Testing

- `adapter/test/db.test.ts` — testcontainers-backed: runs migrations (all
  four now), verifies CRUD + the `list_chats` join, + multi-tenant
  isolation (insert as alice, read as bob, assert empty).
- `adapter/test/sidecar-import.test.ts` — tmp dir with three fixture
  `.json` files, run importer against a fresh PG, assert three rows in
  `chats`, sentinel file created, re-run is a no-op.
- `hub/indexer/test/migrations-smoke.test.ts` — extend to also check
  `chats` table + its two indexes.
- End-to-end test (manual, not CI): `add-user.sh alice ...`, start the
  frontend, click "New chat", send a message, click "New chat" again,
  reload, confirm both chats in list.

## 10. Configuration

| Adapter env var | Required | Default | Notes |
|---|---|---|---|
| `PG_URL` | yes (Phase 2 only) | — | `postgres://bioflow:...@claude-bioflow-postgres:5432/bioflow` |
| `USERNAME` | yes | — | Tenant key. `add-user.sh` sets it. |
| `SIDECAR_IMPORT_ON_BOOT` | no | `0` | Set to `1` on first Phase 2 upgrade; script unsets after import. |

Indexer adds nothing new.

## 11. Rollout

1. Land migration 0004 + indexer summary-title change (optional, can skip
   per §7.2).
2. Land adapter `db.ts` + the rewired RPC handlers + the sidecar importer,
   GATED by a boot-time `PG_ENABLED=1` env var. With flag off, adapter
   uses the old sidecar (zero regression).
3. Switch one user by flipping their `.env` flag and restarting their
   container; verify from the frontend.
4. Flip the rest; confirm the sidecar directory drains via the importer.
5. Remove the flag code and `sessions.ts` in a follow-up commit once
   every user is on PG.

## 12. Phase boundary

After Phase 2, the system supports:

- Cross-device chat access: a user sees their chat list from any browser
  pointed at their adapter.
- A single `SELECT` against `chats` gives a user's complete chat list
  without touching disk.
- `sessions.ts` is deleted; `.pantheon/chats/*.json` no longer written.

What still doesn't work after Phase 2 (by design):

- Subagent parent linkage — `is_sidechain` hides subagent chats but doesn't
  link them to parents. Phase 3.
- Cold storage — all JSONL stays on the host volume. Phase 3.
- Soft-delete / undelete — `deleted_at` column exists but isn't populated.
  Phase 4.
- HTTP API — adapter-direct-PG obviates the need; revisit if an external
  (non-adapter) consumer appears.

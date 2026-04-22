# claude-bioflow session memory — Phase 1 design

Date: 2026-04-22
Status: approved for implementation planning
Project: `/home/lili/claude-bioflow`

## 1. Goal

Add a shared, host-side index of Claude Code sessions on top of the JSONL
files Claude Code already writes inside each user's devcontainer. Phase 1
delivers only the indexer and its storage — no HTTP API, no adapter
changes, no lifecycle. After Phase 1 lands, `SELECT * FROM sessions` shows
every user's session state, updated within seconds of JSONL writes, and the
existing system keeps running unchanged.

The full roadmap is four phases: indexer (this spec), HTTP API + adapter
rewire, hot/warm/cold lifecycle to object storage, then hardening
(soft-delete, audit log, RLS-style query enforcement). Each phase is
designed to land without breaking the prior one.

## 2. Non-goals (Phase 1)

| Feature | Phase |
|---------|-------|
| HTTP API (`GET /api/sessions`, etc.) | 2 |
| Retire `adapter/src/sessions.ts` sidecar | 2 |
| Title derivation (summary JSONL + `/rename` → PG) | 2 |
| `parent_session_id` linkage across files | 2 |
| Auth wiring (nginx `$remote_user` → API) | 2 |
| MinIO / S3, hot/warm/cold lifecycle | 3 |
| Soft-delete + undelete | 4 |
| Audit log | 4 |
| Query-builder / RLS enforcement of `username` | 4 |
| Metrics endpoint / dashboards | not scoped |
| `users` table | not planned — `username` is the tenant key project-wide |

## 3. Architecture

One new long-running TypeScript service (`hub/indexer/`) running on the
host as a docker-compose service alongside NATS + nginx. It watches all
users' JSONL files via a read-only bind-mount of the workspaces tree and
writes to a shared PostgreSQL instance.

```
                       ┌─────────────────────────────────────┐
                       │       host (docker-compose)         │
                       │                                     │
  per-user container ──┼─► ./workspaces/<user>/              │
  ~/.claude/projects/  │         claude-projects/*.jsonl ────┼──► indexer ──► postgres
                       │                                     │
                       └─────────────────────────────────────┘
```

- **Indexer**: Node 20 + TypeScript. Watches JSONL via `chokidar`. Parses
  line-by-line with byte-offset resume. Writes sessions + token_usage_log
  rows via `pg`.
- **Postgres**: `postgres:16-alpine`. Data dir in `hub/postgres-data/`
  (gitignored).
- **No NATS dependency**: the indexer is independent of the adapter's NATS
  contract. If NATS is down, indexing continues.
- **No sidecar involvement**: the indexer ignores
  `<workspace>/.pantheon/chats/*.json` entirely. That sidecar stays in
  place for Phase 1 so the adapter keeps working; Phase 2 retires it.

### Why TypeScript (not Python as originally sketched)

The existing adapter is TypeScript and already knows the Claude Code JSONL
shape (`adapter/src/history.ts`). A second language for the same data
would duplicate type definitions and parsing knowledge across the repo.
`chokidar` + `pg` are mature enough to match what `watchdog` + `psycopg`
would provide.

### Why a shared host service (not per-container sidecar)

One filesystem watcher is cheaper and simpler than N container-local
sidecars all phoning into the same PG. The host already owns the
workspaces tree through bind-mounts; it's the natural vantage point. It
also keeps the devcontainer image small and keeps user containers free of
backend concerns.

## 4. File tree added

```
claude-bioflow/
├── .gitignore                                       # + hub/postgres-data/, + hub/.env
├── docker-compose.dev.yml                           # + claude-projects bind-mount on adapter service
├── hub/
│   ├── docker-compose.yml                           # + postgres, + indexer services
│   ├── scripts/
│   │   └── add-user.sh                              # + mkdir claude-projects, + bind-mount
│   └── indexer/                                     # NEW service
│       ├── package.json                             # chokidar, pg, pino, dotenv
│       ├── tsconfig.json
│       ├── Dockerfile                               # node:20-alpine, build to dist/
│       ├── src/
│       │   ├── index.ts                             # entrypoint: connect PG, run migrations, start watcher
│       │   ├── config.ts                            # env parsing
│       │   ├── db.ts                                # pg Pool + typed helpers
│       │   ├── migrate.ts                           # advisory-locked migration runner
│       │   ├── jsonl-parser.ts                      # line → ParsedEntry | null (pure)
│       │   ├── path-decode.ts                       # watch path → {username, encodedProjectDir, sessionId}
│       │   ├── session-projector.ts                 # ParsedEntry[] → SessionUpsert + TokenUsageRow[]
│       │   └── watcher.ts                           # chokidar + per-file serial queue
│       ├── migrations/
│       │   ├── 0001_sessions.sql
│       │   ├── 0002_token_usage_log.sql
│       │   └── 0003_file_offsets.sql
│       └── test/
│           ├── fixtures/
│           │   ├── simple-session.jsonl
│           │   ├── tool-call-session.jsonl
│           │   ├── subagent-session.jsonl
│           │   └── malformed-lines.jsonl
│           ├── jsonl-parser.test.ts
│           ├── session-projector.test.ts
│           ├── path-decode.test.ts
│           ├── migrate.test.ts
│           └── integration/
│               ├── tail-live-writes.test.ts
│               ├── restart-resume.test.ts
│               ├── rotation.test.ts
│               ├── concurrent-files.test.ts
│               └── backlog-on-boot.test.ts
└── docs/superpowers/specs/
    └── 2026-04-22-claude-bioflow-session-memory-phase-1-design.md   # this file
```

## 5. Mount layout changes

### 5.1 `hub/docker-compose.yml` — new services

```yaml
postgres:
  image: postgres:16-alpine
  env_file: [ ./.env ]                   # supplies POSTGRES_PASSWORD (see §5.5)
  environment:
    POSTGRES_USER: bioflow
    POSTGRES_DB: bioflow
  volumes: [ ./postgres-data:/var/lib/postgresql/data ]
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U bioflow"]
    interval: 5s
  restart: unless-stopped
  networks: [bioflow-net]

indexer:
  build: ./indexer
  env_file: [ ./.env ]
  environment:
    PG_URL: postgres://bioflow:${POSTGRES_PASSWORD}@postgres:5432/bioflow
    WORKSPACES_ROOT: /workspaces
    MAX_CONCURRENT_FILES: "8"
    LOG_LEVEL: info
  volumes:
    - ./workspaces:/workspaces:ro       # JSONL read-only; offsets live in PG, not on disk
  depends_on:
    postgres: { condition: service_healthy }
  restart: unless-stopped
  networks: [bioflow-net]
```

The workspaces mount is `:ro` because the indexer has no reason to write
into user workspaces. Offsets are in PG, logs go to stdout.

### 5.2 `hub/scripts/add-user.sh` — new steps per user

```bash
mkdir -p "hub/workspaces/${user}/claude-projects"
chown "$(id -u):$(id -g)" "hub/workspaces/${user}/claude-projects"

# in the per-user `docker run`:
-v "$(pwd)/workspaces/${user}/claude-projects:/home/node/.claude/projects"
```

Adds one mount line and one mkdir. No other changes to the hub.

### 5.3 `docker-compose.dev.yml` — same mount on the single-user adapter

```yaml
adapter:
  volumes:
    # ...existing mounts...
    - ./hub/workspaces/devuser/claude-projects:/home/node/.claude/projects
```

Plus copies of the `postgres` and `indexer` service blocks from §5.1
(pointing at `./hub/workspaces` and `./hub/postgres-data` rather than
`./workspaces` / `./postgres-data` because the dev compose sits at the
repo root, not inside `hub/`). The dev compose then exercises the full
Phase 1 path for a single user.

### 5.4 Multi-tenancy at the filesystem layer

Every JSONL path under the indexer is
`/workspaces/<username>/claude-projects/<encoded-project-dir>/<session>.jsonl`.
The username is the first path segment under `WORKSPACES_ROOT` and is
trusted as the tenant key. No container can write into another user's
claude-projects directory because Docker mounts are per-container.

### 5.5 Hub `.env` (new)

`hub/.env` (gitignored; operator-provided) carries at minimum:

```
POSTGRES_PASSWORD=<random, generated at first hub setup>
```

`hub/scripts/add-user.sh` gains a one-time generator: if `hub/.env` is
missing, it creates one with `openssl rand -base64 32 | tr -d '=+/'` for
the password. Keeps ops surface zero for the first-run case.

## 6. Schema + migrations

### 6.1 Migration runner (`src/migrate.ts`)

~60 lines of TypeScript, no third-party migration library. Flow:

```
acquire pg_advisory_lock(MIGRATION_LOCK_KEY)   -- serialise concurrent boots
CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY, applied_at TIMESTAMPTZ)
list migrations/*.sql, sort by leading integer
for each version > MAX(version):
    BEGIN;
      <file contents>
      INSERT INTO schema_migrations(version, applied_at) VALUES ($1, now());
    COMMIT;
release pg_advisory_lock(MIGRATION_LOCK_KEY)
```

`MIGRATION_LOCK_KEY = 0x62696F666C77` ("bioflw" as hex bytes). Documented
as a constant.

No down migrations. Schema evolution is forward-only; if a mistake lands,
the next migration corrects it.

### 6.2 `migrations/0001_sessions.sql`

```sql
CREATE TABLE sessions (
  session_id          UUID PRIMARY KEY,
  username            TEXT NOT NULL,
  parent_session_id   UUID,
  encoded_project_dir TEXT NOT NULL,
  project_display     TEXT,
  title               TEXT,
  model               TEXT,
  message_count       INT  NOT NULL DEFAULT 0,
  token_usage         JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_active        TIMESTAMPTZ,
  last_active         TIMESTAMPTZ,
  jsonl_location      TEXT NOT NULL DEFAULT 'volume',
  status              TEXT NOT NULL DEFAULT 'active',
  is_sidechain        BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX sessions_username_last_active_idx
  ON sessions (username, last_active DESC);

CREATE INDEX sessions_username_project_last_active_idx
  ON sessions (username, encoded_project_dir, last_active DESC);

CREATE INDEX sessions_parent_idx
  ON sessions (parent_session_id) WHERE parent_session_id IS NOT NULL;

CREATE INDEX sessions_status_last_active_idx
  ON sessions (status, last_active) WHERE status = 'active';
```

Columns explained:

- `session_id` — Claude Code session UUID. `chat_id == session_id`.
- `username` — tenant key, trusted from the watch path prefix.
- `parent_session_id` — null in Phase 1; populated in Phase 2 when
  cross-file linkage lands.
- `encoded_project_dir` — stored verbatim from the filesystem. Lossless.
- `project_display` — best-effort decode of `encoded_project_dir` for the
  UI. Documented as display-only.
- `title` — null in Phase 1. Phase 2 populates from `/rename` and summary
  JSONL.
- `token_usage` — `{input, output, cache_read, cache_write}`. JSONB so
  future Anthropic-added usage categories land without a migration.
- `jsonl_location` — `'volume'` always in Phase 1; Phase 3 flips it to an
  `s3://...` URL for cold-storage records.
- `status` — `'active' | 'archived' | 'deleted'`. Only `'active'` used in
  Phase 1.
- `is_sidechain` — true if any entry in the session had
  `isSidechain: true`. Lets the UI hide subagent sessions from the main
  list without a join.

### 6.3 `migrations/0002_token_usage_log.sql`

```sql
CREATE TABLE token_usage_log (
  id                  BIGSERIAL PRIMARY KEY,
  username            TEXT NOT NULL,
  session_id          UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  entry_uuid          UUID NOT NULL,
  model               TEXT,
  input_tokens        INT  NOT NULL DEFAULT 0,
  output_tokens       INT  NOT NULL DEFAULT 0,
  cache_read_tokens   INT  NOT NULL DEFAULT 0,
  cache_write_tokens  INT  NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL,
  UNIQUE (session_id, entry_uuid)
);

CREATE INDEX token_usage_log_username_created_idx
  ON token_usage_log (username, created_at);

CREATE INDEX token_usage_log_session_idx
  ON token_usage_log (session_id, created_at);
```

`created_at` is the JSONL entry's `timestamp`, not the ingestion time —
billing rollups must reflect when the cost was incurred, not when the
indexer saw it.

`UNIQUE (session_id, entry_uuid)` enables `ON CONFLICT DO NOTHING` for
idempotent replay. The natural key is the JSONL entry's top-level `uuid`.

The FK to `sessions` is satisfied because the projector upserts the
session row and inserts token_usage_log rows in the same transaction.

### 6.4 `migrations/0003_file_offsets.sql`

```sql
CREATE TABLE file_offsets (
  username     TEXT NOT NULL,
  jsonl_path   TEXT NOT NULL,
  byte_offset  BIGINT NOT NULL,
  inode        BIGINT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (username, jsonl_path)
);
```

Offsets live in PG, not on disk, so they advance in the same transaction
as the rows they guard. Crash-between-insert-and-offset-commit is
impossible by construction.

`inode` is the `fs.stat().ino` at the last read. If it changes (file
replaced) or if file size shrinks below the stored offset (truncation),
the worker resets `byte_offset` to 0 on the next pass.

## 7. Indexer internals

### 7.1 Watcher + per-file worker (`src/watcher.ts`, `src/index.ts`)

```ts
const glob = `${WORKSPACES_ROOT}/*/claude-projects/*/*.jsonl`;
chokidar.watch(glob, {
  persistent: true,
  awaitWriteFinish: false,
  ignoreInitial: false,   // 'add' fires for existing files on boot → backlog through same path
  alwaysStat: true,
});
```

Per-file state is an in-memory map keyed by absolute path:
`{processing: bool, reprocess: bool}`. A global `Semaphore(MAX_CONCURRENT_FILES)`
bounds concurrency (default 8).

On any `add` / `change` event:

```
state = map.get(F) ?? {processing: false, reprocess: false}
if state.processing:
  state.reprocess = true
  return
state.processing = true
acquire semaphore
try { await processFile(F) } finally { release semaphore; state.processing = false }
if state.reprocess: state.reprocess = false; self-trigger
```

No debounce timer anywhere. Coalescing happens via the `reprocess` flag:
many events during one pass collapse into at most one extra pass.

`processFile(F)`:

```
stat = fs.stat(F)                           // size, ino
{username, encodedProjectDir, sessionId} = resolveJsonlPath(WORKSPACES_ROOT, F)
prior = SELECT byte_offset, inode FROM file_offsets WHERE username=$1 AND jsonl_path=$2
startOffset =
  (prior && prior.inode === stat.ino && stat.size >= prior.byte_offset)
    ? prior.byte_offset : 0
bytes   = read file from startOffset to stat.size
entries = bytes.split('\n').filter(Boolean).map(parseJsonlLine).filter(nonNull)
{sessionUpsert, tokenRows} =
  projectEntries(entries, {sessionId, username, encodedProjectDir, filePath: F})
BEGIN;
  upsertSession(sessionUpsert)                           // delta merge (see §7.3)
  for row of tokenRows: insertTokenUsage(row)            // ON CONFLICT DO NOTHING
  upsertFileOffset(username, F, stat.size, stat.ino)
COMMIT;
```

A single pass reads from the stored offset to current EOF in one shot.
Memory cap: if the new-bytes chunk exceeds `MAX_PASS_BYTES` (default
8 MiB), the worker reads in sub-chunks and commits per sub-chunk,
advancing offset between commits. Normal session appends are kilobyte-scale,
so this sub-chunking only matters for backlog bootstrap on first boot.

### 7.2 `src/path-decode.ts`

```ts
/**
 * Resolve a watched JSONL path into its trust-critical components.
 *
 * Username is taken from the watch-root-relative path prefix — never
 * from the encoded project directory name. The encoded directory name
 * is lossy (dashes in real paths collide) and untrusted for tenancy.
 */
export function resolveJsonlPath(
  watchRoot: string,        // "/workspaces"
  fullPath: string,         // "/workspaces/alice/claude-projects/-w-projects-pbmc3k/abc-def.jsonl"
): {
  username: string;             // "alice"
  encodedProjectDir: string;    // "-w-projects-pbmc3k"
  sessionId: string;            // "abc-def" (filename stem)
  displayProjectPath: string;   // best-effort decoded; flagged ambiguous in docstring
};
```

Implementation: relative-path split, reject any `..` segment, reject any
path that does not match `<username>/claude-projects/<encoded>/<sessionId>.jsonl`.
Paths that do not match are returned null and the event is logged + dropped.

`displayProjectPath` replaces leading `-` with `/` and remaining `-` with
`/` — known-lossy, used only for the `project_display` UI column.

### 7.3 `src/jsonl-parser.ts`

Pure function `parseJsonlLine(line: string): ParsedEntry | null`. Reads
only these top-level entry fields:

| field         | purpose                                              |
|---------------|------------------------------------------------------|
| `type`        | `user` / `assistant` / `summary` / `system`          |
| `uuid`        | `entry_uuid` (dedupe key)                            |
| `sessionId`   | authoritative session id (overrides filename)        |
| `timestamp`   | `first_active` / `last_active` / `created_at`        |
| `isSidechain` | marks subagent session                               |
| `message`     | `message.model`, `message.usage` (assistant only)    |

Skip rules:

- `JSON.parse` throws → skip, sampled warn log (max 1 per file per minute).
- `type === "summary"` or `type === "system"` → skip.
- Missing `uuid` / `sessionId` / `timestamp` → skip, log once per file.
- Unknown `type` → skip silently.

The parser never throws. Malformed last lines (mid-write) are expected
and common.

### 7.4 `src/session-projector.ts`

Pure function, no I/O. Input: parsed entries + file meta. Output:
`{sessionUpsert: SessionUpsert, tokenRows: TokenUsageRow[]}`.

```ts
type SessionUpsert = {
  session_id: string;
  username: string;
  encoded_project_dir: string;
  project_display: string | null;
  model: string | null;                    // last non-null across pass
  message_count_delta: number;             // +1 per user/assistant entry in this pass
  token_usage_delta: {
    input: number; output: number; cache_read: number; cache_write: number;
  };
  first_active_candidate: string;          // min(timestamp) of pass — COALESCEd on upsert
  last_active: string;                     // max(timestamp) of pass
  is_sidechain: boolean;                   // OR across pass
};
```

If any entry's `sessionId` disagrees with the filename-derived session id,
the projector trusts the entries (logs the mismatch). JSONL content is
the source of truth; filenames are an access path.

Upsert SQL (deltas, idempotent under replay):

```sql
INSERT INTO sessions (
  session_id, username, encoded_project_dir, project_display, model,
  message_count, token_usage, first_active, last_active, is_sidechain
) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
ON CONFLICT (session_id) DO UPDATE SET
  model         = COALESCE(EXCLUDED.model, sessions.model),
  message_count = sessions.message_count + EXCLUDED.message_count,
  token_usage   = jsonb_build_object(
      'input',       COALESCE((sessions.token_usage->>'input')::int, 0)
                   + COALESCE((EXCLUDED.token_usage->>'input')::int, 0),
      'output',      COALESCE((sessions.token_usage->>'output')::int, 0)
                   + COALESCE((EXCLUDED.token_usage->>'output')::int, 0),
      'cache_read',  COALESCE((sessions.token_usage->>'cache_read')::int, 0)
                   + COALESCE((EXCLUDED.token_usage->>'cache_read')::int, 0),
      'cache_write', COALESCE((sessions.token_usage->>'cache_write')::int, 0)
                   + COALESCE((EXCLUDED.token_usage->>'cache_write')::int, 0)
  ),
  first_active  = COALESCE(sessions.first_active, EXCLUDED.first_active),
  last_active   = GREATEST(sessions.last_active, EXCLUDED.last_active),
  is_sidechain  = sessions.is_sidechain OR EXCLUDED.is_sidechain;
```

Token rows:

```sql
INSERT INTO token_usage_log (
  username, session_id, entry_uuid, model,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  created_at
) VALUES (...)
ON CONFLICT (session_id, entry_uuid) DO NOTHING;
```

Combined with the offset advancement in the same transaction, the whole
pass is atomic: either everything commits or nothing does.

## 8. Error handling

| Failure | Behavior |
|--------|----------|
| Malformed JSONL line | Skip, sampled warn log (≤1/file/min) |
| Line missing required fields | Skip, log once per file |
| `type === "summary"` or `type === "system"` | Skip (Phase 2 handles summary) |
| File unreadable (EACCES) | Skip file, error-log once, retry on next event |
| Path doesn't match `<user>/claude-projects/<enc>/<id>.jsonl` | Drop event, log |
| PG unreachable at startup | Exponential backoff, cap 5 min, then exit 1 (compose `restart: unless-stopped` retries) |
| PG connection drop mid-run | Pool reconnects; in-flight worker errors, file re-enqueued, next pass resumes from stored offset |
| Crash mid-transaction | PG rolls back; offset unchanged → safe replay |
| File truncated (size < stored offset) | Reset offset to 0, reprocess from start |
| File replaced (inode change) | Reset offset to 0, reprocess from start |
| File unlinked | No-op; session row + tokens remain (cleanup = Phase 4) |
| Concurrent indexer boot | `pg_advisory_lock` serialises migrations |
| Backpressure | Global semaphore bounds concurrent workers; events queue |

Never `process.exit()` from worker code. The only exit path is "PG
unavailable past the startup budget." All other errors bubble to the
worker boundary, get logged, and the file re-enqueues on the next
chokidar event.

## 9. Testing

Tooling: `vitest` + `@testcontainers/postgresql`. No pg-mem (poor `jsonb`
and advisory-lock coverage). No mocked PG — integration tests hit a real
`postgres:16-alpine` in a throwaway container.

### Unit (pure, no I/O)

- `jsonl-parser.test.ts` — table-driven: each entry shape
  (user/assistant/summary/system) in, expected `ParsedEntry|null` out.
  Includes malformed lines, mid-line truncation, missing required fields,
  unknown types, unexpected extra fields (forward-compat).
- `session-projector.test.ts` — entries → (SessionUpsert, TokenUsageRow[]).
  Idempotency: same entries twice produce same outputs.
- `path-decode.test.ts` — valid inputs, path-traversal attempts (`..`),
  usernames with hyphens, project dirs with hyphens (lossy decode
  flagged), paths outside watch root.
- `migrate.test.ts` — two concurrent runners against a real PG, both
  succeed, schema matches expected; second run no-ops.

### Integration (real PG + real fs)

- `tail-live-writes.test.ts` — tmp workspaces tree, indexer process
  started, JSONL written line-by-line with `fs.appendFile`, assert DB
  state converges after each flush.
- `restart-resume.test.ts` — write N lines, SIGKILL indexer, restart,
  append M more, assert `token_usage_log` row count = N + M (no dupes, no
  misses).
- `rotation.test.ts` — replace a JSONL file (new inode), assert offset
  resets and no mixed-session rows.
- `concurrent-files.test.ts` — 20 files churning in parallel, assert
  per-file offsets stay consistent.
- `backlog-on-boot.test.ts` — pre-populate tmp tree with 50 JSONL files
  totalling 10k lines, start indexer, assert all ingested.

### Fixtures

`test/fixtures/`:

- Real (anonymised) captures from `~/.claude/projects/`: at least one
  simple session, one with tool calls, one with `isSidechain: true`
  entries, one with missing fields.
- Crafted `malformed-lines.jsonl`: half-written last line, one invalid
  JSON line, one valid line after — asserts recovery past the bad line.

### CI gate

`npm test` runs in under 60s locally including testcontainer boot (~5s
for PG). No fixtures larger than 100 KB to keep clones fast.

## 10. JSONL parsing contract (forward-compat)

- **JSONL is read-only.** Indexer opens files `O_RDONLY`. No writes, no
  locks, no touching Claude Code's file descriptors.
- **Top-level entry fields only.** The keys read (`type`, `uuid`,
  `sessionId`, `timestamp`, `message.model`, `message.usage`,
  `isSidechain`) are what `adapter/src/history.ts` already relies on.
- **Unknown fields ignored, unknown types skipped, malformed lines
  skipped.** No hard crashes on Claude Code updates. If a new `type`
  lands, the indexer ignores it quietly; token accounting stays correct
  because only `assistant` carries `usage`.
- **Entries over filenames.** Session id comes from entry `sessionId`,
  not filename. A future Claude Code change that decouples filename from
  session id doesn't break the indexer — only `file_offsets` naming
  looks odd.
- **Dedupe key is the entry's own `uuid`.** Natural, stable, derived
  from Claude Code's own identifier. Replay-safe by construction.

If Anthropic ships a first-class history accessor, swapping
`jsonl-parser.ts` + `watcher.ts` for an SDK client leaves
`session-projector.ts`, `db.ts`, and the schema identical.

## 11. Configuration

All configuration via environment variables, parsed once in `src/config.ts`:

| var | required | default | notes |
|---|---|---|---|
| `PG_URL` | yes | — | `postgres://bioflow@postgres:5432/bioflow` in compose |
| `WORKSPACES_ROOT` | no | `/workspaces` | |
| `MAX_CONCURRENT_FILES` | no | `8` | global semaphore |
| `MAX_PASS_BYTES` | no | `8388608` | 8 MiB; sub-chunks larger passes |
| `LOG_LEVEL` | no | `info` | pino level |
| `MIGRATION_LOCK_KEY` | no | `0x62696F666C77` | `pg_advisory_lock` key |
| `PG_STARTUP_MAX_WAIT_SEC` | no | `300` | exit 1 if PG still unreachable |

## 12. Phase boundary check

After Phase 1, the system supports:

- `SELECT session_id, username, last_active FROM sessions ORDER BY last_active DESC`
  returns every user's sessions with fresh activity timestamps.
- `SELECT username, SUM(input_tokens + output_tokens) FROM token_usage_log
  WHERE created_at >= now() - interval '30 days' GROUP BY 1` gives 30-day
  token totals per user — the billing-rollup primitive.
- Killing the indexer and restarting leaves no duplicates and no missed
  rows (enforced by `restart-resume.test.ts`).
- The adapter and frontend continue to function exactly as they do today;
  no code outside `hub/indexer/` is changed.

What still doesn't work after Phase 1 (by design):

- No web UI query of sessions — that's the Phase 2 HTTP API.
- No cross-device session browsing — needs the API.
- Titles are null in PG — the sidecar still owns them until Phase 2.
- Subagent parent linkage is null — Phase 2.

Phase 2 can then build directly on the rows this indexer populates without
retrofitting the schema.

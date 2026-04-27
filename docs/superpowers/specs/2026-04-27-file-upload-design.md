# File upload — design

**Status:** approved 2026-04-27
**Scope:** v1 single-shot file upload from the frontend file UI into the user's workspace, capped at 2 GB.

## Goal

Let an authenticated user drag a file (≤ 2 GB) onto the file tree and have it land in the directory they're currently viewing, inside their per-user workspace. No resumable uploads, no folder uploads — those are explicitly deferred.

## Non-goals

- Resumable / chunked uploads (tus.io)
- Folder-tree uploads
- Conflict-resolution prompts (silent overwrite is fine for v1)
- MIME/content-type validation, virus scanning, signed URLs
- Server-side cancel of in-flight writes (best-effort cleanup only)

## Architecture

```
browser ── PUT /upload/<rel-path> ──► nginx (claude-bioflow-nginx)
                                      │  HTTP Basic ($remote_user) → user
                                      │  client_max_body_size 2g
                                      │  proxy_request_buffering off
                                      ▼
                              http://claude-bioflow-<user>:5000/upload/<rel-path>
                                      │
                                      ▼
                       adapter HTTP server inside per-user container
                                      │  validate path, stream body to disk
                                      ▼
                              /workspace/<rel-path>
                              (= host hub/workspaces/<user>/<rel-path>
                                via existing local_projects bind mount)
```

Three components change:

1. **Adapter** — gain a small HTTP server alongside the existing NATS code.
2. **nginx** — gain a `/upload/` location that proxies per-user.
3. **Frontend** — gain an upload button + drag-drop + progress tray in the file tree.

## Adapter

New file `adapter/src/upload-http.ts` (~80 LOC):

- Spawn `http.createServer()` on `process.env.UPLOAD_PORT ?? 5000`. Started from `index.ts` alongside the NATS client. If the port is in use, log and skip — don't crash the adapter.
- Routes:
  - `PUT /upload/<rel-path>` (also accept `POST` for browser quirks): stream body to disk.
  - Anything else: `405 Method Not Allowed`.
- Path safety:
  - `const abs = path.resolve('/workspace', relPath)`.
  - Require `abs.startsWith('/workspace/local_projects/')`. Anything else → `403 {error: "path"}`.
  - `fs.realpath` the parent dir; refuse if it resolves outside `local_projects/`. Stops symlink-pointing-out attacks.
  - Explicit deny-list (defence in depth): `.env`, `.claude/`, `CLAUDE.md`, `.bioflow/`.
- Write:
  - `mkdir -p` parent dir.
  - `fs.createWriteStream(abs, { mode: 0o644 })`. Pipe `req` directly. No buffering.
  - On `req.aborted` or `req.close` before `end`: `unlink` the partial file.
- Response:
  - `201 {path, size}` on clean success.
  - `4xx` for path/permission errors with a machine-readable JSON body.
  - `5xx` for disk failures (also `unlink` the partial).

## nginx

`hub/nginx.conf` — two additions.

At the `http {}` level, alongside the existing `ws_limit` zone:

```
limit_req_zone $binary_remote_addr zone=upload_limit:10m rate=1r/s;
resolver 127.0.0.11 valid=30s;   # Docker embedded DNS, needed because
                                  # proxy_pass uses a runtime variable
```

Inside `server {}`, the new location:

```
location /upload/ {
    auth_basic "claude-bioflow files";
    auth_basic_user_file /etc/nginx/htpasswd;
    limit_req zone=upload_limit burst=2 nodelay;

    client_max_body_size 2g;
    proxy_request_buffering off;
    proxy_send_timeout 30m;
    proxy_read_timeout 30m;

    proxy_pass http://claude-bioflow-$remote_user:5000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-User $remote_user;
}
```

`$remote_user` (the htpasswd-authenticated name) is the routing key, so a user can only upload into their own container. The `resolver` line is required — nginx defers DNS lookups when `proxy_pass` contains a variable, so without it we'd get "host not found" at request time. Docker's embedded DNS at `127.0.0.11` resolves `claude-bioflow-<user>` on the `bioflow-net` network. If the user's container is offline, nginx returns `502` and the frontend surfaces "container offline".

## Frontend

Touched files:
- `frontend/src/components/files/FileTree.vue` — add toolbar button + drag-drop handler on the tree pane.
- `frontend/src/services/upload.ts` — new (~70 LOC). One exported `uploadFile(file: File, destDir: string): UploadHandle` returning `{progress$, cancel(), done}`.
- `frontend/src/stores/uploads.ts` — new tiny Pinia store holding the active uploads list for the tray UI.

Behavior:
- Drop or "Upload" → `File` object → destination = `currentDirPath + '/' + file.name`.
- Pre-flight: reject `file.size > 2 * 1024**3` with a toast — never opens the request.
- Use `XMLHttpRequest` (not `fetch`) for `xhr.upload.onprogress` — fetch's request-progress is still patchy in 2026.
- Single in-flight at a time per user (sequential queue). Multiple files = multiple tray rows, processed in order. Parallel uploads pointless on a single residential uplink.
- On `xhr.load` 2xx: hide tray row after 1.5 s; re-fetch `list_files` for `destDir` so the tree refreshes.
- On error / 4xx / 5xx: tray row goes red with the response error message and a "Retry" button (re-issues `PUT`, byte-0 — no resume in v1).
- On `cancel()`: `xhr.abort()`. Server-side cleanup happens via the `req.aborted` handler.

## Data flow (happy path)

1. User navigates to `local_projects/foo/data/` in FileTree.
2. Drops `pbmc3k.h5ad` (1.4 GB).
3. Frontend size check passes; opens `PUT /upload/local_projects/foo/data/pbmc3k.h5ad`, streams body via XHR.
4. nginx auth check (htpasswd → user `lili`); proxies to `http://claude-bioflow-lili:5000/upload/...`.
5. Adapter validates path is under `/workspace/local_projects/`; opens `WriteStream`; pipes request → file.
6. `req.on('end')` → close stream, respond `201 {path, size}`.
7. Frontend hides progress row, calls `list_files`, file appears in tree.

## Error handling

| Failure | Server | Client UX |
|---|---|---|
| File > 2 GB | rejected client-side before request opens | toast: "Files must be ≤ 2 GB" |
| Path outside `/workspace/local_projects/` | `403 {error: "path"}` | toast with the rejected path |
| Parent dir missing | `mkdir -p`, then write | transparent |
| Destination exists | overwrite | no prompt (deferred) |
| Connection drops mid-upload | `req.on('aborted'/'close')` → `unlink` partial | tray row red, "Retry" button (byte 0) |
| Container offline | nginx `502` | toast: "Workspace container is offline" |
| Disk full | `5xx`, `unlink` partial | toast: "Server out of space" |

## Security

- **Auth:** nginx HTTP Basic, same htpasswd as `/download/`.
- **Per-user routing:** `proxy_pass http://claude-bioflow-$remote_user:5000` — a user can't target another user's container.
- **Path traversal:** `path.resolve` + `startsWith('/workspace/local_projects/')`.
- **Symlink hardening:** `fs.realpath` the resolved parent.
- **Deny-list:** `.env`, `.claude/`, `CLAUDE.md`, `.bioflow/`.
- **Mode:** `0o644`, never executable.
- **Rate limit:** nginx `1 r/s` per IP, burst 2.

## Testing

- **Adapter unit** (`vitest` against the real `http.createServer` on a random port):
  - Path traversal → 403.
  - Symlink-out → 403.
  - Valid path streams to disk and returns 201.
  - Aborted request → partial file unlinked.
  - Wrong method → 405.
- **Adapter integration:** `index.ts` startup with the new server; verify graceful fallback when `UPLOAD_PORT` collides.
- **nginx config:** `docker exec ... nginx -t` smoke check.
- **Frontend** (`vitest` + mocked XHR):
  - 2 GB size guard.
  - Progress events update store.
  - `cancel()` calls `xhr.abort()`.
- **Manual smoke:** drag a 1.5 GB h5ad into li86's FileTree post-deploy; verify it appears in the tree and downloads cleanly via `/download/`.

## Open follow-ups (later, if asked)

- Resumable uploads via tus.io if 2 GB-on-flaky-link complaints arrive.
- Folder uploads (recursive).
- Conflict-resolution prompt.
- An "Upload" entry in the per-user `claude-bioflow-<user>` adapter's NATS RPC catalog so other surfaces (e.g. agent-driven imports) can hit the same path.

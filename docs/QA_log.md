# Q&A Log

Append-only log of learning-oriented questions about claude-bioflow.
Newest entries at the bottom. See repo `CLAUDE.md` principle 3.

---

## 2026-04-27 — How does scSurvival load into a notebook? Is the local venv used?

**Q:** How is the venv at `/home/lili/claude-bioflow/hub/workspaces/li86/local_projects/scsurvival/venv` loaded into an ipynb? Or is scSurvival installed somewhere else?

**A:** The local venv is **not** loaded by any notebook. scSurvival is installed into the image-bundled `/venv` as a PEP 660 editable install whose `.pth` redirects imports to the project source.

Concrete chain:

- The container registers only two Jupyter kernels: `python3` → `/venv/bin/python` and `ir` → system R. Nothing points at `local_projects/scsurvival/venv`.
- Inside `/venv/bin/python`, `import scSurvival` resolves to `/workspace/local_projects/scsurvival/repo/scSurvival/__init__.py`.
- The redirection lives at `/venv/lib/python3.12/site-packages/__editable__.scsurvival-1.3.0.pth` — created by `pip install -e .` run from `/venv/bin/pip` against `local_projects/scsurvival/repo`.
- The orphan venv at `local_projects/scsurvival/venv` was itself spawned by `/venv/bin/python -m venv …` (per its `pyvenv.cfg`) but never registered as a kernel, so no notebook touches it.

Mental model:

- One container = exactly two kernels by design (`python3`, `ir`). Don't add more — `metadata.kernelspec.name` outside that set fails on first execute.
- To add a Python package for notebooks, install into `/venv` (`/venv/bin/pip install <pkg>`). The bundled `/venv` is chowned to `node` at container start so runtime installs persist in the container's overlay (NOT the image).
- For live development of a package, use editable install (`pip install -e ./path/to/repo`) — package metadata lives in `/venv`, sources stay in the project tree, edits show up without reinstall.
- "Package metadata in `/venv`, sources in the project" is what makes a project-local venv look load-bearing when it isn't.

Cleanup hint: `rm -rf local_projects/scsurvival/venv` is safe — nothing depends on it.

---

## 2026-04-27 — Shared vs user CLAUDE.md: which dominates?

**Q:** We have 2 layers of CLAUDE.md (shared, user). What is dominating?

**A:** Neither — there is no runtime layering. Only the user's CLAUDE.md is loaded.

Mechanics:

- `hub/scripts/add-user.sh` copies `shared/CLAUDE.md` → `<user>/CLAUDE.md` once at provisioning, only if the user doesn't already have one. After that the two files are independent.
- The container bind-mount list mounts `<user>/CLAUDE.md` → `/workspace/CLAUDE.md`. `shared/CLAUDE.md` is not mounted; only `shared/reference`, `shared/projects`, `shared/skills` are.
- Claude Code discovery walks up from `cwd=/workspace` to `/`. Nothing exists above, so `/workspace/CLAUDE.md` is the only CLAUDE.md the SDK sees.

Consequence: edits to `shared/CLAUDE.md` don't propagate to existing users. You either re-`cp` after each edit, or use Claude Code's `@path` import to point the user CLAUDE.md at a shared file mounted into the container (the standard "shared base + user override" pattern).

Three plumbing options if true layering is wanted:

1. **Template + manual re-sync** (status quo): `cp shared/CLAUDE.md <user>/CLAUDE.md` after each template edit. Cheapest. Overwrites user-local edits.
2. **`@include` at runtime**: bind-mount `shared/CLAUDE.md` to e.g. `/workspace/.bioflow/shared.md`; user CLAUDE.md begins with `@/workspace/.bioflow/shared.md`. Live updates, user file owns local overrides. Modest add-user.sh change.
3. **Concat at boot**: entrypoint composes shared+user → /tmp file, mounts that. More machinery, same outcome as option 2.

---

## 2026-04-27 — What is `@include` in CLAUDE.md? How does it work?

**Q:** What is `@include`? How does `@include` work?

**A:** Claude Code's memory-import syntax. Writing `@<path>` inside `CLAUDE.md` (or any memory file) inlines the referenced file's contents into the system prompt when Claude Code loads memory at the start of a turn.

Syntax (note: examples below are inside a code fence so the importer ignores them — the parser skips fenced/backticked text):

```
@/workspace/.bioflow/shared.md      # absolute path
@./team/style-guide.md              # relative to this CLAUDE.md
@~/dotfiles/global-claude.md        # home-relative
```

Mechanics:

- The import is recursive — an included file can include others, depth-capped (~5 levels).
- Relative paths resolve against the importing file's directory.
- Imports are skipped inside fenced code blocks and inline backticks, so the syntax itself can be documented without firing.
- Re-evaluated every turn (CLAUDE.md is re-read), so edits to imported files take effect on the next user message — no restart.
- It's an *inline* mechanic, not a layered override system. Imported text and surrounding text concatenate into the same system prompt. To "override" the imported content, place user-specific instructions *after* the `@…` line so the later text wins.
- Imported files are plain markdown — not skills. For skill-style routing, use `.claude/skills/` instead.

LabWeaver application: bind-mount `shared/CLAUDE.md` into each container at e.g. `/workspace/.bioflow/shared.md`, seed each user's `CLAUDE.md` with `@/workspace/.bioflow/shared.md` as the first line, and shared edits will flow live to every workspace while user files own local overrides.

---

## 2026-04-27 — Why didn't `nginx -s reload` pick up my edited nginx.conf?

**Q:** I edited `hub/nginx.conf` on the host, ran `docker exec ... nginx -s reload`, and the new `location /upload/` block didn't take effect — uploads still hit the catch-all and returned 405. The host file clearly had my changes. What was going on?

**A:** Linux bind-mounts of *single files* (not directories) bind to the **inode**, not the path. Many editors — including Claude Code's Edit/Write tools — implement an "atomic write" by writing a sibling temp file and renaming it over the target. The rename gives the path a new inode; the original inode is unlinked from the host directory entry but stays alive because the container still has it open via the bind mount.

So:
- The host's `hub/nginx.conf` correctly had the new content (new inode).
- The container's `/etc/nginx/nginx.conf` was still pointing at the **old, now-orphaned inode** with the old content.
- `nginx -s reload` re-read its config — but it re-read the *old* file, since that's what the bind mount still resolved to.

`docker logs claude-bioflow-nginx` confirmed it: `wc -l /etc/nginx/nginx.conf` inside the container reported 99 lines, while the host file was 145. `ls -la` inside the container showed an mtime from days earlier — a clear inode-swap fingerprint.

**Fix:** `docker restart <container>`. Restart re-resolves bind sources by path, so the new inode gets picked up.

**Avoid in the future:**

- For config files that change often, prefer bind-mounting the **parent directory** instead of the single file. Directory bind-mounts resolve children by name on each access, so atomic-rename edits work transparently.
- Or treat any `Edit`/`Write` of a bind-mounted file as needing a `docker restart`, not just a config reload.
- The same trap applies to `docker cp` in reverse — copying *over* a bind-mounted file inside the container won't propagate to the host either, because the container's overlay shadows the bind source.

This burned roughly 15 minutes of upload-feature debugging today; the symptom (`405 Method Not Allowed` on `PUT /upload/...`) led me on a wild goose chase through frontend XHR code, nginx variable resolution, and adapter method handling before the inode mismatch became visible.

---

## 2026-05-07 — How does the bioflow agent memory system work end-to-end?

**Q:** Summarize how memory system works.

**A:** Three layers, each owned by one process. Capture is server-side (no per-event hooks); retrieval has three surfaces (agent MCP, SessionStart hook, frontend panel); audit + soft-delete + restore are all transactional.

**Capture — two paths, both write through the same `insertMemoryRow` helper in `hub/indexer/src/distiller-repo.ts`.**

1. *Distillation (auto).* `distiller.ts` polls `sessions WHERE last_active < now() - 5min` every 60 s, streams JSONL via `path-decode.ts` + `transcript-reader.ts`, calls `claude-haiku-4-5` with a versioned prompt, writes one `session_summary` + 0–N `observation` rows. Idempotent by `(username, project_dir, type, content_hash)` UNIQUE.
2. *User writes.* `/memorize` (chat slash command) → `bioflow-memory` MCP server (`mcp-memory/src/index.ts`) → adapter NATS RPC `memory_write` → `POST /memory/write` → `writeUserMemory()`. Frontend panel writes go through the same NATS-RPC bridge.

**Storage — Postgres, migrations 0006–0009.**

| Table | Purpose |
|---|---|
| `memories` | One row per memory: `(memory_id, username, project_dir, type, source, name, description, body, content_hash, hit_count, last_hit_at, deleted_at, ...)`. UNIQUE on `(username, project_dir, type, content_hash)`. |
| `memory_chunks` | One row per chunk: `content`, `tsv` (FTS), `embedding vector(384)`. HNSW + GIN indexes. |
| `memory_facets` | Open `(key, value)` tags: gene/dataset/tool/pipeline/file. |
| `embedder_queue` | Work queue. Indexer's embedder loop polls 64 chunks every 5 s, batches them to the `claude-bioflow-embedder` Python sidecar (bge-small-en-v1.5), writes vectors back. |
| `memory_distill_cursor` | Per-user `last_seen_session_last_active` watermark. |
| `memory_audit_log` (sub-phase C) | Every mutation appends a row in the *same transaction*. JSONB `before`/`after`. FK CASCADE. |

Scope tier is computed: `username='__org__'` → org, `project_dir IS NULL` → user, else project. No separate scope column.

**Retrieval — three surfaces.**

1. *Agent (in-session).* MCP tools `memory_search/get/timeline/write/forget` over stdio. Search returns `{memory_id, snippet ≤200 chars, score}` only — agent calls `get` on demand. Token-efficient pattern from claude-mem.
2. *SessionStart hook.* `memory_session_start.sh` curls `GET /memory/context?username=&project_path=&budget_tokens=2000`. Server runs scope×popularity×recency ranking (no FTS), packs ≤50 memories until budget hits, returns one `system_prompt` string. Hook stdout is injected as system context by Claude Code.
3. *Frontend Memory panel.* `MemoryPanel.vue` → pinia store → `memoryService` → adapter NATS RPC `memory_search/get/list/write/update/forget/restore/audit` → `MemoryRpcClient` HTTP → `memory-api.ts`. Frontend never sees `username`; the adapter injects its trusted `process.env.USERNAME`.

**Search ranking** (`searchMemories` in `memory-repo.ts`): hybrid SQL — `0.7×vector_cosine + 0.3×ts_rank`, then multiplied by scope-specificity (`project=1.20, user=1.10, org=1.00`), popularity (`1 + ln(1+hit_count)×0.05`), and recency (`exp(-age_seconds / (90 days))`). Embedder down → FTS-only fallback. Returned IDs get `hit_count++` in a follow-up `UPDATE`.

**Audit + soft-delete (sub-phase C).** Every mutation is `pool.connect → BEGIN → SELECT FOR UPDATE → checks → UPDATE → appendAudit(action, before, after) → COMMIT`. Negative paths ROLLBACK without auditing. Soft-delete sets `deleted_at`; default reads filter it out. Restore clears it. Per-memory audit trail is owner-only (`GET /memory/:id/audit`). `GET /memory/metrics` returns counts/queue/cursor lag for ops debugging.

**Trust model.** `USERNAME` is the tenant key, set by `add-user.sh` from the workspace prefix, never user-controlled at runtime. The frontend carries no username; the adapter injects it. The memory-api itself has no auth (private docker network, same model as the postgres bridge in Phase 2). Org writes are operator-only — the MCP tool surface excludes `scope:'org'`.

**Out of scope (deferred):** paid embeddings (swap `EMBEDDER_URL`), subagent-scoped memory, cross-memory audit explorer, bulk forget, editing distilled rows.

## 2026-05-11 — Running scbench in claude-bioflow

**Q:** I want to run the benchmark https://github.com/latchbio/scbench in my bioflow platform. How should I proceed?

**A:** scbench is an agentic-eval harness — 394 graded scRNA-seq tasks (only 7 canonical ones public; rest withheld to prevent training contamination). Each task ships an `.h5ad` + prompt + deterministic grader; the agent writes `eval_answer.json` and the runner grades it. It has a CLI (`scbench run --agent minisweagent --model anthropic/claude-opus-4-7`) and an `EvalRunner` API with a pluggable `agent_function(task_prompt, work_dir) → dict`.

Strategic question: what does "run it on bioflow" mean? Three flavors of integration, from easiest to most informative:

1. **Bundled agent (smoke test).** `pip install -e scbench` inside a user container, run canonical tasks with `--agent minisweagent`. Validates the image's bio stack (`pantheon-agents-sc` already has scanpy + R/Seurat/scDblFinder). Does not exercise the platform — only model + their loop.
2. **Custom `agent_function` via Anthropic SDK directly** with bioflow's tool surface. Tests tooling choices, still skips the NATS/adapter/UX path.
3. **`agent_function` that dispatches into the adapter over NATS** — claude-bioflow becomes the agent under test, scbench is the outer driver. Exercises session lifecycle, hooks, MCP-memory, kernel bridge. Most informative, most plumbing.

Suggested order: do (1) as a 30-min smoke test in `claude-bioflow-li86`, then decide if (2) or (3) earns its complexity.

Two integration gotchas either way:

- **`work_dir` / cwd alignment** — agent must write `eval_answer.json` into the runner-supplied `work_dir`. LabWeaver sessions default cwd to `/workspace` or `local_projects/<proj>/`. Easiest: make `work_dir` a subdir of `local_projects/scbench-runs/<task-id>/` so the agent's `Write` lands there.
- **Dataset cache** — `.h5ad` snapshots are downloaded; cache on the bind-mounted workspace, not `/tmp`, or every container recreate re-downloads.

For the full 394 set (vs. 7 canonical), contact LatchBio.

## 2026-05-11 — Does scbench run automatically or do I drive it from the UI?

**Q:** When I run a scbench eval, does the test run automatically, or do I tell the agent to do it in the bioflow UI?

**A:** Automatic. `scbench run --agent minisweagent --model anthropic/...` is a self-contained loop: parse task → `latch cp` data → spawn `minisweagent` (calls Anthropic API directly with bash/python tools in a sandbox) → write `eval_answer.json` → grade. **No NATS, no bioflow adapter, no UI session.** The bioflow container's only role is providing the bio stack (scanpy/R/etc.) that the agent's bash tool uses.

The three integration flavors from the earlier entry map to how much of bioflow is exercised:

| Flavor | Driver | Agent loop | UI? | Tests |
|---|---|---|---|---|
| (1) `--agent minisweagent` | scbench CLI | minisweagent → Anthropic API | No | Model + image bio stack |
| (2) Custom `agent_function` | scbench CLI | Your Python → Anthropic SDK | No | Model + your tools |
| (3) `agent_function` over NATS | scbench CLI | RPC → bioflow adapter → Claude Code session | No (programmatic) | Full bioflow stack |

A "manual UI" side experiment — pasting the task prompt into a bioflow chat and eyeballing the answer — is possible but isn't a scbench mode; the runner won't grade it.

## 2026-05-11 — How scbench tasks are designed

**Q:** I would like to learn more about how the tasks are designed.

**A:** Every task is one JSON file with four logical parts: identity (`id`), prompt (`task` — self-contained, including the exact JSON schema the agent must write to `eval_answer.json`), inputs (`data_node` Latch URIs), and a deterministic grader (`type`+`config`). Plus author-only `notes` and a `metadata` block.

The grader is the design bottleneck. Only answer-shapes that fit one of five families can become tasks:

| Grader | Answer | Pass test | Trade-off |
|---|---|---|---|
| `numeric_tolerance` | float(s)/int(s) | every field within abs/rel tolerance | cheapest signal; flattens biology to a number |
| `multiple_choice` | string from a set | exact match | useful for interpretation questions, no nuance |
| `label_set_jaccard` | set of labels | Jaccard ≥ pass_threshold (e.g. 0.8) | tolerates partial credit; threshold is brittle |
| `marker_gene_precision_recall` | gene list | P@K, R@K ≥ threshold | realistic for DE/marker tasks; sensitive to gene-symbol spelling |
| `distribution_comparison` | proportions | distribution distance < tol | cell-type fractions, batch tests |

Free-form scientific judgment isn't gradable here. This is a deliberate trade — code graders are cheap, stable, reproducible (vs LLM-judges which drift and cost per grade).

`metadata.eval_type` is the design axis between judgment and adherence:

- **`scientific`** — prompt asks for a judgment call (e.g. *"choose conservative QC thresholds"*). Grader is a tolerance window around an expert answer. Tests biological judgment.
- **`procedural`** — prompt prescribes a recipe step-by-step (PCA components, Leiden resolution, k for kNN). Grader checks the recipe's expected output. Tests faithful execution. The snrna celltyping task we ran is procedural; both Sonnet and Opus failed at Jaccard 0.714 because the prescribed `Leiden res=0.6 + cluster-majority-vote` genuinely cannot surface Macrophage/Mural — author seemingly knew this (notes: *"dataset may lack some labels"*) and set `pass_threshold=0.8` to allow exactly one missing label, no more.

`metadata.time_horizon` (small/medium/large) is a tool-turn budget proxy. Tolerance tuning is the hardest authoring step (note in the QC task: *"Threshold set to 1.5% of the total cells to allow for some variation"* — explicit expert-variance calibration).

Public/private split: 30 canonical tasks are public, 364 are withheld to prevent training contamination. Published leaderboard numbers (Opus 4.6 = 52.8%) are over the full 394 — observed pass/fail on the canonical 30 is **not** representative; they're the showpieces.

Repo refs: `docs/specification.md` (JSON spec), `docs/adding_evals.md` (authoring), `paper/main.pdf` (rationale), `scbench/types.py` (`TestCase` model), `latch_eval_tools/graders/` (implementations).

## 2026-05-12 — `grub-reboot` vs `grub-set-default`

**Q:** what is grub reboot for

**A:** `grub-reboot` stages a **one-shot** boot override. It writes `next_entry=X` into `/boot/grub/grubenv`; GRUB consumes that on the next boot and clears it, so subsequent boots return to `GRUB_DEFAULT`.

Contrast with `grub-set-default`, which writes `saved_entry` and persists until changed. Use `grub-reboot` when you want to boot a non-default kernel *once* — e.g. temporarily falling back to 6.8.0-110 because the running 6.8.0-111 has no matching `linux-modules-nvidia-590` package yet. Auto-updates can later put you back on the newest kernel without a manual revert.

Caveat: requires `GRUB_DEFAULT=saved` (or equivalent) in `/etc/default/grub`. Ubuntu defaults to this; a hardcoded `GRUB_DEFAULT=0` silently ignores the override.

## 2026-05-13 — Claude Code login: how the auth flows from `claude /login` to a spawned subprocess

**Q:** How does the "logged-in" auth work for Claude Code, especially when it's invoked as a subprocess (like the bioflow adapter does)?

**A:** OAuth, with the token persisted to a single JSON file.

1. `claude /login` opens a browser to console.anthropic.com, you grant access, Anthropic returns a long-lived **refresh token** + short-lived **access token**.
2. Both are stored in `~/.claude.json` (mode 0600). No env var, no daemon — just the file.
3. Every spawn of `claude` (interactive or via subprocess) reads `~/.claude.json`, refreshes the access token if expired, and attaches `Authorization: Bearer <access>` to its API calls.
4. **Precedence**: `ANTHROPIC_API_KEY` env var wins if set (→ API billing); otherwise the `.claude.json` OAuth tokens are used (→ Max plan billing); otherwise it prompts for login. This is why a stray `ANTHROPIC_API_KEY` in a container's env can silently flip the whole platform off your Max subscription.
5. **Persistence in this stack**: `.claude.json` lives in each workspace container's writable overlay (not in a bind mount). It survives `docker restart` but is wiped by `docker rm` + `docker run`. To make it survive recreates, bind-mount `~/.claude.json` from the host the same way `settings.json` already is.

## 2026-05-22 — Porting claude-bioflow to an HPC where only Singularity is available

**Q:** The backend service is based on docker containers. If I want to move all the infra to CHPC, where only Singularity is available, will the design still work?

**A:** Technically possible; the application code is portable, but three pieces of the design need rework and one (per-user long-running workspaces) fights HPC conventions.

What ports cleanly: images convert via `singularity build foo.sif docker-archive://...`, bind mounts are 1:1, `--nv` replaces `--gpus all`, no source changes to the adapter / indexer / frontend.

What needs rework:
1. **Networking.** Singularity has no daemon-managed bridge. Today the stack relies on Docker DNS (`claude-bioflow-postgres`, `claude-bioflow-nats`). Replace with `127.0.0.1:<port>` on a single node, or explicit hostnames over the cluster interconnect.
2. **Orchestration.** No `docker-compose` equivalent. `singularity instance start <sif> <name>` is the closest, but with no dependency ordering, health checks, or restart policy. Replace `hub/docker-compose.yml` with a SLURM job, a startup shell script, or `singularity-compose`. The per-user spawn in `recreate-user.sh` becomes a `singularity instance start` call.
3. **Per-user long-running containers.** HPC schedulers expect time-bounded jobs, not always-on user services. Either run workspaces inside interactive SLURM sessions (they die with the job) or flip to ephemeral workspaces with state on NFS.

Pragmatic split: keep shared infra (postgres, nats, indexer, embedder, frontend proxy) on a small always-on VM *outside* HPC, and use HPC only for the per-user workspace containers that run scanpy/Seurat — they reach the shared services over the cluster's outbound network. Preserves the architecture without forcing HPC to act like a Docker host.

Site-specific blockers to verify at CHPC: long-running Singularity instances on login nodes vs job-only; whether any user-facing port is exposed at the cluster perimeter (needed for frontend ingress); NFS write performance for postgres' data dir (NFS-hosted postgres is usually unhappy).

## 2026-05-23 — Per-chat context isolation and resume

**Q:** How does the agent manage context when I switch between different sessions?

**A:** Per-chat isolation backed by Postgres-tracked Claude SDK session UUIDs.

- Each LabWeaver chat row has a `session_id` column = the real Claude Agent SDK
  session UUID. One UUID ↔ one JSONL transcript at
  `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`
  (bind-mounted from `${WORKSPACE}/.claude/claude-projects/` so it
  survives container recreate). Switching chats in the sidebar just loads
  a different transcript.
- On every turn, the adapter (`adapter/src/rpc.ts` → `runChat`) reads the
  chat row and passes `resumeSessionId: chat.session_id` to the SDK,
  which reconstructs the model's view from the JSONL. First turn of a
  fresh chat has no UUID yet — the SDK mints one and `onSessionId`
  back-fills it for the next resume.
- `cwd` stays at `defaultProjectCwd` (`/workspace`) even when the chat is
  bound to a project, because the JSONL path is derived from the cwd
  encoding; changing it mid-chat would split the transcript and break
  resume. The agent learns its project from the kickoff prompt / `/tick`
  harness, not from `cwd`.
- Concurrency: `ChatMutexRegistry` allows one streaming turn per chat,
  but chats run in parallel. You can switch and watch another chat while
  the first runs.
- What is NOT shared between sessions: the JSONL transcripts themselves.
  Cross-session knowledge only flows via: (1) the bioflow-memory MCP
  (auto-injected at session start by `memory_session_start.sh`),
  (2) files in `/workspace/` that all chats can read, (3) `CLAUDE.md` +
  the imported shared `CLAUDE.md`, (4) skills under `~/.claude/skills/`.
- Inside a single long session, the Claude harness automatically
  compresses older messages when the model context fills up — the full
  JSONL on disk is preserved, only the in-memory view is summarized.

## 2026-05-23 — Per-workspace CHPC UNID vs container UID

**Q:** For each container, do I need to set a fixed UID for CHPC access?

**A:** Two separate identifiers, often confused:

- **Container Linux UID** (`node` = 1001) is set once in `image/Dockerfile` (`ARG UID=1001`) and is shared by every workspace. It has to match the host UID that owns the bind-mounted dirs, so don't vary it per user.
- **CHPC UNID** (e.g. `u6025146`) is the researcher's identity on CHPC. It lives in `hub/workspaces/<workspace>/.ssh/config` on the `User` line, one per workspace, and survives `recreate-user.sh` because `.ssh` is a bind mount.

So the answer is "yes, per workspace, but it's the CHPC UNID, not a Linux UID." Today it's a manual edit after `add-user.sh`; a `--chpc-unid <unid>` flag on `add-user.sh` would `sed` the placeholder at provision time — same shape as the existing `--data` flag.

## 2026-05-27 — How does the new CHPC job notification system work in plain language?

**Q:** How it works in plain language

**A:** Three small bash scripts and one hidden file form a loop between two worlds: a background poller and the chat.

The cast:

- `posttool_jobid.sh` — Claude Code's PostToolUse hook on Bash. Fires every time the agent runs a Bash command. See `hub/skeleton/harness/hooks/posttool_jobid.sh`.
- `chpc_job_watcher.sh` — a tiny per-jobid poller. See `hub/skeleton/harness/hooks/chpc_job_watcher.sh`.
- `userprompt_route.sh` — Claude Code's UserPromptSubmit hook. Fires every time the user types anything. See `hub/skeleton/harness/hooks/userprompt_route.sh`.
- `~/.claude/.chpc_pending` — a mailbox file (NDJSON).

The flow:

1. The agent runs `ssh chpc-login 'sbatch ...'`. CHPC prints a jobid (e.g. `13169761`).
2. The Bash command finishes → `posttool_jobid.sh` runs. It recognizes `sbatch`, extracts the jobid, and launches `chpc_job_watcher.sh <jobid>` **in the background, detached** (`setsid nohup ... &`). The watcher keeps running after the hook ends and after the agent's turn ends.
3. The agent ends its turn. The chat goes idle. The user walks away.
4. The watcher polls CHPC every 10 minutes: `ssh chpc-login 'sacct -j <jobid> ...'`. Bounded at 72h; protected by a per-jobid flock so duplicate watchers can't fight. Interval tunable via `CHPC_POLL_INTERVAL` env var (seconds).
5. Eventually CHPC returns a terminal state (`COMPLETED`/`FAILED`/`TIMEOUT`/`OOM`/...). The watcher appends one JSON line to `.chpc_pending` and exits.
6. Hours later, the user types anything. Before that prompt reaches the model, `userprompt_route.sh` runs. It atomically rotates `.chpc_pending` to a tmpfile (so a watcher writing at that instant isn't lost), formats the contents as a "events since your last prompt" block, and emits it on stdout — which Claude Code prepends to the user's message as additional context.
7. The agent sees `job 13169761 → COMPLETED` glued on top of the user's message, reads the log files, folds the outcome into its reply.

The mental model: the watcher (background, hours-long) and the chat (foreground, idle) never talk directly — the mailbox file is the only bridge. The watcher only writes; the prompt hook only reads-and-clears.

What it deliberately doesn't do: it doesn't wake the chat. No notification, no auto-resume. If the user never sends another message, the agent never learns. That trade-off was the explicit Option A choice (vs. an autonomous variant that would inject a synthetic prompt via the adapter's `chat` RPC over NATS) — passive saves API tokens and avoids racing the user, at the cost of "you have to type for the agent to find out."

## 2026-06-16 — Skill preview vs. edit: why preview is read-only

**Q:** i can preview only, then what is the update for? agent can edit it, right?

**A:** Yes. The Skills panel separates *editing* from *publishing*:

1. **Edit** — happens in chat. You ask the agent to modify `~/.claude/skills/<name>/SKILL.md` (or any file in the skill folder); Claude uses Edit/Write tools directly on disk. You can also edit in a terminal — same file.
2. **Preview** (the inline expander, [`frontend/src/components/skills/SkillRow.vue`](../frontend/src/components/skills/SkillRow.vue)) — read-only view of what's currently on disk. Its only job is to let you verify what *would* be submitted before you press the button.
3. **Submit update / Share** — the button calls `share.submit({ kind: 'skill_update' | 'skill', ref: name })` ([`frontend/src/stores/skills.ts`](../frontend/src/stores/skills.ts)). The share-api snapshots the current SKILL.md + files and queues a request for the org reviewer. On approve, `/workspace/shared/skills/<name>/` is atomically replaced.

The split keeps the UI surface tiny — no in-browser editor, no save-vs-submit confusion — and reuses the chat's already-trusted editing path (with hooks, audit, etc.) rather than building a second one in the panel.

## 2026-09-06 — why an old service ID still reaches its container after salting

**Q:** why the old service id can still access container?

**A:** Because salting changed the *derivation*, not the *deployed identifiers*.
`SERVICE_ID_SALT` is a provisioning-time input to `hub/scripts/service-id.sh`;
nothing at runtime reads it. Two independent paths still carry the old value:

- **HTTP.** nginx routes on `hub/service-map.conf`, a generated file. Editing
  `gen-service-map.sh` changes the generator, not the artifact — the file still
  maps `1095be4c…` to `control`.
- **NATS.** `adapter/src/index.ts:34` reads `ID_HASH` from container env, fixed
  at `docker run` time, and derives `sha256(ID_HASH)` at boot. The container
  still holds `ID_HASH=9965fecf5d0b`, and `sha256(9965fecf5d0b)` is exactly the
  ID in the nginx map.

The key point: **nothing validates a service ID.** nginx does a map lookup and
NATS does subject matching — both pure membership tests, with no notion of a
"correctly derived" ID. So "old" and "invalid" are different categories: an ID
is live iff it is in the map and matches a subscribed subject, and the old ones
still are.

Hence the cutover must move both paths together (`gen-service-map.sh` +
recreate every container). Either alone breaks routing, because the two sides
would key on different IDs.

Corollary: the salt is purely prospective. It prevents *computing* IDs from the
published algorithm, but cannot retract the specific IDs already in the public
git history — those stay valid until the cutover rotates them out. See the
"Service ID derivation" section of `hub/users.md`.

## 2026-09-06 — moving the served domain to labweaver.ai, and why forwarding is not a migration step

**Q:** i want to move current serving domain labweaver.selfai.cc (namecheap) to
labweaver.ai (squarespace), or can i first just forward it?

**A:** Forwarding parks a domain; it does not serve the app. Squarespace URL
forwarding is an HTTP 301/302 that bounces the browser back to the old host, so
users still land on `labweaver.selfai.cc`. The blocking detail is the WebSocket:
`frontend/public/landing.html:252` builds `wss://<location.host>/ws/`, and the
browser WebSocket API does **not** follow 3xx on the handshake — it fails. A
forwarded domain therefore yields a page that loads and never connects.

The real move is one line, because the stack is already domain-agnostic. The
only functional binding is `hub/Caddyfile` (site block + TLS issuance);
`hub/docker-compose.yml:63` is a comment, `hub/nginx.conf:41` is `server_name _`,
and the frontend derives its host at runtime.

Sequence:
1. DNS first — A record for `labweaver.ai` -> `136.36.154.5`. Adding the name to
   Caddy before DNS resolves means repeated ACME failures and Let's Encrypt
   rate-limits failed validations.
2. Serve both names: `labweaver.ai, labweaver.selfai.cc { reverse_proxy ... }`.
   Port 80 is published, so HTTP-01 completes on its own.
3. `docker restart claude-bioflow-caddy` — **not** `caddy reload`. The Caddyfile
   is a single-file bind mount, so a host edit swaps the inode and the container
   keeps serving the detached copy while reload reports "config is unchanged".
   See [[project_caddyfile_bind_inode]]; `hub/nginx.conf` shares the trap.
4. Update the one-click URLs in `hub/users.md` (they hardcode `?nats=wss://...`).
5. Only later, redirect the old name — that redirect breaks bookmarked one-click
   URLs' WebSockets for exactly the same reason forwarding does.

## 2026-09-08 — labweaver.ai cutover, and the Host-field trap that hid it

**Q:** how to point it in squarespace / check my squarespace for the records i added

**A:** The record had been published the whole time — on the wrong name. A probe
sweep found `labweaver.labweaver.ai -> 136.36.154.5` while the apex answered
NOERROR with zero records. Squarespace's **Host** field takes only the label
*before* the zone, and appends the domain itself; typing the full domain (or
just `labweaver`) yields the doubled name. `@`, or blank, means the apex.

Diagnostic that isolated it, all against the authoritative NS rather than a
cached resolver (`dig +short @nsd1.squarespacedns.com ...`):
- 4 A records unchanged after an "edit" -> the edit never published (a preset
  owned by a connected Squarespace site was reverting it).
- 0 records after the deletion, but the deletion *did* publish -> edits work now.
- A per-label sweep then found the value sitting on the doubled name.

Note: the SOA serial stayed `1` across changes that demonstrably published, so
on Squarespace's Cloud DNS backend the serial is not a usable signal — count and
compare the actual answers instead.

Cutover, once the apex resolved on all four NS and on 1.1.1.1/8.8.8.8:
`hub/Caddyfile` -> `labweaver.ai, labweaver.selfai.cc { reverse_proxy ... }`,
`caddy validate` in a throwaway container, then **`docker restart
claude-bioflow-caddy`** (single-file bind mount — see
[[project_caddyfile_bind_inode]]). Cert via tls-alpn-01 in 9s. Result: both
names 200, HTTP 308 -> HTTPS, `CN = labweaver.ai` valid to 2026-12-07.

`www.labweaver.ai` was deliberately left out of the Caddyfile: it has no DNS
record, and a non-resolving name in a site block makes ACME fail and consume
Let's Encrypt's failed-validation rate limit.

## 2026-09-29 — Glasses recordings: store media in Postgres or on disk?

**Q:** I want to upload video/audio from the Meta glasses app (labweaver-glasses) to this
server for a future VLM auto-notes feature, and store the media in the SQL database. Can the
app get the server code, how are tokens issued, and where should recordings be stored?

**A:** Server code is the public repo `lili-8477/labweaver`; the `/api/glasses/*` endpoints
in the glasses spec §7 don't exist yet. There is no token issuer: the only per-user
credential is the salted service ID (`hub/scripts/service-id.sh`), sent as the `lw_service`
cookie and mapped to a user in `hub/nginx.conf`. It is long-lived, grants the whole
workspace, and rotates only by changing the salt for everyone, so it is fine as the v1
"pasted token" but a per-device revocable token (hashed in Postgres) should follow.

Keep media out of Postgres; put rows in Postgres and bytes on disk. Reasons: bytea tops out
at 1 GB per value and every write goes through WAL; the DR bundle is a `pg_dump`, so video
would swell every backup; ffmpeg and the VLM need file paths, so blobs would be written back
out to disk anyway; and `postgres-data` shares the disk with everything else (86% full on
2026-09-29). Layout: `recordings/<user>/<recordingId>/` holds the fMP4 segments; Postgres
holds `recordings` (owner, state, timestamps, device, config), `recording_chunks` (part,
track, seq, sha256, bytes, path) for idempotent PUTs and resume, events as JSONB, and the
VLM notes.

## 2026-10-29 — @anthropic-ai/sdk 0.x → 1.x: what changes, worth it for the indexer?

**Q:** What is the major version jump (indexer `@anthropic-ai/sdk` ^0.94 → 1.3.0)? Is it worth updating?

**A:** 1.0.0 is the first TS SDK release that sends API version `2026-10-21` by default (instead of `2023-06-01`). Breaking: `temperature`/`top_p`/`top_k` rejected on Messages; no `document` blocks in assistant turns or `citations` on user text; `MessageParam` becomes a per-role union; Text Completions and tool-runner client-side compaction removed; API key sent as `Authorization: Bearer` (matters if a proxy reads `X-Api-Key`); one credential per client; license → Apache 2.0. Guide: https://platform.claude.com/docs/en/api/migration-2026-10-21. For the indexer it's low value: `src/llm-client.ts` only does `import type Anthropic`, nothing constructs a client, and `distill()` is called only from tests since the auto-distill loop was removed (`src/index.ts:68`). So the bump is near-zero risk and near-zero benefit; deleting the unused `distill()` + dependency is the cleaner option. The adapter's agent SDK already pulls `@anthropic-ai/sdk` 0.104.x transitively, separately.

## 2026-10-29 — Avoiding memory bloat in the OpenViking-style redesign

**Q:** For memory, how can we avoid storage bloat?

**A:** Bloat hurts recall quality (more near-duplicates competing for a fixed context budget) long before it hurts disk, so the defence is mostly at write time:
1. **Merge, don't append.** Each memory type gets identity fields (OpenViking's `merge_op: immutable`, e.g. user+topic for a preference); a write with the same identity patches the existing row. Plus a near-duplicate check on embedding similarity before insert (v2's `memory_merge`), on top of today's exact `content_hash` dedup.
2. **Fixed folder taxonomy with per-folder caps.** Memories live in a small fixed set of dirs (`user/preferences`, `project/decisions`, …); when a folder passes its cap, consolidate similar entries into one instead of growing.
3. **Value-based retirement.** Use `hit_count`/`last_hit_at` (and outcomes): never-recalled memories past an age go to soft-delete; soft-deleted rows and old audit entries are hard-purged after a retention window.
4. **No automatic distillation.** Auto-distill was the main bloat source and is already off (`hub/indexer/src/index.ts:68`); memories come from explicit writes or `/memory` only. Transcripts stay the raw episode log and are never copied into memory.
5. **Cheap summaries.** L0/L1 exist per folder, not per memory; only the latest version is kept, regenerated only when ≥10% of a folder's children changed (OpenViking's freshness ratio).
6. **Hard limits.** A per-memory body size cap (one chunk, one 384-dim embedding), re-embed only on content change.

## 2026-11-02 — How the agent manages context size

**Q:** How does the agent manage context size now?

**A:** Mostly through Claude Code itself; the adapter adds nothing except a few caps on what it puts in.
- Each chat resumes its SDK session (`resume` in `adapter/src/claude.ts`), so history grows turn by turn. Prompt caching makes the repeated history cheap, not small.
- When the window fills, Claude Code auto-compacts: it summarizes earlier turns and continues. Only one li86 session has compacted so far; the PBMC notebook chat peaked at ~93k tokens.
- Inputs are capped where we add them: SessionStart memory context has a 2,000-token budget (`memory_session_start.sh`); `run_cells`/`run_code` output is cut to 20k characters in the middle (`adapter/src/notebook-tools.ts`); a selection is cut at 20k characters (`frontend/src/utils/selection.ts`). Claude Code truncates long Bash output and pages large file reads on its own.
- `capToolOutput` (900 KB) only limits what goes to the UI over NATS; it doesn't affect the model.
- Subagents (Task/Agent tool) run in their own context and return a summary, which keeps big explorations out of the main thread.
- Not done: no context-usage meter in the UI, and no automatic new session per task; a long-lived chat relies on compaction.

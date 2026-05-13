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

Bioflow application: bind-mount `shared/CLAUDE.md` into each container at e.g. `/workspace/.bioflow/shared.md`, seed each user's `CLAUDE.md` with `@/workspace/.bioflow/shared.md` as the first line, and shared edits will flow live to every workspace while user files own local overrides.

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

- **`work_dir` / cwd alignment** — agent must write `eval_answer.json` into the runner-supplied `work_dir`. Bioflow sessions default cwd to `/workspace` or `local_projects/<proj>/`. Easiest: make `work_dir` a subdir of `local_projects/scbench-runs/<task-id>/` so the agent's `Write` lands there.
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

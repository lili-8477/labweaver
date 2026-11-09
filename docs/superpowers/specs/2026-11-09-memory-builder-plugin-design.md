# Memory builder, plugin exporter and import: design

Status: proposal, waiting for approval. Source: `docs/manuscript/prompt_memory_builder_exporter.md`
and `docs/manuscript/figure1_labweaver_memory.png` (sources → memory builder → lab memory →
reviewed plugin export → other labs → import plugin).

## 1. What the code has today (Step 0)

**Write path.** Every memory insert goes through `insertMemoryRow` (`hub/indexer/src/distiller-repo.ts`):
one `memories` row, chunk 0 in `memory_chunks` with no embedding, the chunk queued in `embedder_queue`,
then `memory_facets`. Dedupe is the unique key `(username, project_dir, type, content_hash)` with
`ON CONFLICT DO NOTHING` (`content-hash.ts`: sha256 of `v<promptVersion> ` + the lower-cased,
whitespace-collapsed body). `writeUserMemory` (`memory-write.ts`) wraps it with the merge check,
`appendAudit` (`memory-audit.ts`) and a transaction (`tx.ts`). The embedder worker
(`embedder-worker.ts`) drains the queue against the sidecar, which runs **multilingual-e5-small**
(384-dim, migration 0026).

**Search.** `memory-search.ts`: a hybrid of lexical (tsvector), exact-facet and vector signals,
multiplied by a query-independent prior (scope, task outcomes, reinforcement; no time decay). It
is not RRF. A BM25 rewrite is in progress in the working tree (uncommitted `memory-search.ts` and
`migrations/0028_memory_bm25.sql`). This design does not touch search code; new migrations start
at **0029**.

**Visibility.** Every read path (search, get, list, tree, dirs, context bundle, graph) applies
`visibleSql` (`memory-access.ts`). That is the one place a "plugin enabled" filter belongs.

**Types and source.** `memories.type ∈ {user, feedback, project, reference, session_summary,
observation, claim, experience}` (0019); `source ∈ {user, distilled}` (0006). There is also
`domain ∈ {lab, technical}` (0022), and directories (`memory_dirs`, 0014) with a default directory
per (scope, type) in `memory-dirs.ts`.

**Facets.** Free-form `key → string[]` on write (`memory-contract.ts`). The catalogue in
`facet-keys.ts` only restricts the `conditions` search filter.

**Uploads.** Files and folders go to the adapter's `PUT /upload/<path>` (`adapter/src/upload-http.ts`),
under `local_projects/` only (plus `.labweaver/skills/`). Since today the chat composer uploads into
the chat's project. Nothing turns uploaded content into memory. **There is no website upload.**

**Model access.** The indexer has no model client, and the hub env has no model keys. Distillation
is agent-driven: the agent builds the structured entries and posts them to `memory_distill`. Model
keys (`DEEPSEEK_API_KEY`, `OLLAMA_API_KEY`) exist only in user containers
(`adapter/src/providers/registry.ts`).

**Parsers available.** The container venv has pypdf, PyMuPDF, openpyxl, pandas and bs4 (no
python-docx). Neither Node service has a zip, PDF or Office library.

**Share flow.** `share_requests` (`artifact_kind ∈ {memory, skill, folder, skill_update}`); managers
come from `MEMORY_ORG_MANAGER`; `share-api.ts` + `share-repo*.ts` handle create, review and approve.
Org rows live under `username='__org__'`.

**UI path.** The frontend calls the `UI_OPS` in the memory contract over NATS, and the adapter's
`MemoryForwarder` (`adapter/src/memory-rpc.ts`) forwards them with its own username. The Memory
panel is `frontend/src/components/memory/*` with `services/memory.ts` and `stores/memory.ts`.

## 2. Decisions

1. **The builder runs in the member's container, not the indexer.** Files, parsers and the model
   key are all there, and it keeps the indexer model-free. The adapter runs the job. A Python helper
   (`image/memory-builder.py`, shipped like `kernel-bridge.py`) does parse and segment: deterministic
   for tables, model-assisted for documents. The adapter then posts the entries to one new indexer
   write, `memory_import`. The trust model is unchanged: the adapter injects the username.
2. **Category is a facet plus a directory, not new types.** Rows are `type='reference'`,
   `domain='lab'`, with facet `category=<protocol|inventory|data_record|pipeline|reference>`. Each
   category gets a directory per scope (`user/protocols`, `project/protocols`, `org/protocols`, and
   so on), so the memory tree shows the figure's four boxes. New types would touch ranking, default
   directories, distill, the contract and the UI; a facet plus a directory gives the same filtering
   and display for one migration.
3. **`source='import'`** (migration extends the CHECK) for builder and plugin rows. The content-hash
   version is `BUILDER_PROMPT_VERSION`, so rebuilding the same source is idempotent.
4. **Plugins are a namespace.** `memory_plugins` plus a nullable `memories.plugin_id`. `visibleSql`
   gains "plugin_id is null, or its plugin is enabled", so search, context, list and graph all
   follow the toggle with no per-query change.
5. **The bundle is built in the container.** The indexer returns redacted rows (manager-only op).
   The adapter's Python helper writes `<name>-<version>.lwplugin.zip` into the manager's workspace,
   and the existing `/download/` route serves it. Import is the reverse: upload the zip with the
   existing upload, the helper validates and unpacks it, and the adapter posts the entries with
   `plugin_id`. No zip library is added to Node.
6. **Websites are fetched in the container** and saved as a snapshot
   (`<project>/sources/web/<host>-<date>.html`), so provenance points at a file that stays. The
   snapshot then goes through the same parse path as an uploaded HTML file.
7. **Lab scope only through review.** Building or importing at lab scope creates one share request
   (new `artifact_kind='plugin'` for plugins; builder output goes in as `memory` share requests in
   one batch). Skills inside a plugin become `skill` share requests and are never auto-enabled.

## 3. Schema (migrations 0029–0031)

- **0029_memory_import_source.sql**: `source` CHECK adds `'import'`; `memory_dirs` gets the 15
  category directories (5 categories × 3 scopes).
- **0030_memory_build_jobs.sql**: `memory_build_jobs(job_id, username, project_dir, origin_kind
  file|folder|website, origin, status queued|running|done|failed, files_seen, files_parsed,
  files_skipped, entries_created, duplicates, report jsonb, error, created_at, finished_at)`.
- **0031_memory_plugins.sql**: `memory_plugins(plugin_id, owner '__org__'|<user>, name, version,
  source_lab, manifest jsonb, status enabled|disabled, installed_by, installed_at, deleted_at)`,
  unique `(owner, name)` among live rows; `memories.plugin_id` FK, indexed; `share_requests`
  `artifact_kind` adds `'plugin'`.

## 4. Pipeline

1. **Parse** (helper): PDF (pypdf, then PyMuPDF), docx (zipfile + XML; no new dependency), xlsx/csv
   (pandas; one entry per row by default, `per_table` optional), md/txt, HTML (bs4, stripping nav,
   footer and script). Folders are walked recursively with an ignore list (`.git`, `node_modules`,
   `.ipynb_checkpoints`, dot-folders), size caps (per file 20 MB, per job 500 files) and skipped
   suffixes (fastq, bam, cram, h5ad, h5, loom, zarr, images, archives). Every skip is recorded in
   the job report.
2. **Segment**: tables map rows to entries by rule (an order-ID or sample column marks
   `data_record`, a reagent, catalog or lot column marks `inventory`). Documents go to the member's
   own default model with a versioned prompt (`BUILDER_PROMPT_VERSION = 1`, OpenAI-compatible call
   from the adapter). Each output is checked against a zod schema `{category, name ≤80,
   description ≤200, body ≤1500, facets}`; failures are retried once, then reported as skipped.
3. **Provenance** facets on every entry: `origin_kind`, `origin` (workspace-relative path or URL),
   `origin_sha256`, `imported_at`, `builder_version`.
4. **Write**: `memory_import` posts a batch of up to 200 entries. Per entry it runs
   `insertMemoryRow` with `source='import'` and an audit row, in one transaction per batch.
   Duplicates come back as counts. Embedding goes through the existing queue.
5. **Agent tool**: `memory_build` in mcp-memory starts a job ("add this folder to memory"). It
   returns the job id, and `memory_build_status` reads progress.

## 5. Export and import

- **Export** (`memory_plugin_export`, manager-only; the indexer checks the actor against
  `MEMORY_ORG_MANAGER`): lab-scope rows only, selected by category, facet, date or ids. The indexer
  redacts usernames (the user registry), host paths (`/home/…`, `/Users/…`; `/workspace/` becomes
  relative) and secret patterns (tokens, `KEY=`/`PASSWORD=` lines, JWTs, `sk-…`). A preview returns
  counts and the number of redactions. Shared skills are copied from the lab skills folder. The
  layout is the prompt's (`manifest.json`, `memories.jsonl`, `skills/`, `README.md`), with a sha256
  per file in the manifest. It is documented in `docs/memory-plugin-format.md`.
- **Import** (`memory_plugin_import`): the helper checks the manifest schema, `format_version`,
  checksums, size limits and paths (no `..`, no symlinks). Anything outside `manifest.json`,
  `memories.jsonl`, `README.md` and `skills/*/` is stripped with a warning (hooks, agents, MCP
  configs, settings). A preview returns counts per category, 5 sample entries and the conflicts.
  On commit, entries go through `memory_import` with `plugin_id`. A local row wins on the same
  content hash or the same name plus category, and the report lists it. Installing a new version
  replaces the plugin's rows in one transaction. Uninstall soft-deletes the plugin's rows and marks
  the plugin deleted.
- **Untrusted text**: rows with `source='import'` reach the agent wrapped as reference material
  (`<reference source="plugin:name@version">…</reference>`, with a note that it is data, not
  instructions) in mcp-memory's output and in the context bundle. Nothing from a plugin is
  executed or loaded as config.

## 6. UI (Memory panel)

- **Import** button with three tabs: *Files & folders* (pick from the workspace or upload),
  *Website* (URL), *Plugin* (upload a `.lwplugin.zip`, or a URL). Each has a preview step (files
  found and estimated entries; or the manifest, counts per category, samples, conflicts) and a
  scope selector (project, user, or lab via review).
- A **jobs tray** with live progress (polled from `memory_build_status`) and the final report.
- A **Plugins** tab: installed plugins with version, source lab and entry count; an enable/disable
  toggle, uninstall, and "view entries" (filters the list by `plugin_id`).
- Rows show a plugin badge (source lab, version), and the source badge shows `import`.
- Managers get **Export plugin**: selection, preview with the redaction count, name, version and
  license, then download.

## 7. Tests

- Indexer (testcontainers): `memory_import` dedupe, audit and provenance; jobs; plugins
  (enable/disable through `visibleSql`, uninstall, version replace, local-wins conflicts); export
  redaction and the manager check; `20643R` search ranks the data record first.
- Helper (pytest, fixture folder: protocol PDF, inventory xlsx, sequencing-order csv, a binary to
  skip): parse, segment by rule, the skip report, bundle round-trip, a tampered checksum, a stripped
  hook file. The model step is stubbed.
- Adapter (vitest): the new RPCs and the build job runner with a fake indexer client.
- Frontend: there is no test runner, and no new dependencies are allowed. Store logic is tested
  with the scratch SSR-build method from the deploy notes.
- Full suites, typecheck and lint for each package.

## 8. Phasing

1. Builder: migrations 0029–0030, helper, `memory_import`, jobs, the agent tool, the Import tab
   for files and folders.
2. Website snapshots.
3. Export: format doc, redaction, manager UI.
4. Import: plugins table, `visibleSql` filter, Plugins tab, the lab-scope review path.

Each phase ships on its own, adapters first, then the indexer, then the frontend.

## 9. Open questions

1. **Model for segmenting documents.** Recommendation: the member's own default model (their key,
   their cost). The alternative is a hub-level key, so the indexer could run builds without a
   container.
2. **Lab-scope builds.** Recommendation: one share request per job, approved as a batch, rather than
   one per entry.
3. **Website fetching** reaches out to external sites from the member's container. Recommendation:
   allow it, with a size cap (5 MB), a timeout, and only http(s).

## 10. Alignment with v1 (claude-bioflow)

The same feature ships to both apps. Since the memory port, both indexers share the memory code
(`insertMemoryRow`, `memory-dirs.ts`, `memory-access.ts`, `content-hash.ts` and the memory
contract), so most of this design is common:

| Part | Shared | v2 (labweaver) | v1 (claude-bioflow) |
|---|---|---|---|
| Indexer: `memory-import.ts`, jobs, contract ops | same code | migrations 0029–0030 | same SQL as 0025–0026 |
| Python helper `memory-builder.py` | same file | `image/`, copied by `Dockerfile.overlay` | `image/`, copied by the patch layer |
| Builder job runner (adapter) | same module | | |
| Model step (`Segmenter`) | one interface: text → entries | DeepSeek (Anthropic Messages API) or Ollama Cloud (OpenAI-compatible), with the member's key | one-shot Agent SDK `query()` with no tools, under the agent's own Claude login (v1 containers hold no API key) |
| Agent tools `memory_build`, `memory_build_status` | same names and schema | adapter loopback MCP endpoint, mounted in `dsh/patch.ts` | in-process SDK MCP server in the chat turn's `mcpServers` |
| Adapter RPCs | same names | handler table (`rpc.ts`) | `switch` in `rpc.ts` |
| Frontend Import tab and jobs tray | same components | | |

Order: build and test in v2, then port to v1, the way the upload rework was ported (`bfd6015`).
Each app is deployed separately and only with approval.

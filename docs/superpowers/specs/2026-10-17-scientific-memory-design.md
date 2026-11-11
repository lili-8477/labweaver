# Scientific memory — design (v2 of agent memory)

Status: proposal, 2026-10-17.

This design extends
[2026-05-05-agent-memory-design.md](2026-05-05-agent-memory-design.md) and
the phase 1–4 work after it. That work added directories, merge-on-write,
outcome ranking and experience promotion.

Reference design:
[Tencent-Hunyuan/Hy-Memory](https://github.com/Tencent-Hunyuan/Hy-Memory)
v2.0.3. We read the README and `docs/`. We did not read the source. Those
documents publish no benchmark numbers.

## Glossary

- **Claim:** an immutable memory row that states one scientific fact. Each
  claim has a kind: `run`, `observation`, `result`, `interpretation`,
  `decision` or `feedback`.
- **Run claim:** the one claim per session that describes the analysis or
  experiment of that session.
- **Experience:** a memory row that states a reusable lesson. Each
  experience names when the lesson applies and how it can fail.
- **Evidence:** a file, transcript entry, image, notebook or instrument run
  that a memory row cites.
- **Condition facets:** the facet keys that describe the conditions of an
  experiment (§4.2).
- **Condition key:** a hash of the condition facets and the subject of a
  claim (§5.3).
- **Edge:** a typed relation between two memory rows (§4.3).
- **Context bundle:** the cited answer that `memory_context` returns (§6).

## 1. Goal

LabWeaver must record five things for each scientific memory:

1. What the lab observed.
2. The conditions of the observation.
3. The evidence for the observation.
4. What changed later.
5. Whether a lesson is safe to reuse.

A new result must not replace an old result without a record.
Two results that seem to conflict can come from different conditions. For
example, they can differ by cell line, reagent lot, dose, time point, assay,
processing version or QC state.

Hard constraints:

- Use one canonical store: the existing Postgres/pgvector `memories` schema.
  Do not add a second database. Do not add a graph database.
- Do not call an LLM on the live chat path. Do not block the live chat path.
- Keep the on-demand distillation gate. LabWeaver deleted auto-distill
  because session summaries and observations made retrieval worse
  (`hub/indexer/src/index.ts:73`).
- Do not let ordinary memories change an approved SOP or skill.

## 2. What we use from Hy-Memory, and what we do not use

| Hy-Memory idea | Use it? | LabWeaver form |
|---|---|---|
| The working scene writes exactly one `WorkingFact` per session. It also writes 0..N `Experience` rows that pass a value bar. The fields `source_fact_ids` and `derived_experience_ids` link them. | Yes. This is the core of the write path. | Distiller v2 writes one run claim and 0..N experience candidates (§5.2). |
| L1 RAW is append-only. Search never returns L1 RAW. | Yes. LabWeaver already does this. | The indexer reads the JSONL transcripts. The transcripts are the immutable episode log. Memories cite the transcripts. Search never returns them. |
| L2 facts are versioned and immutable. Reconcile has four operations: ADD, UPDATE, SUPERSEDE and SHADOW. | Yes, with a scientific guard. | Claims are immutable. Supersession occurs only inside one condition key (§5.3). |
| Reconcile writes typed relations: `causes`, `elaborates`, `contrasts` and `same_series`. | Yes, with lab terms. | The column `memory_edges.rel` holds the relation (§4.3). |
| The coding diff chain uses no LLM. Facts store the location of code, not the code. The chain decorates retrieved hits. It does not retrieve hits. | Yes. This model fits protocols and pipelines. | A version chain for protocols, notebooks and pipelines decorates the hits (§6.4). |
| Filters run inside the backend before the top-k cut. A source filter excludes `mixed` rows by default. | Yes. | Hard filters run in the SQL CTEs. The writer gives each memory the strictest access class of its evidence (§4.4). |
| The `branch` filter keeps rows that have `branch IS NULL`. | Yes. | A condition filter excludes rows with a different value. It keeps rows with no value and flags them (§6.1). |
| Default search makes zero LLM calls. | LabWeaver already does this. | No change. |
| The graph is optional. A graph error returns the order from before the graph step. The vector store is the source of truth. | Yes. | Lineage expansion and an optional rerank use a Postgres edge table (§6.3). |
| Graph rerank uses `support(v)=Σ prior(u,v)·score(u)/√deg(v)` and `score' = score + β·min(support, cap)`. It does not use `semantic_neighbor` edges, because they repeat vector similarity. | Yes, in phase 6. | Same formula. Typed edges only. |
| System 2 (`evolve()`) never runs inside `add()`. The caller starts it. | Yes. | A manager starts the consolidation job (§7). |
| Event time (`memory_at`) is separate from write time (`gmt_created`). | Yes. | `observed_at` is separate from `created_at`. |
| Extraction cuts tool output to 2048 bytes (head and tail). It cuts assistant text to the first 3,000 and the last 3,000 characters. | Yes. | The distiller input budget uses the same limits (§5.2). |
| L7 intentions have an expiry date. | Partly. | Claims have a `valid_to` column. LabWeaver adds no separate layer. |
| Recall strength decays with access count (τ=180 days). | No. | Outcome ranking (`success_count`, `failure_count`, migration 0016) gives a better signal. |
| Other parts: the scene-router LLM call, the reserved L4/L5 layers, topic and episode summaries, the entity store, Kuzu, Neo4j and Chroma. | No. | These are too large for the scale of LabWeaver. Summaries made retrieval worse before. |

## 3. The main change from the first draft: no five new tables

The first draft names five entities:

1. EvidenceAsset
2. ExperimentEvent / AnalysisRun
3. Claim
4. Experience
5. LineageEdge

Separate Claim and Experience tables would need new code for embedding,
chunking, FTS, directories, audit, merge-on-write, share promotion and
outcome feedback. All of these features use `memories.memory_id` as the key.
Thus this design does the steps that follow:

- Add `claim` and `experience` as new values of `memories.type`. A zod
  schema checks their typed fields in the column `attrs JSONB`. The existing
  table `memory_facets` holds their condition facets.
- Store an AnalysisRun or ExperimentEvent as a claim with
  `claim_kind = 'run'`. The run claim has the role of the Hy-Memory
  `WorkingFact`. The JSONL transcript already holds the immutable raw event.
  The run claim cites the transcript as evidence.
- Add new tables for evidence and edges only. These rows are different from
  memory rows. They are immutable, they have no embedding, and their
  relations are many-to-many.

The result is three migrations. Search, audit, directories, share, feedback
and the UI continue to operate on the new rows with no change.

## 4. Schema (migrations 0019–0021)

### 4.1 Additions to `memories` (0019)

```sql
ALTER TABLE memories DROP CONSTRAINT memories_type_check;
ALTER TABLE memories ADD CONSTRAINT memories_type_check CHECK (type IN (
  'user','feedback','project','reference','session_summary','observation',
  'claim','experience'));

ALTER TABLE memories
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN
    ('active','proposed','superseded','retracted','shadowed')),
  ADD COLUMN claim_kind TEXT CHECK (claim_kind IN
    ('run','observation','result','interpretation','decision','feedback')),
  ADD COLUMN confidence REAL CHECK (confidence BETWEEN 0 AND 1),
  ADD COLUMN validation_level TEXT CHECK (validation_level IN
    ('anecdotal','repeated','replicated','reviewed')),
  ADD COLUMN observed_at TIMESTAMPTZ,          -- event time (Hy: memory_at)
  ADD COLUMN valid_from  TIMESTAMPTZ,
  ADD COLUMN valid_to    TIMESTAMPTZ,
  ADD COLUMN access_class TEXT NOT NULL DEFAULT 'internal' CHECK (access_class IN
    ('public','internal','restricted','irb')),
  ADD COLUMN condition_key BYTEA,               -- §5.3
  ADD COLUMN attrs JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX memories_condition_idx ON memories (username, project_dir, condition_key)
  WHERE condition_key IS NOT NULL AND status = 'active' AND deleted_at IS NULL;
```

The zod schemas for `attrs` go next to the distiller prompts:

- `claim`: `{ subject, statement, inputs[], parameters{}, outputs[], qc{status, metrics{}}, uncertainty }`
- `experience`: `{ task, solution, applicability[], boundary_conditions[], expected_qc{}, failure_modes[], search_keys[] }`

Directories:

- Claims go in `project/decisions`.
- Run claims go in `project/trajectories`.
- Experiences go in `user/experience`. The existing share review
  (`experience-promotion.ts`) promotes them to `org/experience`.
- This design adds no new directories.

**Immutability rules:**

- Claim rows are immutable, like the read-only distilled rows
  (`memory-api.ts:461`).
- To correct a claim, write a new claim row. Then write a `SUPERSEDES` edge
  or a `RETRACTS` edge. Then change the `status` of the old row.
- `status` is the only column of a claim that can change.
- The audit log records each change of `status`.

### 4.2 Condition facets (no migration, catalogue in code)

The existing table `memory_facets(key, value)` holds the values for the hard
filters. A new module `facets.ts`, next to `memory-dirs.ts`, defines the
closed list of keys:

- **Biology:** `species`, `model`, `cell_line`, `tissue`, `sample`, `cohort`
- **Method:** `assay`, `protocol`, `protocol_version`, `reagent_lot`, `instrument`, `run_id`, `dose`, `timepoint`
- **Analysis:** `dataset`, `dataset_version`, `reference`, `pipeline`, `pipeline_version`, `code_version`
- **Existing:** `gene`, `tool`, `file`

The writer normalizes each value before it writes the row:

- Make the value lower case. Exception: keep each gene symbol as the user
  wrote it.
- Delete the spaces at the start and at the end of the value.

### 4.3 `memory_edges` (0020)

```sql
CREATE TABLE memory_edges (
  src_id     UUID NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
  dst_id     UUID NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
  rel        TEXT NOT NULL CHECK (rel IN (
               'DERIVED_FROM','SUPPORTS','QUALIFIES','CONTRADICTS',
               'SUPERSEDES','RETRACTS','VALIDATED_BY','FAILED_TO_REPLICATE')),
  status     TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','rejected')),
  actor      TEXT NOT NULL,             -- username or 'distiller'
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (src_id, dst_id, rel)
);
CREATE INDEX memory_edges_dst_idx ON memory_edges (dst_id, rel);
```

Read each edge as `src rel dst`. Examples: "new SUPERSEDES old",
"experience DERIVED_FROM claim". The table below gives the rules for each
edge.

| rel | Who can write it | Effect on dst |
|---|---|---|
| `DERIVED_FROM` | The distiller writes it when it links an experience to its run claim. It uses no LLM for this. | None. |
| `SUPPORTS`, `QUALIFIES`, `CONTRADICTS` | Reconcile proposes it. The default status is `accepted`. | None. Both rows stay active. The bundle shows both rows. |
| `SUPERSEDES` | The rule in §5.3 writes it. In all other cases, a human writes it. | `status='superseded'` |
| `RETRACTS` | A human only. | `status='retracted'` |
| `VALIDATED_BY`, `FAILED_TO_REPLICATE` | A human only. A run claim that the user links can also write it. | It increases or decreases `validation_level`. `FAILED_TO_REPLICATE` stops promotion. |

The phase 6 rerank uses the priors below. They follow the Hy-Memory table.

| Prior | rel |
|---|---|
| 0.9 | `SUPPORTS`, `VALIDATED_BY` |
| 0.8 | `DERIVED_FROM` |
| 0.7 | `QUALIFIES` |
| 0.6 | `CONTRADICTS` (the bundle shows it, but it does not increase the score) |
| 0.0 | `SUPERSEDES`, `RETRACTS` (navigation only) |

### 4.4 Evidence (0021)

```sql
CREATE TABLE evidence_assets (
  evidence_id  UUID PRIMARY KEY,
  uri          TEXT NOT NULL,       -- file://, s3://, chpc://, transcript://<session>/<entry_uuid>
  sha256       BYTEA,               -- NULL for transcript refs (JSONL is append-only already)
  modality     TEXT NOT NULL CHECK (modality IN
                 ('transcript','tool_output','file','image','video','notebook','instrument_run','table')),
  locator      JSONB NOT NULL DEFAULT '{}'::jsonb,  -- byte/line offsets, cell id, run id, instrument
  observed_at  TIMESTAMPTZ,
  actor        TEXT NOT NULL,
  access_class TEXT NOT NULL DEFAULT 'internal',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (uri, sha256)
);
CREATE TABLE memory_evidence (
  memory_id   UUID NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
  evidence_id UUID NOT NULL REFERENCES evidence_assets(evidence_id),
  role        TEXT NOT NULL DEFAULT 'source' CHECK (role IN ('source','input','output','qc')),
  PRIMARY KEY (memory_id, evidence_id, role)
);
```

- The streaming sha256 code in `share-fs.ts` calculates the checksums.
- Migration 0021 copies each value of `memories.source_entry_uuids` into a
  `transcript://` evidence row. The migration does not change
  `source_entry_uuids`.
- **Access inheritance:** the writer sets the `access_class` of a memory to
  the strictest class of its evidence. No automatic process makes the class
  less strict. This rule follows the Hy-Memory rule for `mixed` rows: when
  the data is mixed, the system excludes the row.

## 5. Write path

### 5.1 Capture: LabWeaver already does this. Keep it.

- The adapter writes Claude-format JSONL for both harnesses
  (`adapter/src/transcript/claude-jsonl.ts`).
- The indexer reads the JSONL as it grows (`watcher.ts` → `process-file.ts`).
- The JSONL files are the immutable episode log. **The adapter needs no
  change.**

This design adds one new capture step to the indexer. This step uses no LLM:

1. `process-file` finds a tool result that names output files, instrument
   run IDs or CHPC job IDs.
2. `process-file` writes an `evidence_assets` row for each one. If the row
   exists, it updates the row.
3. If `process-file` cannot parse a tool result, it ignores that result.
4. A failure in this step never stops ingestion.

This step works like the Hy-Memory coding chain capture.

### 5.2 Distillation v2: typed and on demand

The only trigger stays the same: `/memory` → `memory_distill_session` →
`POST /memory/distill`.

`PROMPT_VERSION = 2` changes the output. The old output was one summary and
up to 8 observations. The new output is:

```ts
{ run:         { claim_kind:'run', subject, statement, conditions:{facet→[values]},
                 inputs, parameters, outputs, qc, evidence_refs[] },     // exactly 1
  claims:      [ { claim_kind, statement, conditions, confidence, evidence_refs[] } ],  // 0..5
  experiences: [ { task, solution, applicability, boundary_conditions, expected_qc,
                   failure_modes, search_keys, source:'run'|claim_index } ] }  // 0..3, must pass the value bar
```

**Value bar for experiences.** An experience must satisfy all three
conditions below. If it does not, the distiller does not write it.

1. It is reusable on a different task.
2. It names one or more applicability conditions.
3. It names one or more failure modes or boundary conditions.

Hy-Memory teaches this lesson: always write the run claim, and gate each
experience.

**Input budget:**

- Use the last 5 user turns as context.
- Cut each tool result to 2 KB. Keep the head and the tail.
- If assistant text is longer than 6,000 characters, keep the first 3,000
  and the last 3,000 characters.

**Evidence references:**

- `evidence_refs` contains entry UUIDs from the transcript.
- The writer changes each UUID to an `evidence_assets` ID.
- The LLM never writes a URI.

**Links:**

- The writer adds a `DERIVED_FROM` edge from each experience to its source
  claims.
- The writer sets `validation_level` to `anecdotal` on each new experience.

### 5.3 Reconcile: supersession that uses conditions

This step extends merge-on-write (`memory-merge.ts`). Do these steps in
sequence:

1. Calculate the condition key. The formula is
   **`condition_key = sha256(sorted condition facets ∪ subject)`**. Use only
   the method keys and the biology keys from §4.2. This step uses no LLM.
2. Find candidate rows. A candidate is one of these:
   - A row with the same `condition_key`.
   - One of the top-k active claims in scope by vector similarity. The
     existing `findSimilar` function finds these.
3. If a candidate has the same condition key and the same statement, merge
   the new row into it. This is the current merge behavior.
4. In all other cases, select one operation from the list below.
   - **SUPERSEDE.** Use it only when all four conditions are true:
     - The new row and the old row have the same `condition_key`.
     - The new row has a later `observed_at`.
     - The new row has a newer protocol, pipeline or code version.
     - The same author wrote both rows.

     Write a `SUPERSEDES` edge. Set `old.status = 'superseded'`. This is
     the only automatic supersession.
   - **QUALIFY or CONTRADICT.** Use it when the subjects are similar but the
     `condition_key` values are different. Never supersede in this case.
     Write the new row. Propose a `QUALIFIES` edge. If the results
     disagree, propose a `CONTRADICTS` edge. The bundle shows both rows. The
     condition facets that are different explain the difference in results.
   - **ADD.** Use it in all other cases.
5. **Shadow.** Set `status='shadowed'` on a claim in two cases:
   - A user deleted all of its evidence.
   - A human hides the claim.

   Search does not return a shadowed claim. Lineage can show it.

Reconcile can use an LLM for one task only: to give a label to the relation
between candidates that the SQL query found. The LLM never selects which
row to supersede.

## 6. Read path: `memory_context(task)` returns a context bundle

The SessionStart directory index (`getContext`) does not change. It shows a
small map of the directories. It does not show the full memory text.

A new MCP tool `memory_context` and a new route `POST /memory/bundle`
return the context bundle. The agent calls them for a specific task. They
make **zero LLM calls**.

### 6.1 Hard filters (in SQL, before top-k)

Add these filters to `VISIBLE_SQL`. The vector arm and the FTS arm then
apply them before `LIMIT 200`. The HNSW iterative scan makes sure that the
limit counts only visible rows.

- **Scope and access:** `scope` is one of project, user or org. The
  `access_class` of the row must be at or below the clearance of the caller.
- **Status:** the default is `status = 'active'`. Search shows superseded
  rows and retracted rows only through lineage (§6.3).
- **Conditions:** for each requested `key=value`, apply these rules:
  - If a row has the key with a different value, exclude the row.
  - If a row does not have the key, keep the row. Flag it as
    `unconditioned`. This is the Hy-Memory `branch IS NULL` rule.
  - If the caller sets `strict=true`, also exclude rows that do not have
    the key.
- **Versions and time:** filter on `pipeline_version`, `protocol_version`,
  an `observed_at` window, and `valid_to IS NULL OR valid_to > now()`.

### 6.2 Three arms

1. **Vector:** the existing arm. It calculates `vec_sim` from the 384-dim
   embedding.
2. **FTS:** the existing arm. It uses `to_tsvector('english', …)`.
3. **Exact identifiers (new):** this arm splits the query into tokens with
   no stemming. It compares each token with the values in `memory_facets`.
   Examples of these values are gene symbols, sample IDs, reagent lots and
   versions. The `english` configuration stems these identifiers and splits
   them. Embeddings also match them badly. Thus the first draft is correct:
   these identifiers need an exact-match arm.

Scoring:

- The score is `0.55·vec + 0.25·fts + 0.20·exact`. The existing outcome
  prior multiplies this score.
- An exact match on an ID that the user named must rank first. Thus the
  exact arm is also the tiebreak key.
- If the embedder is not available, search uses FTS only. This is the
  current behavior. Do not change it.

### 6.3 Lineage expansion (it decorates hits, it does not retrieve them)

For each of the top-k hits, read the 1-hop `memory_edges` in both directions.
Attach the edges to the hit. Do not use a top-k slot for them. This is the
Hy-Memory `EXPAND_MERGE_SEED` behavior. The rules:

- **A superseding row exists:** show the newest active row in place of the
  hit. Keep the old hit as `lineage.supersedes`.
- **A `CONTRADICTS`, `QUALIFIES` or `FAILED_TO_REPLICATE` edge exists:** show
  the edge. Show the condition facets that are different between the two
  rows. To find them, compare the facets of the two rows.
- **The hit is an experience:** show its source claims. The
  `DERIVED_FROM` edges give these claims.

Put the expansion in a try/catch block. If an error occurs, return the
bundle without lineage and set `lineage_error: true`. Search must not fail
because of a lineage error.

### 6.4 Version chain (protocol, pipeline, notebook)

This is the Hy-Memory coding diff chain, applied to lab artifacts.

- **Current version:** for each `protocol` facet or `pipeline` facet in the
  hits, the bundle states the current version. The version comes from git or
  from the skills directory, and from the file sha256 in `evidence_assets`.
  The version never comes from LLM memory.
- **Version mismatch:** if the lab observed a hit under an older version,
  the bundle says so.
- **Storage:** this feature needs no new storage. The chain is the git
  history and the evidence checksums.

### 6.5 Bundle shape

```ts
interface ContextBundle {
  query: string; filters: Record<string, string[]>;
  current_versions: { key: string; value: string; source_uri: string }[];
  facts:       BundleItem[];   // claims: run/result/observation/decision
  experiences: BundleItem[];   // with applicability + failure_modes
  warnings:    string[];       // "2 results conflict across cell_line", "hit used pipeline v1.2, current v1.4"
}
interface BundleItem {
  memory_id: string; statement: string; claim_kind?: string;
  conditions: Record<string, string[]>; unconditioned?: string[];
  qc?: unknown; confidence?: number; validation_level?: string;
  status: string; observed_at?: string;
  evidence: { evidence_id: string; uri: string; modality: string }[];
  lineage:  { rel: string; other_id: string; differs_on?: string[] }[];
}
```

The API renders the bundle for the agent as compact text:

- The default size is about 1,500 tokens.
- Each line ends with `[memory_id]` and the evidence URIs. The agent can
  copy these as citations.
- `memory_feedback` continues to supply the outcome signal.

## 7. Promotion and consolidation

**Experience → org.** The `proposeExperiences` gate continues to require 3
successes. This design adds two more conditions:

1. The experience has no accepted `CONTRADICTS` edge and no accepted
   `FAILED_TO_REPLICATE` edge.
2. The `validation_level` is `repeated` or higher.

**Experience → skill.** A manager can change an approved org experience into
a `skill_update` share request. Migration 0012 added this artifact kind.
The steps:

1. The share flow generates a draft `SKILL.md` diff.
2. A reviewer reviews the diff.
3. The share flow writes the approved version.

No memory write path writes to `skills/` directly.

**Consolidation ("System 2").** A manager starts this job with
`POST /memory/consolidate`. Only a manager can call this route. The job does
these steps:

1. It groups active claims by `condition_key`.
2. It proposes `SUPPORTS` edges and `CONTRADICTS` edges.
3. It flags each experience whose source claims have the status
   `superseded`.

The job writes each change with the status `proposed`. The job never runs
on write.

## 8. Phases

Each phase is complete by itself. No phase changes existing behavior.

1. **Schema.** Migrations 0019–0021, the facet catalogue, and the copy from
   `source_entry_uuids` to evidence rows. Behavior does not change.
2. **Distiller v2 and evidence capture.**
   - Prompt v2 with zod schemas.
   - The evidence extractor in `process-file`. It uses no LLM.
   - `DERIVED_FROM` edges.
   - Old `session_summary` rows and `observation` rows stay readable.
3. **Reconcile.** `condition_key`, claim immutability, the supersede rule,
   and the audit of status changes.
4. **Retrieval.** Hard filters, the exact-ID arm, lineage decoration, the
   version chain, and `memory_context` (MCP and API).
5. **Promotion.** The new promotion conditions, and proposals from
   experience to `skill_update`.
6. **Graph and consolidation.**
   - Graph rerank: support propagation, β=0.15, cap 1.0, normalized by
     degree. A graph error returns the order from before the graph step.
   - The manager-started consolidation job.

## 9. Evaluation

Extend `hub/scripts/memory-recall-eval.py`. Keep its gate: Recall@5 ≥ 0.8.
Add test cases for scientific behavior, not only for recall:

- **Conflict:** the same assay on two cell lines gives opposite results. A
  query that names one cell line returns that row first. The other row
  shows as `QUALIFIES` with `differs_on: ['cell_line']`.
- **Supersession:** the user runs the analysis again with pipeline v1.4
  after v1.2. Only the v1.4 row is a primary hit. The v1.2 row shows in
  lineage.
- **Exact ID:** a query by reagent lot or by sample ID returns the row with
  that facet value at position 1.
- **Retraction:** a retracted claim is never a primary hit.
- **Access:** an `irb` evidence row makes its derived claim invisible to a
  caller who does not have the clearance.
- **Pollution guard:** after distiller v2, the result of
  `memory-dup-rate.sh` must not become worse.

## 10. Decisions on the open questions

1. **Caller clearance.** The indexer reads it from `MEMORY_CLEARANCE`, for
   example `alice=irb,bob=restricted`. Users not listed read up to
   `internal`. `hub/users.md` stays a secret file that holds only service
   IDs.
2. **Experience limit.** The limit is 0..3 experiences per session. The zod
   schema also enforces the value bar.
3. **Version source.** `current_versions` comes from the run claims that the
   lab recorded: the highest `pipeline_version` or `protocol_version` on an
   active claim for that pipeline or protocol. This needs no adapter RPC.
   It is deterministic and never comes from model memory.

## 11. Implementation notes (2026-10-17)

The implementation is different from the sections above in these places:

- **Route name.** `GET /memory/context` already existed as the SessionStart
  index. The bundle route is `POST /memory/bundle`.
- **Who uses the LLM.** Distillation runs in the agent of the session, not on
  the server. Thus the server never labels relations. `/memory/distill`
  returns `related` pairs. The agent labels each pair with `memory_link`
  (`POST /memory/link`).
- **Duplicates.** A near-identical claim under the same conditions is not
  written. The server reports it in `duplicates`. Claims do not use
  `memory_merge`, because claims are immutable.
- **Preferences.** A claim with `claim_kind: 'feedback'` is written as an
  ordinary `feedback` row in `user/preferences`, not as a claim.
- **Evidence capture.** The indexer records written files and `sbatch` job
  IDs without a checksum (`sha256` is NULL). The indexer cannot read the
  files in the user containers. The agent cites evidence by URI. A cited
  URI that the indexer captured reuses the captured row and its locator.
- **Validation levels.** An experience becomes `repeated` after two
  successful uses (`memory_feedback`). `VALIDATED_BY` raises the level by
  one. `FAILED_TO_REPLICATE` lowers it by one.
- **Rejecting an edge.** A rejected `SUPERSEDES` or `RETRACTS` edge sets the
  old claim back to `active`, unless another accepted edge holds it.
- **Consolidation.** The server cannot judge a contradiction. It proposes
  `SUPPORTS` only between near-identical claims under the same conditions.
  It reports the other pairs for labeling.
- **Experience → skill.** No new server code. The agent writes the draft
  `SKILL.md`. The user submits it from the share panel.
- **Search for all callers.** `memory_search` also applies the status,
  validity and access filters and the exact-ID arm. The new weights are
  0.55 vector, 0.25 FTS and 0.20 exact.

Files:

- **Migrations:** `hub/indexer/migrations/0019_memory_claims.sql`,
  `0020_memory_edges.sql`, `0021_evidence.sql`, and their `down/` files.
- **Indexer:** `facets.ts`, `claims.ts`, `lineage-repo.ts`,
  `context-bundle.ts`, `consolidate.ts` and `evidence-capture.ts` (all in
  `hub/indexer/src/`). The changed files are `distiller-prompts.ts`,
  `distiller-repo.ts`, `memory-repo.ts`, `memory-api.ts` and
  `experience-promotion.ts`.
- **MCP:** `mcp-memory/src/index.ts` adds `memory_context` and
  `memory_link`, and changes `memory_distill_session` to v2.
- **Agent command:** `hub/skeleton/harness/commands/memory.md`.
- **Tests:** `hub/indexer/test/science.test.ts`, `science-pure.test.ts` and
  `migrations-0021-smoke.test.ts`.

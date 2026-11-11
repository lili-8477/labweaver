# /memory — distill this session into long-term memory

Pin the *current chat* to long-term memory. Auto-distillation is off. This command is the only path that writes distilled claims and experiences. Run it when the user explicitly asks (`/memory`), not preemptively.

## Procedure

1. Review the current conversation. Find what was done, what was observed, under which conditions, and what lesson is safe to reuse. Skip operational noise (file listings, command echoes, retries, transient errors).
2. Build one payload that matches the schema below.
3. Call the MCP tool `memory_distill_session` (server: `bioflow-memory`) **once** with that payload. Each call writes rows.
4. Read the result:
   - `related`: each pair is a new claim and an existing claim under the same conditions with a different statement. Call `memory_link` once per pair with `rel` `SUPPORTS` or `CONTRADICTS` (src = the new claim).
   - `similar`: each entry is an experience or preference held back as a near-duplicate. Call `memory_merge` on its best match with a body that keeps the facts of both.
   - `superseded` and `qualified` need no action. The server wrote those edges.
5. Report in one line: the run claim id, the number of claims and experiences written, and the number of links and merges you made.

## Payload schema

```json
{
  "run": {
    "subject":    "<≤120c — what was studied, e.g. 'PBMC3k clustering'>",
    "statement":  "<≤800c — what was done and found, with key numbers>",
    "conditions": { "dataset": ["pbmc3k"], "pipeline": ["scanpy-qc"], "pipeline_version": ["v1.4"] },
    "inputs":     ["<input files or datasets>"],
    "parameters": { "resolution": 0.8 },
    "outputs":    ["<output files>"],
    "qc":         { "status": "pass | warn | fail | unknown", "metrics": { "n_cells": 2638 } },
    "evidence":   [{ "uri": "file:///workspace/pbmc3k/results/umap.png", "role": "output" }],
    "observed_at": "<ISO-8601, only if not now>"
  },
  "claims": [
    {
      "claim_kind": "observation | result | interpretation | decision | feedback",
      "subject":    "<≤120c>",
      "statement":  "<≤800c>",
      "conditions": { "cell_line": ["a549"], "assay": ["western blot"] },
      "confidence": 0.8,
      "evidence":   [{ "uri": "chpc://job/123456" }]
    }
  ],
  "experiences": [
    {
      "task":                "<≤200c — the kind of task this lesson helps with>",
      "solution":            "<≤1200c — what to do>",
      "applicability":       ["<when it applies>"],
      "boundary_conditions": ["<where it stops applying>"],
      "failure_modes":       ["<how it goes wrong>"],
      "expected_qc":         { "pct_mito_max": 5 },
      "source":              "run",
      "domain":              "lab | technical"
    }
  ]
}
```

- `run` is required: exactly one per session.
- `claims`: 0..5. Use `feedback` for something the user said about how they want the agent to work.
- `experiences`: 0..3. Each must name one or more `applicability` items and one or more boundary conditions or failure modes. `source` is `"run"` or the index of the claim it comes from. If a lesson cannot meet this bar, leave it out.
- `domain`: required on each experience; claims and the run default to `"lab"`. Use `"lab"` for science a researcher would want to read (samples, protocols, QC thresholds, analysis choices, findings) and `"technical"` for software know-how only you need (packages, environment, tool errors, notebook mechanics). The user is a life scientist and sees only lab memories; set `"technical"` on a claim or run only when the session was purely about making software work.

## Rules

- **Conditions.** Put every condition you know in `conditions`. Keys: `species`, `model`, `cell_line`, `tissue`, `sample`, `cohort`, `assay`, `protocol`, `protocol_version`, `reagent_lot`, `instrument`, `run_id`, `dose`, `timepoint`, `dataset`, `dataset_version`, `reference`, `pipeline`, `pipeline_version`, `code_version`, `gene`, `tool`, `file`. Conditions decide whether a new result supersedes an old one or only qualifies it. A missing condition makes that decision weaker.
- **Evidence.** Cite only URIs you saw in this session: absolute file paths as `file:///…`, CHPC jobs as `chpc://job/<id>`, links as `https://…`. Never invent a URI. Mark controlled data with `"access_class": "restricted"` or `"irb"`.
- **Claims are immutable.** Do not try to edit an old claim. Write the new claim. A re-run under the same conditions with a newer version supersedes the old claim automatically.
- **Experience → skill.** Memory never changes a skill. If the user wants a reviewed experience to become a skill, write the draft `SKILL.md` under `~/.claude/skills/<name>/`, cite the experience id in it, and ask the user to submit it from the share panel for manager review.
- Do not write any other memory rows in this turn (no `memory_write` to "supplement").

## Optional fields

- `project_dir`: set it if the session was scoped to one project (encoded form, e.g. `-home-li86-myproj`). Omit it for a user-scope distill.
- `source_session_id`: omit it. The agent does not reliably know its own session UUID.

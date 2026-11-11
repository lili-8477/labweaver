---
name: tick-bootstrap
description: One-shot project scaffolder. Reads a free-form task instruction, picks a slug + matching starter pipeline, creates local_projects/<slug>/{data,results,scripts,pipelines}/, copies the pipeline template, and writes progress.md with empty Plan. Read-only on starter pipelines; write-only inside the new project dir.
---

# bootstrap

This is the bootstrap step of the bioinformatics tick harness. It runs **once** at the very start of a new task, before any planning or execution. You translate the user's free-form instruction into a project skeleton the rest of the harness can drive.

## Inputs

The work item is the user's task message. Treat it as authoritative — extract sample IDs, pipeline intent, and a project name from it.

## Procedure

1. **Pick a project slug** from the instruction. Rules:
   - Lowercase, kebab-case, ASCII only.
   - 1–4 words. Prefer the dataset accession (e.g. `gse12345`) plus one tissue/topic word (`pbmc`, `tumor`).
   - If the instruction says "project: <name>" or "name: <name>" verbatim, use that name (still slugified).
   - Avoid generic names (`analysis`, `task`, `project`, `test`).
   - If a directory `local_projects/<slug>/` already exists, append `-2`, `-3`, … until unused.

2. **Pick the matching starter pipeline.** Available templates live in `/workspace/local_projects/_starter_pipelines/`:
   - `single-cell-standard.md` — keywords: `single-cell`, `scrna`, `sc-rna`, `clustering`, `umap`, `leiden`, `celltype annotation`, `10x`.
   - `differential-expression-pseudobulk.md` — keywords: `differential expression`, `DE`, `pseudobulk`, `deseq2`, `condition vs`, `treated vs control`.
   - If the instruction asks for **both** clustering and DE, pick `single-cell-standard` (DE comes after the cells are annotated; the user can copy the DE pipeline in later).
   - If neither fits, or the directory does not exist, use pipeline `custom` and copy nothing: the planner writes the plan from the task.

3. **Extract sample IDs** from the instruction:
   - GEO accessions (`GSE\d+`, `GSM\d+`).
   - Generic IDs in quotes or after "sample:" / "samples:".
   - If none found, write a single line `TBD — fill in before /tick advances`.

4. **Create the project skeleton** at `/workspace/local_projects/<slug>/`:
   ```
   <slug>/
     data/
     results/
     scripts/
     pipelines/<pipeline>.md   # cp from _starter_pipelines/
     progress.md
   ```
   Use `mkdir -p` and `cp`. Do **not** create any other files.

   Then record the project for the harness: write the absolute project path as the only line of the **Project file** named in your instructions, e.g. `printf '%s\n' /workspace/local_projects/<slug> > <project file>`. Every later tick reads it.

5. **Write `progress.md`** with this exact structure (Plan stays empty — the planner fills it next tick):
   ```
   ## Pipeline
   <pipeline-name>

   ## Sample(s)
   <sample-id-1>
   <sample-id-2>

   ## Inputs
   (none yet — add file paths under data/<sample>/ before next /tick if you have local files)

   ## Plan

   ## Review feedback

   ## Notes
   <verbatim copy of the user's instruction>
   ```
   `<pipeline-name>` is the slug of the chosen template (`single-cell-standard`, not `single-cell-standard.md`).

6. **Return** one sentence:
   ```
   bootstrap: created <slug> with pipeline <pipeline-name>
   ```

## Hard rules

- **Write only inside `/workspace/local_projects/<slug>/`**, plus the Project file (step 4). Do not modify anything else (not other projects, not the starter templates).
- **Read-only on `_starter_pipelines/`.**
- Do not invoke the planner or executor. Do not fill in `## Plan`. That's the planner's job on the next tick.
- Do not run any analysis, install packages, or download data. You only scaffold.
- All ISO dates: `date -u +%Y-%m-%d`.
- If the instruction is too vague to extract a meaningful slug or pipeline (e.g. "do a thing"), still scaffold — use slug `untitled` and pipeline `custom`, and append `☐ <ISO-date> bootstrap: instruction too vague; user must clarify the task` under `## Review feedback`.

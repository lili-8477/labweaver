---
name: tick-planner
description: One-shot planner — instantiates a pipeline template into progress.md by copying ## Plan and ## Gates, validating inputs, and recording defaults. Read-only on pipelines/, write-only on progress.md. Never executes pipeline work.
---

# planner

This is the planner step of the bioinformatics tick harness. It runs **once** per project to instantiate a pipeline template into `progress.md`. After that, the plan is immutable from your pen — modifications go through `## Review feedback`.

## Procedure

1. **Read `progress.md`** from the project directory. Extract:
   - `## Pipeline` — the pipeline name (e.g. `single-cell-standard`).
   - `## Sample(s)` — sample ids and any per-sample metadata.
   - `## Inputs` — input file/directory paths.

2. **Validate inputs**. For each path in `## Inputs`, check existence with Read or `ls` via Bash. If any input is missing, append a single line to `## Review feedback`:
   ```
   ☐ <ISO-date> planner: missing input <name>: <details>
   ```
   Then return `planner: missing inputs; see review feedback` and stop. Do NOT instantiate the plan.

3. **Locate the pipeline template**:
   - First try `pipelines/<pipeline>.md` (relative to the project directory).
   - If missing, fall back to `/workspace/local_projects/_starter_pipelines/<pipeline>.md`.
   - If the pipeline is `custom` or neither file exists, there is no template: write `## Plan` and `## Gates` yourself from the task in `## Notes`, in the same format (2-8 `☐ <step-id> <what it produces>` lines; one checkable gate per step), and record `(no pipeline template; plan written from the task)` under `## Decisions`. Then continue at step 6.

4. **Copy `## Plan` and `## Gates` verbatim** from the template into `progress.md`. Replace placeholders (`<sample-id>`, `<celltype>`, etc.) with concrete values from `## Sample(s)`. Preserve checkbox state (`☐`).

5. **Append a `## Decisions` section** documenting any non-default parameter choice. If the user's `progress.md` already specifies an override (e.g. `n_top_genes=3000` instead of the template default of 2000), record it here. If none, write:
   ```
   ## Decisions
   (defaults from pipeline template)
   ```

6. **Set `## Current state`** to:
   ```
   ## Current state
   last_completed: none
   next_action: <first step_id from the plan>
   artifacts:
   ```

7. **Return** one sentence: `planner: instantiated <pipeline>; next_action=<step_id>`.

## Hard rules

- **Read-only on `pipelines/`** and `/workspace/local_projects/_starter_pipelines/`.
- **Write-only on `progress.md`** — no other files.
- Do NOT execute any pipeline work. No scripts, no analyses, no data movement.
- Do NOT touch `## Plan` after the first instantiation. If the template is wrong or steps need adjustment, the reviewer or user must edit it; the planner only runs once.
- All ISO dates use `date -u +%Y-%m-%d`.

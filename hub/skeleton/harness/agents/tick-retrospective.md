---
name: tick-retrospective
description: Runs once when every plan step is reviewed. Turns the project's review trajectories into a few reusable experiences in the user's personal memory, then marks the retrospective done in progress.md.
---

# retrospective

You turn what this project's reviews taught into **reusable experience**: practices that would make the *next* similar project go better. You run once, at the end.

## Procedure

1. Read `progress.md` in the project directory (plan, gates, decisions, review feedback history).
2. Call `memory_dir` (server `bioflow-memory`) with `dir: "project/trajectories"` and `project_dir` = the absolute project directory with every `/` replaced by `-`. Read any entries you need with `memory_get`. Rejected-then-approved steps are the richest source.
3. Write **0–3** experiences with `memory_write`:
   - `scope: "user"`, `dir: "user/experience"`, `type: "project"`
   - `domain`: `"lab"` when the practice is about the science (samples, protocols, QC thresholds, analysis choices); `"technical"` when it is about making the code or tools work. The user, a life scientist, sees only lab experiences.
   - `name`: the practice as an imperative (≤80c), e.g. "Filter cells by mt% before doublet detection"
   - `description`: when it applies, one line
   - `body`: the practice, why (the evidence from this project, with numbers), and when it does not apply.
   Only practices that transfer to other projects. Skip project-specific facts (sample ids, paths) and anything already obvious.
4. If `memory_write` returns `similar`, the experience already exists: call `memory_merge` on the best match, folding in this project's evidence without dropping what was there. Each confirmation strengthens it; experiences used successfully in 3 tasks are proposed to the lab automatically.
5. Append `## Retrospective: done (<n> experiences)` to `progress.md`.

If the memory tools are unavailable, skip steps 2–4 and still do step 5: the retrospective never blocks completion.

Return: `retrospective: <n> experiences written, <m> merged`.

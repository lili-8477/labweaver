# Two-arm experiment: does accumulated lab knowledge change scRNA-seq analysis quality?

Date: 2026-08-28
Status: design approved, pending spec review

## Question

Given the same raw FASTQs and the same task prompt, does a LabWeaver
container carrying curated lab skills and memory produce a materially
better synovial-sarcoma scRNA-seq analysis than an otherwise identical
container with no domain knowledge?

Dataset: `A8163_mSS`, mouse synovial sarcoma model, on CHPC under
`jonesk-group2/agent-omics/singlecellrnaseq/A8163_mSS/Fastq`.

## Arms

| | Arm A — treatment | Arm B — control |
|---|---|---|
| Container | `claude-bioflow-li86` | `claude-bioflow-control` |
| Domain skills | all 41, incl. `hci-scrnaseq`, `ss-mouse-celltype`, `single-cell` | none; `chpc-bridge` only |
| Shared tree readable | `/workspace/shared/{skills,projects,reference}` | not mounted |
| `/workspace/CLAUDE.md` | lab context, `@`-imports `shared.md` | absent (host path is an empty dir) |
| `bioflow-memory` MCP | `USERNAME=li86`, populated | `USERNAME=control`, empty |
| Model | `claude-opus-4-8` | `claude-opus-4-8` (raised from `claude-sonnet-4-6`) |

The treatment is **skills + memory + workspace context together**, not
skills in isolation. That bundle is what LabWeaver actually claims, so
the experiment tests the claim as stated. The writeup must say so
rather than imply a single-variable manipulation.

## Environment changes

All changes are container-local or per-user. Nothing under
`hub/workspaces/shared/` is touched — that tree is bind-mounted into
li86, control and test1-3 alike, so editing it would contaminate arm A
and every other user.

### C1 — Isolate the control container

Superseded approach: symlink tombstones in `~/.claude/skills`. Rejected
because it only hides skills from auto-discovery. The control container
also bind-mounts the shared tree at `/workspace/shared/skills`, where
`ss-mouse-celltype/SKILL.md` — the full 278-line A8163 taxonomy — is
readable with one `cat`. Hiding the skill while leaving its text in the
file explorer is not a control.

Instead, recreate `claude-bioflow-control` with the four shared mounts
removed:

```
${SHARED_DIR}/skills    -> /home/node/.claude/skills-shared   DROP
${SHARED_DIR}/skills    -> /workspace/shared/skills           DROP
${SHARED_DIR}/projects  -> /workspace/shared/projects         DROP
${SHARED_DIR}/reference -> /workspace/shared/reference        DROP
${SHARED_DIR}/CLAUDE.md -> /workspace/.bioflow/shared.md      DROP
```

With no `skills-shared` tree to walk, `stitch_skills`
(`image/entrypoint.sh:43`) links nothing, so the control's skill set
becomes exactly its per-user `skills-user` directory — which is empty.
No tombstones, no exclusion logic, durable across restarts by
construction.

`chpc-bridge` is preserved by copying it from the shared tree into
`hub/workspaces/control/.claude/skills/chpc-bridge/`, which mounts as
`skills-user`. It is the one capability the control keeps: SSH
multiplexing and `sbatch` mechanics are infrastructure, not biology.
Without it the control fails on plumbing, which answers a different
question than the one being asked.

This requires a small, opt-in change to `hub/scripts/recreate-user.sh`
— a `SHARED_MOUNTS=0` guard that collects the five shared `-v` flags
into an array and omits them. Duplicating the 30-line `docker run` into
a one-off experiment script was the alternative; the guard is smaller
and does not drift. Default behaviour is unchanged, so li86 and
test1-3 are unaffected.

Retained per-user mounts: `local_projects`, `.claude`, `.env`,
`.mcp.json`, `.ssh`, `.latch`. The `.ssh` mount is what C3 needs.

### C2 — Equalize the model

Set `model` to `claude-opus-4-8` in
`hub/workspaces/control/.claude/settings.json`. Arm A is left alone.

Matching upward rather than downward means the control is a top-tier
native model, so a null-hypothesis reviewer cannot attribute arm A's
advantage to raw capability.

### C3 — Give the control CHPC access

`hub/workspaces/control/.ssh/config` is entirely commented out. Write
the `chpc-login` stanza: `notchpeak.chpc.utah.edu`, user `u6025146`,
`ControlMaster auto`, `ControlPath ~/.ssh/cm-%r@%h:%p`,
`ControlPersist 8h`.

The Duo-authenticated master must then be opened by the user, once per
container, because Duo needs a TTY:

```
docker exec -it claude-bioflow-li86    ssh -MNf chpc-login
docker exec -it claude-bioflow-control ssh -MNf chpc-login
```

### C4 — Quarantine prior work in arm A

li86 holds prior analyses of this same dataset:
`local_projects/{A8163_mSS, A8608_mSS, mSS_SCRNAseq, srt-for-monocle3-7bda}`.
The last is a 778M Seurat object whose `cell_type` column already
contains the answer.

Move all four to `hub/workspaces/li86/_quarantine_ab/` for the duration
and restore afterwards. Curated skills and memory are the treatment;
a pre-annotated object on disk is answer leakage that would let arm A
copy a result instead of deriving one.

### C5 — Stage clean FASTQs on CHPC, and the limit of that

The FASTQ directory's sibling `../scripts/cellranger_rerun_fixed.slurm`
is a working submission that names the GRCm39 + `SSX2_SSX18` transgene
reference. Either arm can browse to it, and if both do, the strongest
discriminator in the experiment — whether the agent knows to avoid the
human/mouse barnyard reference — disappears.

Stage `/uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/singlecellrnaseq/A8163_mSS_ab_input/Fastq`
on CHPC containing only hard links to the FASTQ files, and point both
arms there. Hard links rather than symlinks: a symlink's target reveals
the original project path under `ls -l`. The real project tree,
including the scripts and prior outputs, is left untouched.

**Honest limit.** Container-side isolation (C1) is enforceable. CHPC-side
isolation is not: both arms authenticate as the same account
`u6025146`, so either can `ls` its way to the original `A8163_mSS`
tree. Nothing short of a second CHPC account changes that. The staging
directory removes the *invitation*, not the *capability*.

The experiment therefore treats this as something to verify rather than
assume. Each arm's `.audit.log` records every Bash call; after the runs,
grep both for paths outside the staged directory. If an arm wandered
into the original project tree, that is reported in the writeup, not
quietly dropped — an arm that read the answer key has its
reference-choice score voided rather than counted.

This is the one change with a judgement call attached: it makes the
task harder for both arms than a realistic session would be, in
exchange for keeping the measurement meaningful.

## Task prompt

Pasted verbatim into both containers' chat in the LabWeaver UI. Wording
is fixed before either run starts and is not adjusted between arms.

> Analyze the single-cell RNA-seq dataset A8163_mSS, a mouse synovial
> sarcoma model. Raw FASTQ files are on CHPC at `/uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/singlecellrnaseq/A8163_mSS_ab_input/Fastq`.
>
> Compute runs on CHPC — reach it over SSH and submit heavy work through
> SLURM. Do not process the data inside this container.
>
> Take it from FASTQ to annotated cell types:
> 1. Alignment and counting from the FASTQ files.
> 2. Quality control and doublet handling.
> 3. Normalization, dimensionality reduction, clustering, UMAP.
> 4. Assign a biological cell type to every cluster, and give the marker
>    evidence behind each call.
> 5. Report anything notable about what this tumor expresses.
>
> Work in `/workspace/local_projects/A8163_mSS_ab/`. Leave your scripts,
> SLURM submissions, figures and a written summary there so the analysis
> can be reproduced.

Deliberate properties:

- Step 5 invites the fusion-transgene finding without naming SS18-SSX2,
  the transgene reference, or `cellranger mkref`.
- Step 4 asks for cell types without supplying any taxonomy vocabulary.
- The CHPC/SLURM sentence is required for symmetry: li86's `CLAUDE.md`
  asserts *"Compute backend: local container … No SLURM"*, which would
  otherwise handicap arm A for a reason unrelated to the hypothesis.

## Capture

Per arm, copy into `docs/experiments/2026-08-28-scrnaseq-ab/arm-{a,b}/`:

- the session transcript from `hub/workspaces/<ws>/.claude/claude-projects/`
- `.audit.log` (every tool call) and `.jobs.log` (sbatch submissions)
- the arm's whole `local_projects/A8163_mSS_ab/` tree
- wall-clock start and end, recorded by the operator

## Scoring

| Dimension | What separates the arms |
|---|---|
| Reference genome | GRCm39 + fusion transgene vs. GRCh38+mm10 barnyard or a generic mouse reference |
| Fusion detection | `SSX2_SSX18` reported, vs. absent or reported as zero counts |
| Cell-type granularity | SS tumor states (corded/epithelial, monophasic, PD, fibro-like) vs. generic "tumor cells" |
| Microenvironment | TAM / endothelial / fibroblast / NK-T / mast / neutrophil resolution |
| QC parameters | thresholds chosen and whether they are justified |
| Cost | turns and wall-clock to first count matrix, and to final annotation |
| Reproducibility | scripts, submission files and a written summary left behind |

Scoring is done against the lab's established A8163 taxonomy
(11 clusters, 42,141 cells) as ground truth, read from
`ss-mouse-celltype` — by the operator, after both arms finish.

## Non-goals

- No 2x2 model factorial. One model, both arms.
- No change to `hub/workspaces/shared/`, and no change to arm A's
  skills, settings or context beyond the C4 quarantine.
- No change to `image/entrypoint.sh`. The only product-code change is
  the opt-in `SHARED_MOUNTS=0` guard in `hub/scripts/recreate-user.sh`,
  which is inert unless explicitly set.

## Reversal

1. `SHARED_MOUNTS=1 hub/scripts/recreate-user.sh control` to restore the
   shared mounts, then remove the copied `chpc-bridge` from the
   control's `skills-user`.
2. Restore `model: claude-sonnet-4-6` in control's `settings.json`.
3. Re-comment control's `~/.ssh/config` stanza.
4. Move `_quarantine_ab/` contents back into li86's `local_projects/`.
5. Remove the staged FASTQ hard-link directory on CHPC.

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

### C1 — Remove the control's domain skills

`image/entrypoint.sh:27` (`stitch_skills`) rebuilds `~/.claude/skills`
on every container start by symlinking everything from the shared
mount. Deleting a symlink is therefore undone by a restart.

Instead, replace each of these symlinks with an empty directory of the
same name inside the control container:

```
chip-seq  differential-expression  pathway-analysis
single-cell  spatial-transcriptomics  ss-mouse-celltype
```

`chpc-bridge` stays: SSH multiplexing and `sbatch` mechanics are
infrastructure, not biology. Without it the control would fail on
plumbing, which answers a different question than the one being asked.

Tombstones survive restarts by construction — `stitch_skills` deletes
only `-type l` entries (`entrypoint.sh:29`) and skips any name that
already exists (`entrypoint.sh:48`). Reverse with `rm -rf` on the six
directories.

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

### C5 — Stage clean FASTQs on CHPC

The FASTQ directory's sibling `../scripts/cellranger_rerun_fixed.slurm`
is a working submission that names the GRCm39 + `SSX2_SSX18` transgene
reference. Either arm can browse to it, and if both do, the strongest
discriminator in the experiment — whether the agent knows to avoid the
human/mouse barnyard reference — disappears.

Stage `/uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/singlecellrnaseq/A8163_mSS_ab_input/Fastq` on CHPC containing only symlinks to the FASTQ files,
and point both arms there. The real project tree, including the
scripts, is left untouched.

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
- No product code change; `entrypoint.sh` gains no exclusion mechanism.

## Reversal

1. `rm -rf` the six tombstone directories in the control container.
2. Restore `model: claude-sonnet-4-6` in control's `settings.json`.
3. Re-comment control's `~/.ssh/config` stanza.
4. Move `_quarantine_ab/` contents back into li86's `local_projects/`.
5. Remove the staged FASTQ symlink directory on CHPC.

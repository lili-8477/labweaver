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
| Domain skills | all 40, incl. `hci-scrnaseq`, `ss-mouse-celltype`, `single-cell` | none; `chpc-bridge` only |
| Shared tree readable | `/workspace/shared/{skills,projects,reference}` | not mounted |
| `/workspace/CLAUDE.md` | lab context, `@`-imports `shared.md` | absent (host path is an empty dir) |
| `bioflow-memory` MCP | `USERNAME=li86`, populated | not mounted; `MEMORY_ENABLED=0` |
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

Instead, recreate `claude-bioflow-control` with the five shared mounts
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

The rebuild runs through a new `hub/scripts/recreate-control.sh`, not
through `hub/scripts/recreate-user.sh`.

`hub/users.md` documents that this baseline was already invalidated
once — on 2026-08-10 someone ran `recreate-user.sh control` during a
GPU recovery, which applied the standard mount set and restored
everything the baseline exists to exclude. That file carries a standing
instruction: *"Never run `recreate-user.sh` or `add-user.sh` against
`control`."* An opt-in `SHARED_MOUNTS=0` flag on that script was the
first design; it is rejected because it is still the forbidden script,
one forgotten flag away from silently breaking the baseline a second
time. A dedicated script encodes the mount set as code.

`ID_HASH` derives deterministically from the container name
(`recreate-user.sh:152`), so the control keeps service ID
`1095be4c…` and its nginx `lw_service` route across the rebuild.

Mount set, following the baseline documented in `hub/users.md`:

| Mounted | Why |
|---|---|
| `local_projects` | the arm's working tree |
| `.env` | OAuth token, shared with li86 |
| `.claude/settings.json` | model and hooks |
| `.claude/claude-projects` | transcripts, needed for capture |
| `.claude/hooks` | writes `.audit.log`, the leakage instrumentation; li86 runs the identical set |
| `.claude/skills` | experiment addition — holds only `chpc-bridge` |
| `.ssh` | experiment addition — C3 needs it |

Omitted: all four shared mounts, the shared `CLAUDE.md`, `.mcp.json`,
`agents`, `commands`, `.latch`, and `MEMORY_ENABLED=1` /
`MEMORY_API_URL` / `SIDECAR_IMPORT_ON_BOOT`. `hub/users.md` specifies
the baseline has no MCP servers, so `.mcp.json` is deleted from the
workspace as well as unmounted — the control gets no memory tool.

`.ssh` and `.claude/skills` are deliberate deviations from the pure
baseline, required because the arm must reach CHPC. Both are recorded
in the script's header comment.

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

Stage `/uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/ab_input_2026-08-28/Fastq`
on CHPC containing only hard links to the FASTQ files, and point both
arms there. Hard links rather than symlinks: a symlink's target reveals
the original project path under `ls -l`.

**Amended 2026-08-28 after inspecting the tree.** What sits beside the
FASTQs is not a hint, it is the finished analysis: `srt_A8163_fixed.Robj`
(976M), `srt_for_monocle3.Robj` (778M, carrying the `cell_type` column),
`markers_all.csv`, `markers_top10.csv`, `mSS_SC_CellType.Rmd`, and the
`cellranger/`, `cellranger_fixed/` and `scripts/` directories — 23 entries
in all. Staging a sibling directory would have left every one of them a
single `ls ..` away.

Two changes, both approved by the user:

1. **Relocate the worked solution.** All 23 non-`Fastq` entries move to
   `A8163_mSS_locked/` for the duration, leaving `A8163_mSS/` holding only
   `Fastq/`. A `mv` within one filesystem — instant, nothing deleted or
   copied, reversed by
   `docs/experiments/2026-08-28-scrnaseq-ab/chpc-restore.sh`, which was
   written *before* the move.
2. **Stage outside the dataset tree.** The clean input lives at
   `agent-omics/ab_input_2026-08-28/Fastq/`, not as a sibling of the
   original. Its parent lists only `Fastq`, so no breadcrumb points back.

The FASTQs are in per-sample subdirectories (`21416X1`…`21416X5`, four
files each — I1, I2, R1, R2 — 20 files, 134G), so the staging preserves
that layout with hard links rather than flattening it.

**Honest limit, still.** Container-side isolation (C1) is enforceable.
CHPC-side isolation is not: both arms authenticate as the same account
`u6025146`, and the task prompt names the dataset, so a determined search
can still reach `A8163_mSS_locked/`. Relocation removes the accident;
only a second CHPC account would remove the capability. The audit-log
check below therefore stays, as verification rather than as the primary
defence.

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
> sarcoma model. Raw FASTQ files are on CHPC at `/uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/ab_input_2026-08-28/Fastq`.
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
- No change to `image/entrypoint.sh` or `hub/scripts/recreate-user.sh`.
  The only new product code is `hub/scripts/recreate-control.sh`, which
  no other user's workflow touches.

## Reversal

1. Nothing. The baseline mount set is the control's correct steady
   state; `hub/users.md` forbids recreating it with the standard script.
   Optionally re-comment its SSH stanza and drop the `chpc-bridge` copy
   if a CHPC-free baseline is wanted.
2. Restore `model: claude-sonnet-4-6` in control's `settings.json`.
3. Re-comment control's `~/.ssh/config` stanza.
4. Move `_quarantine_ab/` contents back into li86's `local_projects/`.
5. Run `docs/experiments/2026-08-28-scrnaseq-ab/chpc-restore.sh` — it moves
   all 23 entries back from `A8163_mSS_locked/` into `A8163_mSS/` and removes
   the staged hard-link directory. Hard links mean removing the staged entries
   cannot touch the originals.

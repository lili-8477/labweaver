## Quarantine — 2026-08-28T11:55:45-06:00

Moved out of li86/local_projects for the duration of the run:
- A8163_mSS
- A8608_mSS
- ihc-demo__mSS_SCRNAseq
- mSS_SCRNAseq
- srt-for-monocle3-7bda

Extra hit found by the Step 4 grep, not among the four originally named directories:
- ihc-demo/mSS_SCRNAseq/ (moved into quarantine as ihc-demo__mSS_SCRNAseq) — a scaffold-only progress.md nested inside the unrelated ihc-demo (QuPath IHC demo) project. No results/derived data present, but it named the exact A8163_mSS CHPC FASTQ path, the mSS-specific reference-genome/transgene flags, and the project name "mSS_SCRNAseq" — i.e. it points at the quarantined dataset/object, so it was quarantined too rather than left as a partial answer key.

## CHPC relocation and clean-input staging — 2026-08-28T12:09:00-06:00

Base dataset: `$D = /uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/singlecellrnaseq/A8163_mSS`

1. **Ground truth captured locally** (before any move) into `.superpowers/sdd/2026-08-28-scrnaseq-ab-experiment/ground-truth/` (not committed, not mounted into either container):
   - `scripts/cellranger_rerun_fixed.slurm`
   - `markers_top10.csv`
   - `mSS_SC_CellType.Rmd`
   Ground-truth Cell Ranger reference (`--transcriptome=`, via `$INDEX`):
   `INDEX=/uufs/chpc.utah.edu/common/home/u6025146/software/genome_ref_data/10X/GRCm39-2024-A_SS18-SSX2-IRES-EGFP_EWSR1-ATF1`

2. **Worked solution moved aside**: every entry of `$D` except `Fastq/` was `mv`-ed into `${D}_locked/` (same filesystem, `oak-vg1-0-lv1` — instant, reversible). 23 entries moved (`cellranger`, `cellranger_fixed`, `check_obj.R`, `check_obj.slurm`, `find_markers.R`, `find_markers.log`, `find_markers.slurm`, `install_seurat.slurm`, `logs`, `mSS_SC_CellType.Rmd`, `markers_all.csv`, `markers_top10.csv`, `move_fastq_21416R.slurm`, `scanpy`, `scripts`, `skill_demo`, `skill_demo_figs.R`, `skill_demo_figs.slurm`, `skill_demo_fixed`, `srt_A8163_fixed.Robj`, `srt_for_monocle3.Robj`, `umap_origin.slurm`, `umap_sample_origin.R`). Verified: `$D` now contains only `Fastq`; `${D}_locked` contains all 23.

3. **Clean input staged** at `/uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/ab_input_2026-08-28/Fastq/`, recreating the 5 per-sample subdirectories (`21416X1`…`21416X5`) with the 20 `.fastq.gz` files (134G) plus the md5 manifest **hard-linked** (not copied, not symlinked) from `$D/Fastq/`. Verified: 20 files, all link count 2, no `->` symlink arrows, staged parent contains only `Fastq`.

4. **Task prompt updated**: `docs/experiments/2026-08-28-scrnaseq-ab/task-prompt.txt` path line repointed from the old `.../A8163_mSS_ab_input/Fastq` to the new `.../ab_input_2026-08-28/Fastq`. No other text changed. Leak-check grep re-run: still returns 0.

5. **Restore script** written at `docs/experiments/2026-08-28-scrnaseq-ab/chpc-restore.sh` — moves `${D}_locked/*` back into `$D`, then removes the staged hard-link input tree. Idempotent, never overwrites, never deletes source data (only unlinks the hard-link copies in the staged tree; the originals under `$D/Fastq` are untouched). `bash -n` passes.

# Scoring — A8163_mSS, arm A (li86, skills) vs arm B (control, none)

Ground truth is the lab's established A8163 taxonomy: 11 clusters,
42,141 cells, 32,286 genes. Held in `ss-mouse-celltype` (arm A's skill,
and the scorer's reference — never shown to arm B).

Scored by the operator after both arms finish. Fill both columns before
comparing, to avoid scoring the second arm against the first.

## Reference genome — what counts as correct

Fixed before any result existed, so it cannot be bent afterwards.

The lab's own prior run (`scripts/cellranger_rerun_fixed.slurm`, captured to
`.superpowers/sdd/2026-08-28-scrnaseq-ab-experiment/ground-truth/` before the
tree was locked) used:

```
--transcriptome=/uufs/.../genome_ref_data/10X/GRCm39-2024-A_SS18-SSX2-IRES-EGFP_EWSR1-ATF1
```

Arm A's `hci-scrnaseq` skill names a *different* path,
`GRCm39-2024-A_SSX2_SSX18_EWSR1_ATF1`. Both exist on CHPC and both are mouse
GRCm39 + fusion-transgene builds.

**The measured decision is mouse+transgene vs. barnyard, not which transgene
build.** Score either as correct:

- **Correct** — any `GRCm39*` reference carrying a fusion transgene.
- **Incorrect** — `GRCh38-and-mm10` / `GRCh38_and_GRCm39` barnyard, or a plain
  mouse reference with no transgene. Both lose the fusion signal: against the
  barnyard the transgene's human sequence multi-maps to the real human loci
  and the reads are discarded.

Do not penalise arm A for using its skill's build rather than the lab's, and
do not credit an arm for naming a transgene it never actually aligned against.

| Dimension | Arm A | Arm B | Notes |
|---|---|---|---|
| Reference genome used | | | see the rule above — mouse GRCm39 + any fusion transgene is correct; barnyard or plain mouse is not |
| Fusion transgene reported | | | y/n, with non-zero counts. Gene symbol depends on the build chosen (`SSX2_SSX18`, or the `SS18-SSX2-IRES-EGFP` construct) — accept either |
| Clusters found | | | ground truth 11 |
| SS tumor states named | | | corded/epithelial, monophasic, PD, fibro-like, stem — vs. an undifferentiated "tumor cells" |
| Microenvironment resolved | | | TAM, endothelial, fibroblast, NK/T, mast, neutrophil |
| Marker evidence given | | | per-cluster markers with a test named, vs. assertion |
| QC thresholds | | | values chosen and whether justified |
| Doublet handling | | | method named |
| Turns to first count matrix | | | |
| Wall-clock to final annotation | | | |
| Reproducibility artifacts | | | scripts + SLURM files + written summary present |
| Off-path CHPC reads | | | from `offpath-uufs.txt`; a hit on `A8163_mSS_locked/` voids that arm's reference-choice and annotation scores |

## Confound disclosure

The treatment is skills **plus** the `bioflow-memory` store **plus** the
workspace `CLAUDE.md`, not skills alone. Arm B has none of the three.
State this in any writeup; do not describe the result as isolating the
effect of skills.

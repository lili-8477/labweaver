# Scoring — A8163_mSS, arm A (li86, skills) vs arm B (control, none)

Ground truth is the lab's established A8163 taxonomy: 11 clusters,
42,141 cells, 32,286 genes. Held in `ss-mouse-celltype` (arm A's skill,
and the scorer's reference — never shown to arm B).

Scored by the operator after both arms finish. Fill both columns before
comparing, to avoid scoring the second arm against the first.

| Dimension | Arm A | Arm B | Notes |
|---|---|---|---|
| Reference genome used | | | GRCm39 + `SSX2_SSX18` transgene is correct; GRCh38+mm10 barnyard loses the transgene signal |
| `SSX2_SSX18` reported | | | y/n, and whether counts were non-zero |
| Clusters found | | | ground truth 11 |
| SS tumor states named | | | corded/epithelial, monophasic, PD, fibro-like, stem — vs. an undifferentiated "tumor cells" |
| Microenvironment resolved | | | TAM, endothelial, fibroblast, NK/T, mast, neutrophil |
| Marker evidence given | | | per-cluster markers with a test named, vs. assertion |
| QC thresholds | | | values chosen and whether justified |
| Doublet handling | | | method named |
| Turns to first count matrix | | | |
| Wall-clock to final annotation | | | |
| Reproducibility artifacts | | | scripts + SLURM files + written summary present |
| Off-path CHPC reads | | | from `offpath-uufs.txt`; a hit on the original `A8163_mSS` tree voids that arm's reference-choice score |

## Confound disclosure

The treatment is skills **plus** the `bioflow-memory` store **plus** the
workspace `CLAUDE.md`, not skills alone. Arm B has none of the three.
State this in any writeup; do not describe the result as isolating the
effect of skills.

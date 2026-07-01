---
name: ss-mouse-celltype
description: Cell type annotation for synovial sarcoma (SS) mouse model single-cell RNA-seq data. Use when annotating clusters from mSS or SS mouse model scRNA-seq datasets. Encodes the validated taxonomy from the A8163 mSS cohort (A8163_mSS) combining pathology slide morphology and FindAllMarkers gene evidence (Wilcoxon, min.pct=0.25, logfc.threshold=0.25).
---

# Synovial Sarcoma Mouse Model — Cell Type Annotation Skill

## Overview

Validated taxonomy for **mouse synovial sarcoma (mSS) scRNA-seq** datasets. Established for the A8163 dataset by combining H&E pathology slide morphology with single-cell gene marker evidence. Markers below are empirical (FindAllMarkers, Wilcoxon test on 42,141 cells / 32,286 genes).

**Object facts (A8163):** 42,141 cells · 32,286 genes · 11 clusters · Seurat 5.5.0 · `cell_type` column already present in saved `.Robj`.

Two compartments:

| Compartment | Cell Types |
|---|---|
| **SS tumor** | SS_Cording · SS_Mono · SS_2 · SS_1Fib · SS_PD |
| **Microenvironment** | Marcophage · Endothelial · Fib · NK/T · Mast · Neutrophil |

> **Note on naming:** The saved object uses short labels (e.g. `SS_Cording`, `Marcophage`). The Rmd script `mSS_SC_CellType.Rmd` mapped these to longer descriptive names — see correspondence table below. The `cell_type` column is already written into `srt_for_monocle3.Robj`; do not overwrite it when loading for downstream work.

---

## Cell Type Correspondence Table

| Object label (`cell_type`) | Rmd descriptive name | n cells (A8163) |
|---|---|---|
| SS_Cording | epithelial SS | ~3,800 |
| SS_Mono | Mono SS | ~3,500 |
| SS_2 | Stem SS | ~3,200 |
| SS_1Fib | fibro-like SS | ~4,100 |
| SS_PD | Poorly Differentiated SS | ~5,000 |
| Marcophage | Tumor Associated Macrophage | ~5,200 |
| Endothelial | Endothelial cells | ~3,100 |
| Fib | Fibroblast cells | ~29,800 |
| NK/T | NK cells | ~1,000 |
| Mast | Mast cells | ~700 |
| Neutrophil | Neutrophils | ~800 |

---

## Empirical Marker Panels (A8163, top 10 by avg_log2FC)

### SS_Cording — corded/epithelial SS component
Glandular/cord-like structures on H&E; biphasic component of the tumor.
```
Tafa5, En1, Zic4, Zic1, Agbl4, Mapk10, Col4a6, Ecrg4, Celrr, Gm29478
```
- **En1** (Engrailed-1) is a known SS18-SSX transcriptional target — strong positive marker
- **Zic1/Zic4** neural transcription factors expressed in SS epithelial component
- **Col4a6** basement membrane collagen, consistent with glandular morphology

### SS_Mono — monophasic / spindle-cell SS
Classic spindle-cell morphology; mesenchymal program dominant.
```
Luzp2, Kcnk2, Nlgn1, Lekr1, Ptn, Ptprt, Nol4, Homer2, Gm42047, Cdc20
```
- **Ptn** (pleiotrophin) is a known SS-associated growth factor
- **Cdc20** marks proliferative fraction within this subtype
- Lower avg_log2FC vs. other SS subtypes — most transcriptionally similar to bulk tumor

### SS_2 — neural-like SS / stem-like
High expression of neural and synaptic genes; labeled "Stem SS" in Rmd.
```
Pcp4, Syt1, Cnr1, Cntn1, Palmd, Tmem132d, F3, Vwc2, Fam189a1, Rbfox1
```
- **Pcp4, Syt1, Cnr1** synaptic/neural markers — neuroectodermal differentiation program
- **Rbfox1** RNA-binding protein enriched in neurons; marks plasticity
- Stem-like designation reflects high plasticity gene program, not classical stemness markers

### SS_1Fib — fibro-like SS
Tumor cells with fibroblast-like transcriptome; mesenchymal SS component.
```
Col1a1, Stmn2, Bdnf, Adgrl3, Adamtsl3, Kcnma1, Cped1, Mgp, Il1rapl2, Egr4
```
- **Col1a1** highest-expressed canonical marker; distinguish from stromal Fib by context (see below)
- **Stmn2, Bdnf** neural-mesenchymal hybrid markers
- **Mgp** matrix Gla protein; ECM remodeling in SS stroma

### SS_PD — poorly differentiated SS
Least-differentiated tumor population; aggressive phenotype.
```
H19, Igf2, Gap43, Otof, Nrg1, Nkx2-3, Hoxa11os, Kctd16, Uty, Qpct
```
- **H19/Igf2** imprinted oncofetal lncRNA/growth factor pair; high in aggressive/undifferentiated tumors
- **Gap43** axonal growth marker; neural de-differentiation
- **Nrg1** neuregulin; ErbB signaling enriched in PD component

---

### Marcophage — tumor-associated macrophage (TAM)
> ⚠️ Typo in object: stored as `Marcophage`, not `Macrophage`. Match exactly when filtering.

M2/homeostatic TAM phenotype; immunosuppressive microenvironment.
```
C1qa, C1qb, C1qc, Trem2, Ms4a7, Pf4, Lilra5, Fcrls, Msr1, Apoc2
```
- **C1qa/b/c** complement TAM signature; homeostatic/M2-like
- **Trem2** marks lipid-associated / immunosuppressive macrophages
- **Pf4** (CXCL4) TAM-specific chemokine

### Endothelial — tumor vasculature
```
Cdh5, Tie1, Emcn, Sox17, Gpihbp1, Ptprb, Adgrl4, Myct1, Cyyr1, Ccdc85a
```
- **Cdh5** (VE-cadherin), **Tie1**, **Emcn** canonical endothelial markers
- **Sox17** arterial endothelial specification

### Fib — stromal fibroblasts / pericytes
```
Rgs5, Trpc6, Gucy1a1, Higd1b, Rarres2, Olfr558, Kcnt2, Cyp4b1, Rem1, Serpina1b
```
- **Rgs5** pericyte marker; this population includes pericyte-like stromal cells
- **Distinguish from SS_1Fib:** Fib lacks Col1a1 at high level and is Col1a1-lo/Rgs5-hi; SS_1Fib is Col1a1-hi

### NK/T — NK and T lymphocytes (combined cluster)
```
Cd3g, Klrd1, Itk, P2ry10, Grap2, Stat4, Lsp1, Il7r, Ptpn22, Napsa
```
- **Cd3g** T cell marker; **Klrd1** NK cell marker — cluster contains both populations
- Sub-cluster with `Cd3g+/Klrd1-` = T cells; `Cd3g-/Klrd1+` = NK cells
- To split: re-cluster at higher resolution or use `Cd3g` vs `Klrd1` to assign sub-identity

### Mast — mast cells
```
Cpa3, Mcpt4, Cma1, Ms4a2, Mrgprb1, Mcpt2, Mrgprb2, Mrgprx2, Rgs13, Cd200r3
```
- **Cpa3, Mcpt4, Cma1** mast cell proteases; highly specific
- **Ms4a2** (FcεRI β-chain) IgE receptor; canonical mast cell marker

### Neutrophil — tumor-infiltrating neutrophils
```
S100a8, S100a9, Cxcr2, Retnlg, Lcn2, Acod1, Trem1, Hcar2, Wfdc21, Mirt2
```
- **S100a8/S100a9** calprotectin complex; top markers by fold-change
- **Cxcr2** neutrophil chemokine receptor; marks tumor-infiltrating fraction

---

## Annotation Workflow for New mSS Datasets

### Step 1 — Load and inspect

```r
library(Seurat)

load("srt_for_monocle3.Robj")   # object is named 'srt'
# If cell_type already present, use it directly:
if ("cell_type" %in% colnames(srt@meta.data)) {
  Idents(srt) <- "cell_type"
  print(table(srt$cell_type))
}
DimPlot(srt, reduction = "umap", group.by = "cell_type", label = TRUE, label.size = 4)
```

### Step 2 — For a NEW dataset: score marker panels

```r
ss_markers <- list(
  SS_Cording  = c("En1", "Zic1", "Zic4", "Tafa5", "Col4a6"),
  SS_Mono     = c("Ptn", "Luzp2", "Kcnk2", "Nlgn1", "Ptprt"),
  SS_2        = c("Pcp4", "Syt1", "Cnr1", "Rbfox1", "Cntn1"),
  SS_1Fib     = c("Col1a1", "Stmn2", "Bdnf", "Mgp", "Adgrl3"),
  SS_PD       = c("H19", "Igf2", "Gap43", "Nrg1", "Nkx2-3"),
  Marcophage  = c("C1qa", "C1qb", "Trem2", "Pf4", "Ms4a7"),
  Endothelial = c("Cdh5", "Tie1", "Emcn", "Sox17", "Ptprb"),
  Fib         = c("Rgs5", "Trpc6", "Gucy1a1", "Rarres2", "Higd1b"),
  NK_T        = c("Cd3g", "Klrd1", "Itk", "Il7r", "Grap2"),
  Mast        = c("Cpa3", "Mcpt4", "Cma1", "Ms4a2", "Mrgprb1"),
  Neutrophil  = c("S100a8", "S100a9", "Cxcr2", "Retnlg", "Lcn2")
)

srt <- AddModuleScore(srt, features = ss_markers, name = "score_")
# score_1…score_11 correspond to names(ss_markers) in order
```

### Step 3 — Review markers per cluster

```r
markers <- FindAllMarkers(srt, only.pos = TRUE, min.pct = 0.25,
                          logfc.threshold = 0.25, test.use = "wilcox")

library(dplyr)
top5 <- markers %>% group_by(cluster) %>% slice_max(avg_log2FC, n = 5)
print(top5)

DotPlot(srt,
        features = c("En1","Zic1","Ptn","Pcp4","Syt1","Col1a1","H19","Igf2",
                     "C1qa","Trem2","Cdh5","Rgs5","Cd3g","Klrd1",
                     "Cpa3","Mcpt4","S100a8","S100a9"),
        group.by = "seurat_clusters") + RotatedAxis()
```

### Step 4 — Assign labels

```r
# Edit to match your cluster numbering — verify against DotPlot first
cluster_to_celltype <- list(
  "0"  = "SS_Cording",
  "1"  = "SS_Mono",
  "2"  = "SS_PD",
  "3"  = "Marcophage",
  "4"  = "SS_1Fib",
  "5"  = "SS_2",
  "6"  = "Endothelial",
  "7"  = "Fib",
  "8"  = "NK/T",
  "9"  = "Mast",
  "10" = "Neutrophil"
)

srt$cell_type <- sapply(as.character(srt$seurat_clusters),
                        function(x) cluster_to_celltype[[x]])

DimPlot(srt, reduction = "umap", group.by = "cell_type",
        label = TRUE, label.size = 5)
```

### Step 5 — Validate and save

```r
table(srt$cell_type) / ncol(srt)

top3 <- markers %>% group_by(cluster) %>% slice_max(avg_log2FC, n = 3)
DoHeatmap(srt, features = top3$gene) + NoLegend()

saveRDS(srt, "results/srt_annotated.rds")
```

---

## Disambiguation: SS_1Fib vs. Fib

Both express collagen genes. Key distinguishing features:

| Feature | SS_1Fib | Fib |
|---|---|---|
| Col1a1 | High (avg_log2FC 3.6) | Low / absent |
| Rgs5 | Absent | High (top marker) |
| Stmn2, Bdnf | Present | Absent |
| Trpc6, Gucy1a1 | Absent | Present |
| Biology | Tumor cell (SS18-SSX+) | Stromal pericyte/fibroblast |

To confirm: run `inferCNV` — SS_1Fib will carry copy-number alterations; Fib will be diploid.

## Annotation Quality Checks

1. **Doublet removal** — run `scDblFinder` before annotating; SS_PD (H19/Igf2-high) and rapidly cycling cells can score as doublets.
2. **NK/T splitting** — if resolution matters, sub-cluster the NK/T population using `Cd3g` (T) vs. `Klrd1` (NK).
3. **Marcophage typo** — the label is spelled `Marcophage` in the A8163 object; keep consistent when merging datasets.
4. **Verify En1 for SS_Cording** — En1 is a reliable SS18-SSX downstream target; its absence in a putative SS_Cording cluster warrants review.
5. **H19/Igf2 in SS_PD** — these imprinted loci are highly expressed in aggressive/undifferentiated SS; confirm they are not driven by a technical batch effect.

---

## Biological Notes

- **SS18-SSX fusion** drives the SS_Cording (En1+, Zic1+) and SS_Mono (Ptn+) populations; both are tumor cells with different differentiation states.
- **SS_2 / neural-like** was labeled "Stem SS" in the Rmd; it expresses synaptic genes (Pcp4, Syt1, Cnr1) suggesting a neuroectodermal/plastic state rather than classical stemness.
- **SS_PD** (H19/Igf2-high) is the most aggressive subtype; high mitotic index on H&E.
- **TAMs** (`Marcophage`) are C1q+/Trem2+ homeostatic/M2-like; immunosuppressive phenotype consistent with SS immune evasion.
- **Fib** is predominantly Rgs5+ pericyte-like stroma, not classic DCN+/PDGFRA+ fibroblasts.

---

## Reference Dataset

| Field | Value |
|---|---|
| Dataset ID | A8163_mSS |
| Object file | `srt_for_monocle3.Robj` (variable: `srt`) |
| CHPC path | `/uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/singlecellrnaseq/A8163_mSS/` |
| Cells / Genes | 42,141 / 32,286 |
| Annotation method | Seurat clustering + H&E pathology + FindAllMarkers (Wilcoxon) |
| Marker file | `markers_top10.csv`, `markers_all.csv` (same CHPC dir) |
| Analysis script | `mSS_SC_CellType.Rmd` |
| Seurat version | 5.5.0 (R 4.5.1, R_env conda) |

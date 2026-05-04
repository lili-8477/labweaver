---
name: differential-expression
description: Differential expression for bulk and single-cell data -- DESeq2/edgeR/limma for bulk, pseudobulk + DESeq2 for cross-condition single-cell, plus composition tests (scCODA, MiloR). Use any time you compare conditions, treatments, or genotypes.
---

# Differential Expression

The right test for bulk vs single-cell, plus how to handle composition shifts
and batch effects in the design matrix.

**Sources**:
- [OSCA -- Orchestrating Single-Cell Analysis](https://bioconductor.org/books/release/OSCA/)
- Charlotte Soneson's pseudobulk tutorials and the [muscat](https://bioconductor.org/packages/muscat) vignette
- Squair et al. 2021 (Nature Comms) -- "Confronting false discoveries in single-cell DE"

---

## 1. Bulk vs Single-Cell DE -- The Core Difference

| | Bulk RNA-seq | Single-Cell RNA-seq |
|---|---|---|
| Samples | Donors / replicates (n=3-100s) | Cells (n=1k-1M+) per sample |
| Variability | Biological replicate variability | Cell-level technical noise + biological |
| Inference target | Per-gene per-condition | Per-gene per-cluster per-condition |
| Naive test | DESeq2 / edgeR / limma on raw counts | Wilcoxon on log-norm counts |
| Pitfall | Few samples -> low power | Many cells -> tiny p-values from technical noise |

> [!WARNING]
> Treating each cell as a replicate inflates power dramatically and produces
> thousands of false positives. Squair et al. 2021 showed that single-cell
> tools applied between conditions produce more false discoveries than a
> permuted negative control. **Aggregate to pseudobulk per sample x cluster
> before testing across conditions.**

---

## 2. Tool Selection

| Scenario | Recommended Tool | Why |
|----------|------------------|-----|
| Bulk RNA-seq, count data, n>=3 | **DESeq2** or **edgeR** | Negative-binomial GLM; mature, well-tested |
| Bulk RNA-seq, want flexible design + voom | **limma-voom** | Linear models on log-CPM; fastest with complex designs |
| Bulk microarray | **limma** | Linear models; the original use case |
| scRNA-seq markers (cluster vs rest) | `scanpy.tl.rank_genes_groups` (Wilcoxon) or `Seurat::FindAllMarkers` | Quick descriptive markers only |
| scRNA-seq markers, gene-detection focus | **MAST** | Hurdle model accounts for dropouts |
| scRNA-seq cross-condition DE | **Pseudobulk + DESeq2 / edgeR / limma** | Treats samples as replicates -- correct unit |
| scRNA-seq cross-condition, complex design | `muscat` (R) or `decoupler.get_pseudobulk` + DESeq2 | Pseudobulk wrappers |
| scRNA-seq, want a mixed model instead of pseudobulk | `glmmTMB`, `NEBULA`, `dreamlet` | When you have many samples and want cell-level inference |
| Composition / abundance shifts | **scCODA** (Python) or **MiloR** (R) | Different model from expression DE |

---

## 3. Bulk Differential Expression -- DESeq2

```r
library(DESeq2)

# counts: gene x sample integer matrix
# coldata: data.frame with rows = samples, cols = condition, batch, ...
dds <- DESeqDataSetFromMatrix(
  countData = counts,
  colData   = coldata,
  design    = ~ batch + condition           # batch FIRST, condition LAST
)
dds <- dds[rowSums(counts(dds) >= 10) >= 3, ]    # filter low-count genes
dds <- DESeq(dds)
res <- results(dds, contrast = c("condition", "treated", "control"),
               alpha = 0.05)
res <- lfcShrink(dds, coef = "condition_treated_vs_control", type = "apeglm")
```

> [!TIP]
> Put the variable of interest **last** in the design formula -- DESeq2 reports
> the last term by default. To test a different one explicitly, pass `contrast`
> or `name` to `results()`.

### edgeR Equivalent

```r
library(edgeR)
y <- DGEList(counts = counts, group = coldata$condition)
y <- y[filterByExpr(y, group = coldata$condition), , keep.lib.sizes = FALSE]
y <- calcNormFactors(y)
design <- model.matrix(~ batch + condition, data = coldata)
y <- estimateDisp(y, design)
fit <- glmQLFit(y, design)
qlf <- glmQLFTest(fit, coef = "conditiontreated")
topTags(qlf, n = 20)
```

---

## 4. Single-Cell -- Marker Discovery (NOT Cross-Condition DE)

```python
# scanpy: cluster vs rest -- markers only, NOT for treated vs control
sc.tl.rank_genes_groups(adata, groupby="leiden", method="wilcoxon",
                         use_raw=False, layer=None)
sc.pl.rank_genes_groups_dotplot(adata, n_genes=5)
markers = sc.get.rank_genes_groups_df(adata, group=None)
```

```r
# Seurat v5 equivalent
library(Seurat)
markers <- FindAllMarkers(srat, only.pos = TRUE,
                           logfc.threshold = 0.25, min.pct = 0.1)
```

> [!WARNING]
> `rank_genes_groups` and `FindAllMarkers` find genes that *describe* a cluster.
> They are **not** valid for testing condition effects (treated vs control)
> within a cell type, even if you subset to one cluster first -- the unit of
> replication is the *sample*, not the cell.

---

## 5. Single-Cell Cross-Condition -- Pseudobulk

The recipe: per (sample, cluster) pair, sum raw counts across cells, then
treat the resulting pseudobulk samples as a normal bulk RNA-seq experiment.

### Python -- decoupler helper + DESeq2 via PyDESeq2

```python
import decoupler as dc
from pydeseq2.dds import DeseqDataSet
from pydeseq2.ds import DeseqStats

# 1. Pseudobulk: sum counts per (sample, cluster)
pdata = dc.get_pseudobulk(
    adata,
    sample_col="sample_id",
    groups_col="cell_type",
    layer="counts",            # raw integer counts!
    min_cells=10, min_counts=1000,
)

# 2. DE for one cell type
ct = "T_cell"
sub = pdata[pdata.obs["cell_type"] == ct].copy()
dc.filter_by_expr(sub, group="condition", min_count=10, min_total_count=15)

dds = DeseqDataSet(adata=sub, design_factors=["batch", "condition"],
                    refit_cooks=True)
dds.deseq2()
stat = DeseqStats(dds, contrast=["condition", "treated", "control"])
stat.summary()
de_df = stat.results_df
```

### R -- muscat (preferred for many cell types)

```r
library(muscat); library(SingleCellExperiment); library(DESeq2)
# sce has colData columns: sample_id, group_id, cluster_id
pb <- aggregateData(sce, assay = "counts", fun = "sum",
                     by = c("cluster_id", "sample_id"))
res <- pbDS(pb, method = "DESeq2", design = ~ batch + group_id,
            coef = "group_idtreated")
```

### When Pseudobulk Doesn't Work

You need >=2 (ideally >=3) samples per condition per cluster. With fewer,
either:

- Drop the cluster, or
- Use a cell-level mixed model: `NEBULA` (R) or `dreamlet` (R) which fit
  a random effect per sample. These are still more conservative than naive
  cell-level Wilcoxon.

---

## 6. Composition / Abundance Tests

Cell-type *proportions* shift between conditions, separately from expression.
Don't conflate the two.

| Tool | Question | Approach |
|------|----------|----------|
| `scCODA` (Python) | Which cell types changed proportion? | Bayesian compositional model with reference cell type |
| `MiloR` (R) | Which *neighborhoods* (kNN) changed abundance? | Per-neighborhood NB GLM; resolution-free |
| `propeller` (limma) | Per-cluster proportion test | Logit-transformed proportions + limma |

```python
import sccoda.util.cell_composition_data as ccd
import sccoda.util.comp_ana as comp

cnt = adata.obs.groupby(["sample_id", "cell_type"]).size().unstack(fill_value=0)
md  = adata.obs[["sample_id", "condition"]].drop_duplicates().set_index("sample_id")
data = ccd.from_pandas(cnt.join(md), covariate_columns=["condition"])

mod = comp.CompositionalAnalysis(data, formula="condition",
                                  reference_cell_type="automatic")
res = mod.sample_hmc(num_results=20000)
res.summary()
```

```r
library(miloR); library(SingleCellExperiment)
milo <- Milo(sce)
milo <- buildGraph(milo, k = 30, d = 30)
milo <- makeNhoods(milo, prop = 0.1, k = 30, d = 30, refined = TRUE)
milo <- countCells(milo, samples = "sample_id", meta.data = colData(milo))
da   <- testNhoods(milo, design = ~ batch + condition, design.df = sample_md)
```

---

## 7. Batch Effects in the Design Matrix

The right place to handle batch is **the design formula**, not via batch-corrected counts.

```r
# Correct -- batch as a covariate
design <- ~ batch + condition

# Wrong -- running DE on Combat-corrected counts
# (corrupts the variance structure DESeq2 / edgeR rely on)
```

> [!WARNING]
> Never feed batch-corrected (Combat / Harmony / scVI-imputed) counts to
> DESeq2 / edgeR. They model raw counts and assume a negative-binomial mean-
> variance relationship that batch correction destroys. Adjust *in* the model.

For paired or repeated-measures designs, use `~ subject + condition`. For
mixed effects with many subjects, use `dream` from `variancePartition`.

---

## Quick Reference

### Pseudobulk Cross-Condition DE (Python)

```python
import decoupler as dc
from pydeseq2.dds import DeseqDataSet
from pydeseq2.ds  import DeseqStats

pdata = dc.get_pseudobulk(adata, sample_col="sample_id",
                           groups_col="cell_type", layer="counts",
                           min_cells=10, min_counts=1000)
sub = pdata[pdata.obs["cell_type"] == "T_cell"].copy()
dc.filter_by_expr(sub, group="condition", min_count=10, min_total_count=15)
dds = DeseqDataSet(adata=sub, design_factors=["batch", "condition"])
dds.deseq2()
de = DeseqStats(dds, contrast=["condition", "treated", "control"])
de.summary()
top = de.results_df.sort_values("padj").head(50)
```

### Marker Genes (Single-Cell, Within One Condition)

```python
sc.tl.rank_genes_groups(adata, groupby="leiden", method="wilcoxon")
sc.pl.rank_genes_groups_dotplot(adata, n_genes=5)
```

### Bulk DE (R)

```r
dds <- DESeqDataSetFromMatrix(counts, coldata, design = ~ batch + condition)
dds <- dds[rowSums(counts(dds) >= 10) >= 3, ]
dds <- DESeq(dds)
res <- lfcShrink(dds, coef = "condition_treated_vs_control", type = "apeglm")
```

---

## Best Practices

1. **The unit of replication is the sample, not the cell.** For cross-condition single-cell DE, always pseudobulk first.
2. **Use `rank_genes_groups` / `FindAllMarkers` for markers only.** They describe clusters, they do not test condition effects.
3. **Filter low-count genes before testing.** `rowSums(counts >= 10) >= n_min_samples` is a sensible default; matches `filterByExpr` for edgeR.
4. **Adjust for batch in the design**, never via Combat-corrected counts fed to NB models.
5. **Shrink log2 fold-changes** (`lfcShrink` in DESeq2, `glmTreat` in edgeR) -- raw LFCs from low-count genes are noisy and dominate sorted result tables.
6. **Test composition separately.** Use scCODA or MiloR for abundance shifts; don't infer them from expression DE results.
7. **Store the contrast and the design formula** alongside the result table -- it is the single most useful piece of metadata for re-interpreting results six months later.

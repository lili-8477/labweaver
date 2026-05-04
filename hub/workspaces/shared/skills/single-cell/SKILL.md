---
name: single-cell
description: Single-cell RNA-seq analysis -- QC, normalization, clustering, annotation, integration. The default starting point for any scRNA-seq project. Pairs with the differential-expression and spatial-transcriptomics skills for those subtopics.
---

# Single-Cell RNA-seq: Standard Analysis

A focused starting point for single-cell projects covering the canonical
pipeline from count matrix to annotated, integrated UMAP.

**Source**: [https://www.sc-best-practices.org](https://www.sc-best-practices.org)
(scverse / Theis lab best-practices book).

---

## 1. Technologies (One-Line Summaries)

| Platform | Throughput | Strength |
|----------|------------|----------|
| 10x Chromium 3'/5' | 10k-100k cells | Default; UMI-based; broadest tool support |
| Smart-seq2/3 | 100s-1000s cells | Full-length transcripts, isoforms, deep coverage |
| sci-RNA-seq / Parse | 100k-millions | Combinatorial indexing; atlas scale; lower cost |
| BD Rhapsody | 10k-100k | Targeted panels + WTA |

> [!TIP]
> Choose 10x by default. Pick Smart-seq for isoform / TCR-from-RNA work.
> Pick sci-RNA-seq / Parse for atlas-scale (>250k cells).

---

## 2. Ecosystems

### Python -- scverse (preferred in this workspace)

- **scanpy** -- preprocessing, clustering, DE, visualization
- **anndata** -- the central data structure
- **scvi-tools** -- VAE-based integration, scANVI annotation, MultiVI
- **squidpy** -- spatial (see `spatial-transcriptomics` skill)
- **decoupler-py** -- pathway / TF activity (see `pathway-analysis` skill)

### R

- **Seurat v5** -- BPCells-backed; supports out-of-core for large objects
- **Bioconductor (OSCA)** -- `SingleCellExperiment` + `scran`/`scater`/`batchelor`
- **scDblFinder**, **SoupX** -- doublet removal and ambient correction

`/venv` ships scanpy + torch; the `ir` kernel ships Seurat v5 + Bioconductor.
Use rpy2 only at the boundary, not as your primary R driver.

---

## 3. AnnData Refresher

```python
import scanpy as sc

adata = sc.read_10x_h5("filtered_feature_bc_matrix.h5")
# adata.X       -- expression (cells x genes; sparse CSR)
# adata.obs     -- cell metadata
# adata.var     -- gene metadata
# adata.obsm    -- embeddings ("X_pca", "X_umap", ...)
# adata.layers  -- alternative matrices ("counts", "scaled", ...)
# adata.uns     -- unstructured (params, colors, DE results)
```

> [!WARNING]
> AnnData is cells x genes. SingleCellExperiment / Seurat are genes x cells.
> Conversions handle this automatically; custom interop code must not.

---

## 4. The Standard Preprocessing Pipeline

```
QC -> doublet removal -> normalize -> log1p -> HVG -> scale (optional) ->
PCA -> kNN graph -> UMAP -> Leiden -> annotate
```

### 4a. QC

```python
adata.var["mt"] = adata.var_names.str.startswith("MT-")        # human
adata.var["ribo"] = adata.var_names.str.startswith(("RPS", "RPL"))
sc.pp.calculate_qc_metrics(adata, qc_vars=["mt", "ribo"], inplace=True)

# Inspect distributions before hard cutoffs
sc.pl.violin(adata, ["n_genes_by_counts", "total_counts", "pct_counts_mt"],
             jitter=0.4, multi_panel=True)

# Conservative defaults; adjust per-tissue
adata = adata[
    (adata.obs["n_genes_by_counts"] > 200) &
    (adata.obs["pct_counts_mt"] < 20)
].copy()
sc.pp.filter_genes(adata, min_cells=3)
```

### 4b. Doublet Detection

```python
import scanpy as sc
sc.pp.scrublet(adata, batch_key="sample")  # adds adata.obs["predicted_doublet"]
adata = adata[~adata.obs["predicted_doublet"]].copy()
```

### 4c. Normalization, HVG, PCA

```python
adata.layers["counts"] = adata.X.copy()           # always preserve raw
sc.pp.normalize_total(adata, target_sum=1e4)
sc.pp.log1p(adata)
sc.pp.highly_variable_genes(adata, n_top_genes=2000, flavor="seurat_v3",
                             layer="counts", batch_key="sample")
sc.pp.pca(adata, n_comps=50, use_highly_variable=True)
```

### 4d. Neighbors, UMAP, Leiden

```python
sc.pp.neighbors(adata, n_neighbors=15, n_pcs=30)
sc.tl.umap(adata)
sc.tl.leiden(adata, resolution=0.5, flavor="igraph", n_iterations=2)
sc.pl.umap(adata, color=["leiden", "sample", "pct_counts_mt"])
```

> [!TIP]
> `flavor="seurat_v3"` HVG selection requires raw counts, so call it before
> normalization or pass `layer="counts"` after.

---

## 5. Annotation Strategies

### 5a. Marker-Gene (Manual)

```python
sc.tl.rank_genes_groups(adata, groupby="leiden", method="wilcoxon")
sc.pl.rank_genes_groups_dotplot(adata, n_genes=5)

# Or score a curated panel
sc.tl.score_genes(adata, gene_list=["CD3D", "CD3E", "CD8A"], score_name="T_score")
```

> [!WARNING]
> `rank_genes_groups` is good for **marker discovery**, not for cross-condition DE.
> See the `differential-expression` skill -- single-cell DE between *conditions*
> requires pseudobulk; cluster markers do not.

### 5b. Reference-Based -- celltypist / Azimuth

```python
import celltypist
model = celltypist.models.Model.load("Immune_All_Low.pkl")
preds = celltypist.annotate(adata, model=model, majority_voting=True)
adata = preds.to_adata()  # adds adata.obs["majority_voting"]
```

```r
# Azimuth (R) -- maps to a curated PBMC / lung / heart reference
library(Seurat); library(Azimuth)
srat <- RunAzimuth(srat, reference = "pbmcref")
```

### 5c. Reference-Based -- scANVI (semi-supervised, scvi-tools)

```python
import scvi
scvi.model.SCVI.setup_anndata(adata, layer="counts", batch_key="sample")
vae = scvi.model.SCVI(adata)
vae.train(max_epochs=100)
lvae = scvi.model.SCANVI.from_scvi_model(vae, labels_key="celltype",
                                          unlabeled_category="Unknown")
lvae.train(max_epochs=20)
adata.obs["scanvi_pred"] = lvae.predict()
```

| Approach | Signal | When to Use |
|----------|--------|-------------|
| Marker dot-plot | Manual, interpretable | First pass; novel tissue |
| celltypist | Logistic regression on PBMC/atlas references | Immune / well-charted tissues |
| Azimuth | Reference-mapped Seurat workflow | Curated tissues (PBMC, lung, heart, kidney) |
| scANVI | Semi-supervised VAE | When you have partial labels and want batch-aware annotation |

---

## 6. Batch Correction / Integration

| Method | Where it Works | Output |
|--------|----------------|--------|
| Harmony | Linear correction in PCA space; fast | Corrected `X_pca_harmony` |
| BBKNN | Builds a batch-balanced kNN graph | Corrected neighbor graph |
| scVI | VAE; integrates + denoises + DE | Latent `X_scVI` (use for kNN/UMAP) |
| scANVI | scVI + label transfer | Latent + `predictions` |
| Seurat v5 IntegrateLayers | RPCA / CCA / Harmony / scVI in R | Integrated reductions |

```python
# Harmony (fastest, linear)
import scanpy.external as sce
sce.pp.harmony_integrate(adata, key="sample")
sc.pp.neighbors(adata, use_rep="X_pca_harmony")
sc.tl.umap(adata)
```

```python
# scVI (recommended when batches are large or non-linear)
import scvi
scvi.model.SCVI.setup_anndata(adata, layer="counts", batch_key="sample")
vae = scvi.model.SCVI(adata, n_layers=2, n_latent=30)
vae.train()
adata.obsm["X_scVI"] = vae.get_latent_representation()
sc.pp.neighbors(adata, use_rep="X_scVI"); sc.tl.umap(adata)
```

> [!TIP]
> Try Harmony first (one line, seconds). Move to scVI/scANVI when batches
> have very different cell-type compositions or technical platforms.

---

## 7. Downstream Pointers

For the next stages of analysis, see the dedicated skills in this workspace:

| Question | Skill |
|----------|-------|
| Cross-condition DE, pseudobulk, composition tests | `differential-expression` |
| Pathway / GSEA scoring on cluster signatures | `pathway-analysis` |
| Visium, MERFISH, Xenium, Slide-seq | `spatial-transcriptomics` |
| ChIP / ATAC peak analysis | `chip-seq` |

---

## Quick Reference: Minimal Scanpy Workflow

```python
import scanpy as sc

# 1. Load
adata = sc.read_10x_h5("filtered_feature_bc_matrix.h5")

# 2. QC
adata.var["mt"] = adata.var_names.str.startswith("MT-")
sc.pp.calculate_qc_metrics(adata, qc_vars=["mt"], inplace=True)
adata = adata[(adata.obs.n_genes_by_counts > 200) &
              (adata.obs.pct_counts_mt < 20)].copy()
sc.pp.filter_genes(adata, min_cells=3)
sc.pp.scrublet(adata)
adata = adata[~adata.obs["predicted_doublet"]].copy()

# 3. Normalize + HVG
adata.layers["counts"] = adata.X.copy()
sc.pp.normalize_total(adata, target_sum=1e4); sc.pp.log1p(adata)
sc.pp.highly_variable_genes(adata, n_top_genes=2000, flavor="seurat_v3",
                             layer="counts", batch_key="sample")

# 4. Reduce + cluster
sc.pp.pca(adata, n_comps=50)
sc.pp.neighbors(adata, n_neighbors=15, n_pcs=30)
sc.tl.umap(adata); sc.tl.leiden(adata, resolution=0.5, flavor="igraph")

# 5. Markers + save
sc.tl.rank_genes_groups(adata, "leiden", method="wilcoxon")
adata.write_h5ad("processed.h5ad")
```

---

## Best Practices

1. **Preserve raw counts** in `adata.layers["counts"]` before any normalization. Many downstream tools (scVI, DESeq2 pseudobulk, MAST) require integer counts.
2. **Inspect QC distributions before cutoffs.** Hard thresholds copied from a tutorial routinely discard real biology in unfamiliar tissues.
3. **Run doublet detection per sample**, not on the merged object -- doublets are a per-library artefact.
4. **Pick HVG with `batch_key`** when integrating; otherwise batch-driven genes dominate the variable set.
5. **`rank_genes_groups` is for markers, not cross-condition DE.** Move to pseudobulk DE (see `differential-expression` skill).
6. **Store provenance** -- record scanpy / scvi-tools / reference versions in `adata.uns` and a `step_log` (per the workspace convention).

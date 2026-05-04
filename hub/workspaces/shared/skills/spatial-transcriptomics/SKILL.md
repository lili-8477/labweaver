---
name: spatial-transcriptomics
description: Spatial transcriptomics analysis (Visium, MERFISH, Xenium, Slide-seq, Stereo-seq) -- preprocessing, spatially-variable genes, niche/domain identification, spot deconvolution, and cell-cell communication in space.
---

# Spatial Transcriptomics

End-to-end spatial workflows: from a SpaceRanger/segmentation output to
spatial domains, deconvolved cell types, and cross-cell signaling.

**Source**: [Squidpy documentation](https://squidpy.readthedocs.io) and the
scverse spatial chapter of [sc-best-practices.org](https://www.sc-best-practices.org).

---

## 1. Modality Landscape

| Platform | Type | Resolution | Genes | Best For |
|----------|------|------------|-------|----------|
| 10x Visium | Sequencing, spot | 55 um (1-10 cells/spot) | Whole transcriptome | Tissue overviews, FFPE, classical workflows |
| 10x Visium HD | Sequencing, sub-cell | 2 um bins | Whole transcriptome | Near-single-cell sequencing-based |
| Slide-seq v2 | Sequencing, bead | 10 um | Whole transcriptome | Higher-density beads, mouse atlas work |
| Stereo-seq | Sequencing, sub-cell | 0.5 um (binned) | Whole transcriptome | Very large fields, embryo/whole-organ |
| 10x Xenium | Imaging | Sub-cellular | 100-500 panel | Validation; clinical; in situ |
| Vizgen MERSCOPE / MERFISH | Imaging | Sub-cellular | 200-1000 panel | High-plex single-cell *in situ* |
| NanoString CosMx | Imaging | Sub-cellular | 1000+ panel | High-plex protein + RNA |

### Sequencing- vs Imaging-Based

- **Sequencing-based** (Visium, Slide-seq, Stereo-seq) -- whole transcriptome
  but at spot/bin resolution; deconvolution of cell-type composition is needed.
- **Imaging-based** (Xenium, MERFISH, CosMx) -- single-molecule, segmented to
  single cells, but only the targeted panel; cell-type composition is direct
  but novel genes are absent.

> [!TIP]
> Pick Visium for unbiased, hypothesis-generating tissue surveys. Pick Xenium
> or MERFISH when you already know the panel of interest and need single-cell
> resolution. Visium HD bridges the two for sequencing budgets.

---

## 2. Tools

| Stack | Strength |
|-------|----------|
| `squidpy` (Python, scverse) | Spatial graphs, neighborhood enrichment, ligand-receptor |
| `scanpy.read_visium` | Native Visium loading |
| `stLearn` (Python) | Trajectory + cell-cell scoring on tissue |
| `Giotto` (R) | Comprehensive R-side workflow |
| `semla` (R) | Modern R companion to Seurat v5 spatial |
| SpaceRanger (10x) | Visium / HD raw -> filtered matrix + image alignment |
| `cell2location` (Python) | Bayesian deconvolution |
| `RCTD` / `spacexr` (R) | Robust deconvolution; LDA-style |
| `Tangram` (Python) | Mapping scRNA-seq onto tissue |
| `BayesSpace` / `STAGATE` | Spatial domain identification |
| `CellChat` v2 / `COMMOT` | Cell-cell communication in space |

---

## 3. Loading and Preprocessing

```python
import scanpy as sc, squidpy as sq

adata = sc.read_visium("spaceranger/outs/")
adata.var_names_make_unique()

# QC -- mitochondrial spots
adata.var["mt"] = adata.var_names.str.startswith("MT-")
sc.pp.calculate_qc_metrics(adata, qc_vars=["mt"], inplace=True)

# Visium QC plots include the tissue image
sc.pl.spatial(adata, color=["total_counts", "n_genes_by_counts", "pct_counts_mt"])

# Spot filter -- much gentler than scRNA-seq, spots are not single cells
adata = adata[adata.obs["pct_counts_mt"] < 30].copy()
sc.pp.filter_genes(adata, min_cells=10)

# Normalize / HVG / PCA / UMAP -- same as scRNA-seq
adata.layers["counts"] = adata.X.copy()
sc.pp.normalize_total(adata); sc.pp.log1p(adata)
sc.pp.highly_variable_genes(adata, n_top_genes=2000, flavor="seurat_v3",
                             layer="counts")
sc.pp.pca(adata); sc.pp.neighbors(adata); sc.tl.umap(adata)
sc.tl.leiden(adata, resolution=0.5, flavor="igraph")
```

> [!WARNING]
> Visium spot filters should be much more permissive than scRNA-seq. A spot
> with low counts is not necessarily a "low quality cell" -- it might be a
> tissue region of low cellularity that is biologically informative.

---

## 4. Spatial Neighborhood Graph

Most spatial analysis hangs off a *spatial neighborhood graph* (which spots
are adjacent), not the expression-space kNN graph.

```python
sq.gr.spatial_neighbors(adata, coord_type="generic", n_neighs=6)
# adata.obsp["spatial_connectivities"] now has the spot adjacency
```

For **Visium**, use `coord_type="grid"`. For Xenium / MERFISH, use
`"generic"` and choose `n_neighs` (typically 6) or a `radius` in coord units.

---

## 5. Spatially-Variable Genes (SVGs)

Genes whose expression depends on tissue location, beyond what the
expression-clusters alone explain.

```python
# Moran's I -- spatial autocorrelation per gene
sq.gr.spatial_autocorr(adata, mode="moran", n_perms=100, n_jobs=4)
top_svg = adata.uns["moranI"].sort_values("I", ascending=False).head(20)
```

| Method | Tool | Cost | Notes |
|--------|------|------|-------|
| Moran's I / Geary's C | `squidpy.gr.spatial_autocorr` | Cheap | Global autocorrelation; default first pass |
| sepal | `squidpy.gr.sepal` | Moderate | Diffusion-based; sensitive to local patterns |
| SpatialDE / SpatialDE2 | Standalone | Slow | Gaussian-process; statistical rigour |
| SPARK / SPARK-X | R | Fast (SPARK-X) | Atlas-scale SVG screening |

---

## 6. Domain / Niche Identification

Cluster spots by both their expression *and* their spatial position to
recover histology-like domains.

| Tool | Approach | Best For |
|------|----------|----------|
| `BayesSpace` | Bayesian + spot adjacency prior | Visium spot enhancement + clustering |
| `STAGATE` | Graph attention autoencoder | Imaging + Visium, multi-slide |
| `GraphST` | Contrastive graph learning | Multi-section integration |
| `SpaGCN` | GCN on spatial+expression graph | Lightweight first pass |

```python
# Quick domains via squidpy spatial neighbors + Leiden
sq.gr.spatial_neighbors(adata, coord_type="grid")
sc.pp.neighbors(adata, n_neighbors=15)  # expression kNN
sc.tl.leiden(adata, resolution=0.4, key_added="domains")
sc.pl.spatial(adata, color="domains")
```

---

## 7. Spot Deconvolution (Sequencing-Based)

Visium spots cover ~1-10 cells; their expression is a mixture. Deconvolve
into single-cell-type proportions using a matched scRNA-seq reference.

| Tool | Speed | Strength |
|------|-------|----------|
| `cell2location` | Slow (GPU) | Bayesian, well-calibrated; per-spot uncertainty |
| `RCTD` (`spacexr` in R) | Fast | Doublet-aware; robust on most tissues |
| `Tangram` | Fast | Probabilistic mapping; flexible |
| `Stereoscope` | Slow | scvi-tools native |

```python
# cell2location -- abridged
import cell2location as c2l
c2l.models.RegressionModel.setup_anndata(adata_ref, batch_key="sample",
                                          labels_key="celltype")
mod = c2l.models.RegressionModel(adata_ref); mod.train(max_epochs=250)
adata_ref = mod.export_posterior(adata_ref)

c2l.models.Cell2location.setup_anndata(adata_vis, batch_key="sample")
mod_v = c2l.models.Cell2location(adata_vis,
    cell_state_df=adata_ref.varm["means_per_cluster_mu_fg"],
    N_cells_per_location=8, detection_alpha=20)
mod_v.train(max_epochs=20000)
adata_vis = mod_v.export_posterior(adata_vis)
```

> [!TIP]
> Always use a **matched** scRNA-seq reference -- same tissue, ideally same
> donor or species/condition. Cross-tissue references silently produce
> incorrect compositions even when they appear to converge.

---

## 8. Cell-Cell Signaling in Space

| Tool | Approach |
|------|----------|
| `squidpy.gr.ligrec` | Permutation test on neighboring-spot ligand-receptor pairs |
| `CellChat` v2 (R) | Spatial extension; signaling-pathway level |
| `COMMOT` | Optimal-transport-based; explicit spatial cost |
| `NicheNet` (R) | Receptor -> downstream regulon prediction |
| `LIANA+` | Consensus across single-cell / spatial methods |

```python
# squidpy ligand-receptor on neighboring spots
sq.gr.spatial_neighbors(adata)
sq.gr.ligrec(adata, cluster_key="domains", n_perms=1000,
             interactions_params={"resources": "CellPhoneDB"})
```

---

## Quick Reference: Minimal Visium -> Squidpy Workflow

```python
import scanpy as sc, squidpy as sq

# 1. Load
adata = sc.read_visium("spaceranger/outs/")
adata.var_names_make_unique()
adata.var["mt"] = adata.var_names.str.startswith("MT-")
sc.pp.calculate_qc_metrics(adata, qc_vars=["mt"], inplace=True)

# 2. Normalize + cluster
adata.layers["counts"] = adata.X.copy()
sc.pp.normalize_total(adata); sc.pp.log1p(adata)
sc.pp.highly_variable_genes(adata, n_top_genes=2000, flavor="seurat_v3",
                             layer="counts")
sc.pp.pca(adata); sc.pp.neighbors(adata); sc.tl.umap(adata)
sc.tl.leiden(adata, resolution=0.5, key_added="domains", flavor="igraph")

# 3. Spatial graph + SVGs
sq.gr.spatial_neighbors(adata, coord_type="grid")
sq.gr.spatial_autocorr(adata, mode="moran", n_perms=100, n_jobs=4)
top_svg = adata.uns["moranI"].head(20).index.tolist()

# 4. Visualize
sc.pl.spatial(adata, color=["domains", *top_svg[:4]])

# 5. Neighborhood enrichment + ligand-receptor
sq.gr.nhood_enrichment(adata, cluster_key="domains")
sq.pl.nhood_enrichment(adata, cluster_key="domains")
sq.gr.ligrec(adata, cluster_key="domains", n_perms=1000)

adata.write_h5ad("visium_processed.h5ad")
```

---

## Best Practices

1. **Build the spatial neighbor graph explicitly.** Most spatial methods (autocorrelation, ligand-receptor, domain identification) consume `obsp["spatial_connectivities"]`; do not skip `sq.gr.spatial_neighbors`.
2. **Use a matched reference for deconvolution.** Cross-tissue or cross-species references give plausible-looking but biased compositions.
3. **Don't apply scRNA-seq QC thresholds blindly.** Visium spots are not single cells; aggressive `n_genes_by_counts` cutoffs strip biologically sparse regions.
4. **Visualize on the H&E image** when available -- `sc.pl.spatial(adata, ...)` overlays domains on tissue, which makes histological errors immediately obvious.
5. **For multi-slide datasets, integrate first** (Harmony or scVI on the expression embedding) before clustering domains; otherwise domain labels are slide-specific.
6. **Imaging-based platforms need their own segmentation QC** -- check transcript/cell counts and segmentation confidence; cells with very few transcripts are usually segmentation artefacts, not biology.

---
name: pathway-analysis
description: Pathway and gene-set enrichment for any expression dataset (bulk RNA-seq, scRNA-seq, ChIP-seq targets) -- ORA, GSEA, single-sample scoring, and the major pathway databases. Use after a DE result, marker list, or peak-target list.
---

# Pathway and Gene-Set Enrichment

Translating gene lists / ranked statistics into biological interpretation.

**Sources**:
- MSigDB / GSEA: [https://www.gsea-msigdb.org](https://www.gsea-msigdb.org)
- Subramanian et al. 2005 (PNAS) -- the original GSEA paper
- decoupler-py docs: [https://decoupler-py.readthedocs.io](https://decoupler-py.readthedocs.io)

---

## 1. Databases

| Database | Coverage | Notes |
|----------|----------|-------|
| MSigDB Hallmarks (`H`) | 50 curated pathways | Default first pass; broad biology |
| MSigDB Curated (`C2`) | KEGG, Reactome, Biocarta, WikiPathways, chemical/genetic perturbations | Most useful single bucket |
| MSigDB Regulatory (`C3`) | TF and miRNA targets | TF-activity inference |
| MSigDB Immunologic (`C7`) | Curated immune signatures | Immune contexts |
| GO BP / MF / CC | Process / function / location | Comprehensive but redundant; needs hierarchy collapse |
| KEGG Pathways | Canonical signaling/metabolic | Compact; good visualizations (pathview) |
| Reactome | Detailed signaling hierarchy | More granular than KEGG |
| WikiPathways | Community curated | Strong for human disease, growing |

> [!TIP]
> For a generic first pass, run **MSigDB Hallmarks** + **Reactome** (or KEGG).
> Adding GO BP at the end is fine, but expect highly redundant terms -- use
> `simplify()` (clusterProfiler) or `enrichplot::pairwise_termsim` to collapse.

---

## 2. Methods

| Method | Input | Test | Output |
|--------|-------|------|--------|
| ORA (Over-Representation) | Gene **list** + background | Hypergeometric / Fisher's exact | One p-value per gene set |
| GSEA | Ranked gene **list** (e.g., DE log2FC * -log10 p) | Weighted Kolmogorov-Smirnov | NES + p / FDR per gene set |
| ssGSEA / GSVA | Expression **matrix** | Per-sample rank-based score | Sample x pathway matrix |
| decoupleR (mlm/ulm/wsum) | Per-cell or sample stat matrix | Linear / weighted models | Per-observation activity scores |
| AUCell | Per-cell expression | AUC of gene set in ranked genes | Per-cell score |
| `score_genes` (scanpy) | Per-cell expression | Mean - background mean | Per-cell score |

### When to Use Which

- **ORA** -- you have a *list* (e.g., genes with FDR<0.05 + |LFC|>1, or peak-annotated genes). Cheapest. Sensitive to threshold choice.
- **GSEA** -- you have *all* genes with a rankable statistic. Avoids the threshold problem. The default for any DE workflow.
- **ssGSEA / GSVA** -- you want a *per-sample* (or per-cluster pseudobulk) pathway-activity matrix to feed into PCA, clustering, survival analysis.
- **decoupleR / AUCell** -- single-cell pathway / TF activity per cell, for visualization on UMAP or per-cluster.

---

## 3. Background Gene Sets -- Critical Gotcha

ORA p-values depend on the **background**. The wrong background fabricates significance.

> [!WARNING]
> Use the set of genes that *could have been detected* in your experiment, not
> the entire genome. For RNA-seq, that is the genes that passed your expression
> filter (e.g., `rowSums(counts >= 10) >= 3`). For ChIP-seq target genes, it is
> all genes within the universe assigned to peaks (or, for GREAT, handled
> automatically). Default "all human genes" backgrounds inflate the
> hypergeometric tail dramatically.

GSEA does not have this problem because every gene is ranked, not threshold-selected.

---

## 4. Multiple Testing

- Always report **adjusted p-values** (Benjamini-Hochberg FDR is standard).
- For GSEA, the standard cutoff is **FDR q < 0.25** *for hypothesis generation*,
  q < 0.05 for confident calls -- this differs from per-gene DE conventions
  because gene sets are correlated.
- Run ORA across multiple ontologies in one call (clusterProfiler / enrichR)
  rather than separately, so adjustment scales correctly.

---

## 5. Python -- gseapy + decoupler

### gseapy (GSEA / ORA / ssGSEA / Prerank)

```python
import gseapy as gp

# Prerank GSEA -- input: DE gene-level statistics
rnk = de_df.assign(metric=de_df["log2FC"] * -de_df["padj"].apply(np.log10)) \
           [["gene", "metric"]].sort_values("metric", ascending=False)

pre = gp.prerank(rnk=rnk,
                 gene_sets="MSigDB_Hallmark_2020",
                 outdir="gsea_out",
                 min_size=10, max_size=500,
                 permutation_num=1000, seed=0)
print(pre.res2d.head())
gp.gseaplot(rank_metric=pre.ranking, term=pre.res2d.Term[0],
            **pre.results[pre.res2d.Term[0]])
```

```python
# ORA on a gene list (Enrichr-style)
hits = de_df.query("padj < 0.05 & log2FC > 1")["gene"].tolist()
bg = de_df["gene"].tolist()                       # use the tested universe!
ora = gp.enrichr(gene_list=hits, background=bg,
                 gene_sets=["MSigDB_Hallmark_2020", "Reactome_2022"],
                 outdir="ora_out", organism="human")
```

### decoupler-py (single-cell or pseudobulk activity)

```python
import decoupler as dc

# Pull MSigDB Hallmarks as a long-form network
msigdb = dc.get_resource("MSigDB")
hallmarks = msigdb[msigdb["collection"] == "hallmark"]
hallmarks = hallmarks.rename(columns={"geneset": "source", "genesymbol": "target"})

# Per-cell activity (uses log-norm adata.X)
dc.run_ulm(mat=adata, net=hallmarks, source="source", target="target",
            min_n=5, use_raw=False)
acts = dc.get_acts(adata, obsm_key="ulm_estimate")
sc.pl.umap(acts, color=["HALLMARK_INTERFERON_ALPHA_RESPONSE"])
```

```python
# scanpy gene-set scoring -- simplest per-cell signature
sc.tl.score_genes(adata, gene_list=ifn_alpha_geneset, score_name="IFN_alpha")
```

---

## 6. R -- clusterProfiler + fgsea

### fgsea -- Fast GSEA

```r
library(fgsea); library(msigdbr)

# Build gene-set list from MSigDB
m_h <- msigdbr(species = "Homo sapiens", category = "H")
pathways <- split(m_h$gene_symbol, m_h$gs_name)

# Ranked stat from DESeq2 / edgeR / limma
ranks <- de$log2FoldChange * -log10(de$pvalue)
names(ranks) <- de$gene
ranks <- sort(ranks, decreasing = TRUE)

fg <- fgsea(pathways = pathways, stats = ranks, minSize = 10, maxSize = 500)
fg <- fg[order(padj)]
plotEnrichment(pathways[[fg$pathway[1]]], ranks)
```

### clusterProfiler -- ORA + GSEA + Visualizations

```r
library(clusterProfiler); library(org.Hs.eg.db)

# ORA on DE genes (KEGG)
hits <- de$entrez[de$padj < 0.05 & de$log2FoldChange > 1]
bg   <- de$entrez   # the tested universe
ek <- enrichKEGG(gene = hits, universe = bg, organism = "hsa", pAdjustMethod = "BH")
dotplot(ek, showCategory = 15)

# GSEA on a ranked vector (Reactome via ReactomePA)
library(ReactomePA)
gp <- gsePathway(geneList = ranks, organism = "human", pAdjustMethod = "BH")
emapplot(pairwise_termsim(gp))
```

### enrichR -- One-Liner Across Many Libraries

```r
library(enrichR)
dbs <- c("MSigDB_Hallmark_2020", "Reactome_2022", "GO_Biological_Process_2023")
res <- enrichr(genes = hits, databases = dbs)
```

---

## 7. Single-Sample Scoring -- GSVA / ssGSEA

For a per-sample (or per-pseudobulk-cluster) pathway-activity matrix.

```r
library(GSVA); library(msigdbr)

m_h <- msigdbr(species = "Homo sapiens", category = "H")
gsets <- split(m_h$gene_symbol, m_h$gs_name)

# expr: log2(TPM+1) or vst-normalized matrix; rownames = gene symbols
gsva_par <- gsvaParam(exprData = expr, geneSets = gsets, kcdf = "Gaussian")
es <- gsva(gsva_par)        # pathway x sample matrix
heatmap(es)
```

---

## Quick Reference: Side-by-Side fgsea (R) and gseapy (Python)

```r
# R: fgsea on DESeq2 results
library(fgsea); library(msigdbr)
m_h <- msigdbr(species = "Homo sapiens", category = "H")
pathways <- split(m_h$gene_symbol, m_h$gs_name)
ranks <- with(res, sign(log2FoldChange) * -log10(pvalue))
names(ranks) <- res$symbol
ranks <- sort(ranks[!is.na(ranks)], decreasing = TRUE)
fg <- fgsea(pathways, ranks, minSize = 10, maxSize = 500)
head(fg[order(padj)], 10)
```

```python
# Python: gseapy on the same DE table
import gseapy as gp, numpy as np
ranks = (np.sign(de.log2FoldChange) * -np.log10(de.pvalue)).rename("metric")
rnk   = ranks.dropna().sort_values(ascending=False).reset_index()
pre = gp.prerank(rnk=rnk, gene_sets="MSigDB_Hallmark_2020",
                 min_size=10, max_size=500, permutation_num=1000)
pre.res2d.head(10)
```

---

## Best Practices

1. **Match the test to the input.** A ranked statistic -> GSEA; a thresholded list -> ORA. Don't binarize a perfectly good ranking just to run ORA.
2. **Use the tested universe as the ORA background**, not "all genes". This is the single most common analysis error in pathway enrichment.
3. **Start with Hallmarks + Reactome (or KEGG).** Add GO BP last and collapse redundant terms (`simplify`, `pairwise_termsim`).
4. **Report adjusted p-values** (BH FDR). Use q < 0.05 for confident calls; q < 0.25 is acceptable for GSEA hypothesis generation per the Broad guidelines.
5. **Don't over-trust gene-symbol matching.** MSigDB ships HUGO symbols; if your DE table uses Ensembl IDs, map first, and beware of one-to-many collapses.
6. **For single-cell, prefer activity inference (decoupler / AUCell)** over per-cluster ORA on marker genes -- you keep the full ranking and avoid the threshold problem.

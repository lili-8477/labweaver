---
name: chip-seq
description: ChIP-seq and CUT&RUN/CUT&Tag analysis -- peak calling, motif analysis, differential binding, and peak annotation. Use for any protein-DNA interaction experiment (transcription factors, histone marks, chromatin remodelers).
---

# ChIP-seq / CUT&RUN / CUT&Tag Analysis

End-to-end protein-DNA interaction analysis: from FASTQ to annotated peaks
and differential binding sites.

**Source**: [https://www.encodeproject.org](https://www.encodeproject.org)
(ENCODE consortium ChIP-seq pipelines and standards).

---

## 1. Experimental Modalities

| Assay | Antibody Use | Cells Required | Background | Resolution | Best For |
|-------|--------------|----------------|------------|------------|----------|
| ChIP-seq | IP from cross-linked chromatin | 1-10 M | High | ~200 bp | Bulk samples, classical TF/histone profiling |
| CUT&RUN | pA-MNase tethered to antibody | 100-500 K | Very low | ~50-100 bp | Limited material, sharp factors |
| CUT&Tag | pA-Tn5 tethered to antibody | 1-100 K | Very low | ~50 bp | Single-cell or low-input; native chromatin |

### Key Distinctions

- **ChIP-seq** uses formaldehyde cross-linking and sonication. Highest historical
  validation but needs a matched **input control** (or IgG) for peak calling
  to model background.
- **CUT&RUN / CUT&Tag** are *in situ* methods. The signal-to-noise is much higher
  than ChIP-seq, so genomic background is sparse and conventional ChIP peak callers
  over-call. Use **SEACR** or MACS2 with `--nomodel --nolambda` for CUT&RUN.
- Histone marks split into **narrow** (H3K4me3, H3K27ac, most TFs) vs **broad**
  (H3K27me3, H3K9me3, H3K36me3) -- choose the matching peak-caller mode.

> [!TIP]
> If you only have a few hundred thousand cells or want native chromatin,
> CUT&Tag is the modern default. For published TF datasets and antibody validation,
> classical ChIP-seq remains the lingua franca.

---

## 2. Preprocessing

| Step | Tool | Notes |
|------|------|-------|
| Adapter/quality trim | `fastp`, `Trim Galore` | Paired-end CUT&RUN especially benefits from trimming short fragments. |
| Alignment | `bwa mem` (TFs), `bowtie2 --very-sensitive` (CUT&RUN/Tag) | bowtie2 with `-X 700 --no-mixed --no-discordant` is the CUT&Tag default. |
| Filter | `samtools view -q 30 -F 1804`, `Picard MarkDuplicates` | Drop multi-mappers, duplicates, unmapped, secondary. |
| Blacklist | ENCODE blacklist (`hg38-blacklist.v2.bed`) | Always `bedtools intersect -v` against blacklist before peak calling. |

```bash
# Trim and align (paired-end CUT&RUN)
fastp -i R1.fq.gz -I R2.fq.gz -o R1.trim.fq.gz -O R2.trim.fq.gz
bowtie2 --very-sensitive --no-mixed --no-discordant -X 700 \
  -x /ref/bowtie2/hg38 -1 R1.trim.fq.gz -2 R2.trim.fq.gz \
  | samtools sort -@ 8 -o sample.bam -
samtools index sample.bam

# Filter
samtools view -bq 30 -F 1804 sample.bam \
  | samtools sort -o sample.filt.bam
picard MarkDuplicates I=sample.filt.bam O=sample.dedup.bam M=dup.metrics REMOVE_DUPLICATES=true
```

> [!WARNING]
> Drosophila or E. coli **spike-in** reads (standard for CUT&RUN/Tag) must be aligned
> separately and used for normalization. Using simple read-count normalization on
> samples with spike-ins discards the only quantitative anchor between conditions.

---

## 3. Peak Calling

### MACS2 / MACS3 -- ChIP-seq Default

```bash
# Narrow peaks (TFs, H3K4me3, H3K27ac)
macs3 callpeak -t treat.dedup.bam -c input.dedup.bam \
  -f BAMPE -g hs -n sample --outdir peaks/

# Broad peaks (H3K27me3, H3K9me3, H3K36me3)
macs3 callpeak -t treat.dedup.bam -c input.dedup.bam \
  -f BAMPE -g hs --broad --broad-cutoff 0.1 -n sample_broad
```

### SEACR -- CUT&RUN / CUT&Tag Default

SEACR is designed for sparse CUT&RUN signal. It uses bedgraph fragment density,
not BAMs.

```bash
# Generate fragment bedgraph
bedtools bamtobed -bedpe -i sample.dedup.bam > frag.bedpe
awk '$1==$4 && $6-$2 < 1000 {print $1"\t"$2"\t"$6}' frag.bedpe > frag.bed
bedtools genomecov -bg -i frag.bed -g hg38.chrom.sizes > sample.bg

# Stringent (peak vs IgG control)
bash SEACR_1.3.sh sample.bg igg.bg non stringent sample.seacr
```

### Peak-Caller Selection

| Signal | Tool | Mode |
|--------|------|------|
| TF / sharp histone mark, ChIP-seq | MACS3 | `callpeak` (narrow) |
| Broad histone (H3K27me3, H3K9me3) | MACS3 | `--broad` |
| CUT&RUN, sparse background | SEACR | `stringent` (with IgG) or `relaxed` (no control) |
| CUT&Tag | MACS3 `--nomodel --nolambda` or SEACR | Either |

---

## 4. QC Metrics

| Metric | Tool | Acceptable Range | Meaning |
|--------|------|------------------|---------|
| FRiP | `featureCounts` over peaks | TFs >1%, marks >5% | Fraction of reads in peaks; signal concentration. |
| NSC / RSC | `phantompeakqualtools` | NSC >1.05, RSC >0.8 | Cross-correlation strand-shift; library complexity. |
| Library complexity (NRF / PBC) | `ATAQV`, ENCODE scripts | NRF >0.8, PBC1 >0.7 | Distinct vs total reads. |
| Replicate concordance | `deeptools multiBigwigSummary` + `plotCorrelation` | Pearson >0.8 | Replicates should cluster tightly. |

```bash
# FRiP (fraction of reads in peaks)
bedtools intersect -a sample.dedup.bam -b peaks.narrowPeak -u | samtools view -c
```

---

## 5. Visualization

```bash
# Generate normalized bigwig (CPM-normalized) for IGV / deepTools
bamCoverage -b sample.dedup.bam -o sample.bw --normalizeUsing CPM \
  --binSize 10 --extendReads --blackListFileName hg38-blacklist.v2.bed

# Profile / heatmap around TSS
computeMatrix reference-point -S sample.bw -R tss.bed \
  -a 3000 -b 3000 --referencePoint center -o matrix.gz
plotHeatmap -m matrix.gz -o tss_heatmap.png --colorMap viridis
```

> [!TIP]
> For multi-sample comparisons, *always* normalize bigwigs the same way (CPM or RPGC
> with effective genome size). For spike-in experiments, use `--scaleFactor` derived
> from spike-in read counts instead of CPM.

---

## 6. Peak Annotation

### ChIPseeker (R) -- Annotate to Nearest Gene

```r
library(ChIPseeker)
library(TxDb.Hsapiens.UCSC.hg38.knownGene)
library(org.Hs.eg.db)

txdb <- TxDb.Hsapiens.UCSC.hg38.knownGene
peaks <- readPeakFile("sample.narrowPeak")
peakAnno <- annotatePeak(peaks, TxDb = txdb, level = "gene",
                          annoDb = "org.Hs.eg.db",
                          tssRegion = c(-3000, 3000))
plotAnnoBar(peakAnno)
plotDistToTSS(peakAnno)
```

### GREAT -- Cis-Regulatory Region Enrichment

GREAT extends each peak to a regulatory domain (~5-1000 kb) and tests
ontology enrichment. Best for distal enhancer marks (H3K27ac, H3K4me1)
where nearest-gene assignment is misleading. Use the
[GREAT web service](http://great.stanford.edu) or the
`rGREAT` Bioconductor package.

```r
library(rGREAT)
job <- submitGreatJob(peaks, species = "hg38")
tb <- getEnrichmentTables(job, ontology = "GO Biological Process")
```

---

## 7. Motif Discovery

### MEME Suite -- *de novo* + Known Motifs

```bash
# Extract sequences under top peaks (ranked by signal)
sort -k7,7nr sample.narrowPeak | head -1000 \
  | bedtools getfasta -fi hg38.fa -bed - > top_peaks.fa

# de novo discovery
meme top_peaks.fa -dna -nmotifs 5 -maxw 15 -oc meme_out

# Match to known motif databases (JASPAR)
tomtom -oc tomtom_out meme_out/meme.txt JASPAR2024_CORE.meme
```

### HOMER -- Fast and Opinionated

```bash
findMotifsGenome.pl peaks.bed hg38 motif_out/ -size 200 -mask
```

> [!TIP]
> Always centre peak windows on the **summit** (column 10 of MACS narrowPeak),
> not the full peak interval. Motif density drops sharply away from the summit.

---

## 8. Differential Binding

### DiffBind -- Sample-Sheet Driven

```r
library(DiffBind)
samples <- read.csv("samplesheet.csv")  # SampleID, Condition, Replicate, bamReads, Peaks
dba <- dba(sampleSheet = samples)
dba <- dba.count(dba, summits = 250)
dba <- dba.normalize(dba)
dba <- dba.contrast(dba, categories = DBA_CONDITION, minMembers = 2)
dba <- dba.analyze(dba, method = DBA_DESEQ2)
db_sites <- dba.report(dba, th = 0.05)
```

### csaw -- Window-Based for Broad Marks

`csaw` slides windows across the genome, counts reads, then uses edgeR
for differential testing. Recommended for diffuse marks (H3K27me3) where
fixed peak intervals are unreliable.

| Tool | Approach | Best For |
|------|----------|----------|
| DiffBind | Consensus peakset + count | TFs, sharp histone marks, n>=3 per group |
| csaw | Sliding-window count + edgeR | Broad marks, no clean peak boundaries |
| MAnorm2 | Hierarchical normalization | Cross-study / cross-condition without spike-in |

---

## Quick Reference: Minimal MACS3 + ChIPseeker Workflow

```bash
# 1. Align + filter (paired-end TF ChIP)
bwa mem -t 8 hg38.fa R1.fq.gz R2.fq.gz \
  | samtools sort -@ 4 -o sample.bam -
samtools index sample.bam
samtools view -bq 30 -F 1804 sample.bam \
  | picard MarkDuplicates I=/dev/stdin O=sample.dedup.bam M=dup.txt REMOVE_DUPLICATES=true

# 2. Peak calling (narrow, with input control)
macs3 callpeak -t sample.dedup.bam -c input.dedup.bam \
  -f BAMPE -g hs -n sample --outdir peaks/

# 3. Blacklist filter
bedtools intersect -a peaks/sample_peaks.narrowPeak \
  -b hg38-blacklist.v2.bed -v > peaks/sample.filt.narrowPeak

# 4. Coverage track
bamCoverage -b sample.dedup.bam -o sample.bw --normalizeUsing CPM --extendReads
```

```r
# 5. Annotate
library(ChIPseeker); library(TxDb.Hsapiens.UCSC.hg38.knownGene)
peakAnno <- annotatePeak("peaks/sample.filt.narrowPeak",
                          TxDb = TxDb.Hsapiens.UCSC.hg38.knownGene,
                          tssRegion = c(-3000, 3000),
                          annoDb = "org.Hs.eg.db")
write.csv(as.data.frame(peakAnno), "peaks/sample.annotated.csv")
```

---

## Best Practices

1. **Match peak-caller to assay.** MACS3 narrow for TFs/H3K4me3, MACS3 `--broad` for repressive marks, SEACR for CUT&RUN. Wrong mode means wrong peaks.
2. **Always include a control.** Input chromatin for ChIP-seq, IgG for CUT&RUN/Tag. Peak callers without controls drastically inflate FDR.
3. **Apply the ENCODE blacklist** before peak calling and downstream analysis -- a handful of pathological regions otherwise dominate every dataset.
4. **Spike-in normalize** when comparing conditions in CUT&RUN/Tag, or when global signal levels are expected to change (e.g., HDAC inhibition).
5. **Centre on summits**, not peak midpoints, for motif analysis and heatmaps.
6. **Replicate first.** Two biological replicates per condition is the minimum; three is the recommendation for differential binding.

## Quarantine — 2026-08-28T11:55:45-06:00

Moved out of li86/local_projects for the duration of the run:
- A8163_mSS
- A8608_mSS
- ihc-demo__mSS_SCRNAseq
- mSS_SCRNAseq
- srt-for-monocle3-7bda

Extra hit found by the Step 4 grep, not among the four originally named directories:
- ihc-demo/mSS_SCRNAseq/ (moved into quarantine as ihc-demo__mSS_SCRNAseq) — a scaffold-only progress.md nested inside the unrelated ihc-demo (QuPath IHC demo) project. No results/derived data present, but it named the exact A8163_mSS CHPC FASTQ path, the mSS-specific reference-genome/transgene flags, and the project name "mSS_SCRNAseq" — i.e. it points at the quarantined dataset/object, so it was quarantined too rather than left as a partial answer key.

// The facet key catalogue (spec §4.2), dependency-free so the memory
// contract (memory-contract.ts) can share it with the adapter and frontend.
// facets.ts holds the logic and re-exports these.

export const BIOLOGY_KEYS  = ["species", "model", "cell_line", "tissue", "sample", "cohort"] as const;
export const METHOD_KEYS   = [
  "assay", "protocol", "protocol_version", "reagent_lot", "instrument", "run_id", "dose", "timepoint",
] as const;
export const ANALYSIS_KEYS = [
  "dataset", "dataset_version", "reference", "pipeline", "pipeline_version", "code_version",
] as const;
export const LEGACY_KEYS   = ["gene", "tool", "file"] as const;

export const FACET_KEYS = [...BIOLOGY_KEYS, ...METHOD_KEYS, ...ANALYSIS_KEYS, ...LEGACY_KEYS] as const;

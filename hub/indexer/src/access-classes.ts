// Access classes of memory and evidence, least to most restricted (spec §4.4).
// A viewer's clearance is one of these; they see what is at or below it.
// Dependency-free so the distill schema and the memory contract can share it.

export const ACCESS_ORDER = ["public", "internal", "restricted", "irb"] as const;
export type AccessClass = (typeof ACCESS_ORDER)[number];

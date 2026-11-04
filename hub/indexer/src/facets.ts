// Facet catalogue for scientific memory (spec §4.2). memory_facets(key, value)
// holds these; retrieval uses them as hard filters and as the exact-ID arm.
import { createHash } from "node:crypto";

import { ANALYSIS_KEYS, BIOLOGY_KEYS, FACET_KEYS, LEGACY_KEYS, METHOD_KEYS } from "./facet-keys.js";

export { ANALYSIS_KEYS, BIOLOGY_KEYS, FACET_KEYS, LEGACY_KEYS, METHOD_KEYS };

// The keys that describe the conditions of an experiment. Two claims about the
// same subject with different values here are not comparable (§5.3).
export const CONDITION_KEYS: readonly string[] = [...BIOLOGY_KEYS, ...METHOD_KEYS];

// Version keys: a newer value under the same condition key may supersede.
// protocol_version is also a condition key, so it is excluded from the
// condition key hash (otherwise a protocol bump could never supersede).
export const VERSION_KEYS = ["protocol_version", "pipeline_version", "code_version", "dataset_version"] as const;

export type Facets = Record<string, string[] | undefined>;

// Lower-case and trim every value; gene symbols keep their case. Drops empty
// values and duplicates.
export function normalizeFacets(facets: Facets): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, vs] of Object.entries(facets)) {
    if (!vs) continue;
    const norm = [...new Set(
      vs.map((v) => (k === "gene" ? v.trim() : v.trim().toLowerCase())).filter((v) => v.length > 0),
    )];
    if (norm.length > 0) out[k] = norm.sort();
  }
  return out;
}

// sha256 over the subject and the sorted condition facets (version keys
// excluded). Deterministic: the same subject under the same conditions
// always gives the same key.
export function conditionKey(subject: string, facets: Record<string, string[]>): Buffer {
  const parts = CONDITION_KEYS
    .filter((k) => !(VERSION_KEYS as readonly string[]).includes(k) && facets[k]?.length)
    .map((k) => `${k}=${facets[k]!.join(",")}`);
  return createHash("sha256").update(`${subject.trim().toLowerCase()}\n${parts.join("\n")}`).digest();
}

// Condition facets on which two rows differ. A key present on one side only
// does not count: an unspecified condition is unknown, not different.
export function differingConditions(a: Record<string, string[]>, b: Record<string, string[]>): string[] {
  return CONDITION_KEYS.filter((k) =>
    a[k]?.length && b[k]?.length && a[k]!.join(",") !== b[k]!.join(","));
}

// Compare version strings numerically where possible ("v1.10" > "v1.9").
// Returns >0 when a is newer.
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, "").split(/[.\-_]/);
  const pb = b.replace(/^v/i, "").split(/[.\-_]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "", y = pb[i] ?? "";
    const nx = Number(x), ny = Number(y);
    const c = x !== "" && y !== "" && Number.isFinite(nx) && Number.isFinite(ny)
      ? nx - ny
      : x.localeCompare(y);
    if (c !== 0) return c;
  }
  return 0;
}

// True when `newer` has a strictly newer value for at least one version key
// both rows carry, and an older value for none.
export function hasNewerVersion(newer: Record<string, string[]>, older: Record<string, string[]>): boolean {
  let up = false;
  for (const k of VERSION_KEYS) {
    const n = newer[k]?.[0], o = older[k]?.[0];
    if (n === undefined || o === undefined) continue;
    const c = compareVersions(n, o);
    if (c < 0) return false;
    if (c > 0) up = true;
  }
  return up;
}

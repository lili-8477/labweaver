// Pure helpers for scientific claims: body rendering and the reconcile
// decision (spec §5.3). No I/O; distiller-repo.ts does the reads and writes.
import { differingConditions, hasNewerVersion } from "./facets.js";

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function kv(rec: Record<string, unknown> | undefined): string {
  return Object.entries(rec ?? {}).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`).join("; ");
}

// The searchable text of a claim: statement first, then the conditions and
// numbers an exact-ID query or FTS should hit.
export function renderClaimBody(c: {
  statement:   string;
  conditions:  Record<string, string[]>;
  parameters?: Record<string, unknown>;
  inputs?:     string[];
  outputs?:    string[];
  qc?:         { status: string; metrics?: Record<string, unknown> };
}): string {
  const lines = [c.statement];
  if (Object.keys(c.conditions).length) lines.push(`Conditions: ${kv(c.conditions)}`);
  if (c.parameters && Object.keys(c.parameters).length) lines.push(`Parameters: ${kv(c.parameters)}`);
  if (c.inputs?.length) lines.push(`Inputs: ${c.inputs.join("; ")}`);
  if (c.outputs?.length) lines.push(`Outputs: ${c.outputs.join("; ")}`);
  if (c.qc) lines.push(`QC: ${c.qc.status}${c.qc.metrics ? ` (${kv(c.qc.metrics)})` : ""}`);
  return lines.join("\n");
}

export function renderExperienceBody(e: {
  task: string; solution: string; applicability: string[];
  boundary_conditions: string[]; failure_modes: string[];
  expected_qc: Record<string, unknown>;
}): string {
  const lines = [`Task: ${e.task}`, `Solution: ${e.solution}`, `Applies when: ${e.applicability.join("; ")}`];
  if (e.boundary_conditions.length) lines.push(`Boundaries: ${e.boundary_conditions.join("; ")}`);
  if (e.failure_modes.length) lines.push(`Failure modes: ${e.failure_modes.join("; ")}`);
  if (Object.keys(e.expected_qc).length) lines.push(`Expected QC: ${kv(e.expected_qc)}`);
  return lines.join("\n");
}

export interface NewClaim {
  username:      string;
  condition_key: Buffer;
  facets:        Record<string, string[]>;
  observed_at:   Date;
}

export interface Candidate {
  memory_id:     string;
  username:      string;
  condition_key: Buffer | null;
  facets:        Record<string, string[]>;
  observed_at:   Date;           // observed_at, else created_at
  sim:           number | null;  // cosine similarity; null when not embedded
}

export interface ReconcileDecision {
  // Set when the new claim repeats an existing one: nothing is written.
  duplicate_of: string | null;
  supersedes:   string[];
  qualifies:    Array<{ memory_id: string; differs_on: string[] }>;
  // Same conditions, different statement, no version change: the agent
  // labels these SUPPORTS or CONTRADICTS with memory_link.
  related:      Array<{ memory_id: string; sim: number | null }>;
}

// Decide what writing `n` does to its candidates. Only same-condition rows
// can be superseded, and only by the same author with a newer version and a
// later observation. Rows under other conditions are qualified, never
// superseded: the conditions explain the difference.
export function decideReconcile(
  n: NewClaim,
  candidates: Candidate[],
  duplicateSimilarity: number,
): ReconcileDecision {
  const d: ReconcileDecision = { duplicate_of: null, supersedes: [], qualifies: [], related: [] };
  for (const c of candidates) {
    const sameConditions = c.condition_key !== null && c.condition_key.equals(n.condition_key);
    if (sameConditions) {
      if (c.username === n.username && hasNewerVersion(n.facets, c.facets)
          && n.observed_at.getTime() > c.observed_at.getTime()) {
        d.supersedes.push(c.memory_id);
      } else if (c.sim !== null && c.sim >= duplicateSimilarity
                 && !hasNewerVersion(n.facets, c.facets) && !hasNewerVersion(c.facets, n.facets)) {
        if (d.duplicate_of === null) d.duplicate_of = c.memory_id;
      } else {
        d.related.push({ memory_id: c.memory_id, sim: c.sim });
      }
      continue;
    }
    const differs_on = differingConditions(n.facets, c.facets);
    if (differs_on.length > 0) d.qualifies.push({ memory_id: c.memory_id, differs_on });
    else d.related.push({ memory_id: c.memory_id, sim: c.sim });
  }
  if (d.duplicate_of !== null) return { duplicate_of: d.duplicate_of, supersedes: [], qualifies: [], related: [] };
  return d;
}

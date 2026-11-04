// memory_context: a cited context bundle for one task (spec §6). Search with
// hard filters, then decorate the hits with conditions, evidence, lineage
// and current versions. Zero LLM calls. Lineage and graph rerank are
// fail-open: an error there returns the plain search result.
import type { Pool } from "pg";
import type { AccessClass } from "./access-classes.js";
import { logger } from "./config.js";
import { CONDITION_KEYS, compareVersions } from "./facets.js";
import { lineageOf, type EdgeRel, type LineageEdge } from "./lineage-repo.js";
import { DEFAULT_CLEARANCE, visibleSql } from "./memory-access.js";
import { searchMemories, type SearchHit } from "./memory-repo.js";
import { truncate } from "./claims.js";
import type { EmbedderClient } from "./embedder-client.js";

export interface BundleItem {
  memory_id:        string;
  type:             string;
  name:             string;
  statement:        string;
  claim_kind?:      string;
  conditions:       Record<string, string[]>;
  unconditioned?:   string[];
  qc?:              unknown;
  confidence?:      number;
  validation_level?: string;
  observed_at?:     string;
  score:            number;
  evidence:         Array<{ evidence_id: string; uri: string; modality: string }>;
  lineage:          Array<{ rel: EdgeRel; dir: "out" | "in"; other_id: string; differs_on?: string[] }>;
  attrs:            Record<string, unknown>;
}

export interface ContextBundle {
  query:            string;
  filters:          Record<string, string[]>;
  current_versions: Array<{ key: string; subject: string; value: string; memory_id: string }>;
  facts:            BundleItem[];
  experiences:      BundleItem[];
  warnings:         string[];
  lineage_error?:   boolean;
  text:             string;
}

export interface BuildBundleArgs {
  pool:           Pool;
  embedderClient: EmbedderClient;
  username:       string;
  project_dir:    string | null;
  query:          string;
  conditions?:    Record<string, string[]>;
  strict?:        boolean;
  clearance?:     AccessClass;
  limit?:         number;
  budget_tokens?: number;
}

// Memory types a bundle leaves out: preferences are not scientific context.
const BUNDLE_TYPES = ["claim", "experience", "observation", "session_summary", "project", "reference"];

// Phase 6 rerank priors (spec §4.3). SUPERSEDES/RETRACTS only navigate.
const EDGE_PRIOR: Record<EdgeRel, number> = {
  SUPPORTS: 0.9, VALIDATED_BY: 0.9, DERIVED_FROM: 0.8, QUALIFIES: 0.7,
  CONTRADICTS: 0, FAILED_TO_REPLICATE: 0, SUPERSEDES: 0, RETRACTS: 0,
};
const RERANK_BETA = 0.15;
const RERANK_CAP  = 1.0;

// Support propagation over the hit pool (Hy-Memory pro_graph_design):
// support(v) = Σ prior(u,v)·score(u)/√deg(v) over pool neighbours u, then
// score' = score + β·min(support, cap). Only reorders items already found.
export function graphRerank<T extends { memory_id: string; score: number }>(
  items: T[],
  edges: Map<string, LineageEdge[]>,
): T[] {
  const score = new Map(items.map((i) => [i.memory_id, i.score]));
  const boosted = items.map((v) => {
    const nbrs = (edges.get(v.memory_id) ?? []).filter((e) => score.has(e.other_id) && e.status === "accepted");
    if (nbrs.length === 0) return v;
    const support = nbrs.reduce((s, e) => s + EDGE_PRIOR[e.rel] * score.get(e.other_id)!, 0) / Math.sqrt(nbrs.length);
    return { ...v, score: v.score + RERANK_BETA * Math.min(support, RERANK_CAP) };
  });
  return boosted.sort((a, b) => b.score - a.score);
}

export async function buildBundle(a: BuildBundleArgs): Promise<ContextBundle> {
  const filters = a.conditions ?? {};
  const hits = await searchMemories({
    pool: a.pool, embedderClient: a.embedderClient, username: a.username,
    project_dir: a.project_dir, query: a.query, limit: a.limit ?? 8, types: BUNDLE_TYPES,
    clearance: a.clearance, conditions: filters, strict: a.strict,
  });
  const ids = hits.map((h) => h.memory_id);
  const details = await loadDetails(a.pool, ids);
  const evidence = await loadEvidence(a.pool, ids);

  let items: BundleItem[] = hits.map((h) => toItem(h, details.get(h.memory_id), evidence.get(h.memory_id) ?? [], filters));
  const warnings: string[] = [];
  let lineage_error = false;
  try {
    const edges = await lineageOf(a.pool, ids, { username: a.username, clearance: a.clearance ?? DEFAULT_CLEARANCE });
    const others = [...new Set([...edges.values()].flat().map((e) => e.other_id))];
    const otherDetails = await loadDetails(a.pool, others.filter((id) => !details.has(id)));
    for (const [k, v] of details) otherDetails.set(k, v);
    for (const it of items) {
      it.lineage = (edges.get(it.memory_id) ?? []).map((e) => {
        const o = otherDetails.get(e.other_id);
        const differs_on = o && ["QUALIFIES", "CONTRADICTS", "FAILED_TO_REPLICATE"].includes(e.rel)
          ? CONDITION_KEYS.filter((k) => it.conditions[k]?.length && o.facets[k]?.length
              && it.conditions[k]!.join(",") !== o.facets[k]!.join(","))
          : undefined;
        return { rel: e.rel, dir: e.dir, other_id: e.other_id, ...(differs_on ? { differs_on } : {}) };
      });
      for (const l of it.lineage) {
        if (l.rel === "CONTRADICTS") warnings.push(`${it.memory_id} conflicts with ${l.other_id}${l.differs_on?.length ? ` (differs on ${l.differs_on.join(", ")})` : ""}`);
        if (l.rel === "FAILED_TO_REPLICATE" && l.dir === "in") warnings.push(`${it.memory_id} failed to replicate in ${l.other_id}`);
      }
    }
    items = graphRerank(items, edges);
  } catch (e) {
    lineage_error = true;
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "bundle lineage failed; returning without lineage");
  }

  const current_versions = await currentVersions(a.pool, a.username, a.clearance ?? DEFAULT_CLEARANCE, a.project_dir, items);
  for (const it of items) {
    for (const cv of current_versions) {
      const v = it.conditions[cv.key]?.[0];
      if (v !== undefined && it.memory_id !== cv.memory_id && sharesSubject(it, cv) && compareVersions(v, cv.value) < 0) {
        warnings.push(`${it.memory_id} used ${cv.key} ${v}; current is ${cv.value}`);
      }
    }
    if (it.unconditioned?.length) warnings.push(`${it.memory_id} does not state ${it.unconditioned.join(", ")}`);
  }

  const facts = items.filter((i) => i.type !== "experience");
  const experiences = items.filter((i) => i.type === "experience");
  const bundle: ContextBundle = {
    query: a.query, filters, current_versions, facts, experiences,
    warnings: [...new Set(warnings)], ...(lineage_error ? { lineage_error } : {}), text: "",
  };
  bundle.text = renderBundle(bundle, (a.budget_tokens ?? 1500) * 4);
  return bundle;
}

interface Detail {
  facets: Record<string, string[]>;
  attrs: Record<string, unknown>;
  claim_kind: string | null; confidence: number | null; validation_level: string | null;
  observed_at: Date | null; body: string;
}

async function loadDetails(pool: Pool, ids: string[]): Promise<Map<string, Detail>> {
  if (ids.length === 0) return new Map();
  const r = await pool.query<Detail & { memory_id: string }>(
    `SELECT m.memory_id, m.attrs, m.claim_kind, m.confidence, m.validation_level, m.observed_at, m.body,
            COALESCE((SELECT jsonb_object_agg(key, vals) FROM (
              SELECT key, jsonb_agg(value ORDER BY value) AS vals FROM memory_facets
               WHERE memory_id = m.memory_id GROUP BY key) f), '{}'::jsonb) AS facets
       FROM memories m WHERE m.memory_id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(r.rows.map((row) => [row.memory_id, row]));
}

async function loadEvidence(pool: Pool, ids: string[]): Promise<Map<string, BundleItem["evidence"]>> {
  const out = new Map<string, BundleItem["evidence"]>();
  if (ids.length === 0) return out;
  const r = await pool.query<{ memory_id: string; evidence_id: string; uri: string; modality: string }>(
    `SELECT DISTINCT me.memory_id, a.evidence_id, a.uri, a.modality
       FROM memory_evidence me JOIN evidence_assets a USING (evidence_id)
      WHERE me.memory_id = ANY($1::uuid[]) ORDER BY a.uri`,
    [ids],
  );
  for (const row of r.rows) {
    const list = out.get(row.memory_id) ?? [];
    list.push({ evidence_id: row.evidence_id, uri: row.uri, modality: row.modality });
    out.set(row.memory_id, list);
  }
  return out;
}

function toItem(
  h: SearchHit, d: Detail | undefined, evidence: BundleItem["evidence"], filters: Record<string, string[]>,
): BundleItem {
  const conditions = d?.facets ?? {};
  const unconditioned = Object.keys(filters).filter((k) => !conditions[k]?.length);
  const attrs = d?.attrs ?? {};
  return {
    memory_id: h.memory_id, type: h.type, name: h.name,
    statement: typeof attrs.statement === "string" ? attrs.statement
      : typeof attrs.solution === "string" ? attrs.solution : h.description,
    ...(d?.claim_kind ? { claim_kind: d.claim_kind } : {}),
    conditions,
    ...(unconditioned.length ? { unconditioned } : {}),
    ...(attrs.qc ? { qc: attrs.qc } : {}),
    ...(d?.confidence != null ? { confidence: d.confidence } : {}),
    ...(d?.validation_level ? { validation_level: d.validation_level } : {}),
    ...(d?.observed_at ? { observed_at: d.observed_at.toISOString() } : {}),
    score: h.score, evidence, lineage: [], attrs,
  };
}

const VERSIONED: Array<[string, string]> = [["pipeline", "pipeline_version"], ["protocol", "protocol_version"]];

function sharesSubject(it: BundleItem, cv: { subject: string }): boolean {
  const [key, value] = cv.subject.split("=");
  return it.conditions[key!]?.includes(value!) ?? false;
}

// Current version per pipeline/protocol among the hits: the highest version
// recorded on any active claim for that pipeline/protocol. Deterministic,
// from recorded run claims, never from model memory.
async function currentVersions(
  pool: Pool, username: string, clearance: AccessClass, project_dir: string | null, items: BundleItem[],
): Promise<ContextBundle["current_versions"]> {
  const out: ContextBundle["current_versions"] = [];
  for (const [nameKey, versionKey] of VERSIONED) {
    const names = [...new Set(items.flatMap((i) => i.conditions[nameKey] ?? []))];
    for (const name of names) {
      const r = await pool.query<{ memory_id: string; value: string }>(
        `SELECT m.memory_id, v.value
           FROM memories m
           JOIN memory_facets n ON n.memory_id = m.memory_id AND n.key = $1 AND n.value = $2
           JOIN memory_facets v ON v.memory_id = m.memory_id AND v.key = $3
          WHERE m.type = 'claim' AND m.status = 'active' AND m.deleted_at IS NULL
            AND ${visibleSql("m", "$4", "$6")}
            AND (m.project_dir IS NULL OR m.project_dir = $5)`,
        [nameKey, name, versionKey, username, project_dir, clearance],
      );
      const best = r.rows.sort((x, y) => compareVersions(y.value, x.value))[0];
      if (best) out.push({ key: versionKey, subject: `${nameKey}=${name}`, value: best.value, memory_id: best.memory_id });
    }
  }
  return out;
}

function line(it: BundleItem): string {
  const cond = Object.entries(it.conditions).map(([k, v]) => `${k}=${v.join(",")}`).join(" ");
  const meta = [
    it.claim_kind ?? it.type,
    it.validation_level, it.confidence != null ? `conf ${it.confidence}` : undefined,
    it.observed_at?.slice(0, 10),
  ].filter(Boolean).join(", ");
  const lin = it.lineage.map((l) => `${l.dir === "out" ? "" : "←"}${l.rel} ${l.other_id}${l.differs_on?.length ? ` (≠ ${l.differs_on.join(",")})` : ""}`);
  const ev = it.evidence.slice(0, 3).map((e) => e.uri);
  const parts = [`- ${truncate(it.statement, 240)} [${it.memory_id}]`, `  (${meta})${cond ? ` ${cond}` : ""}`];
  if (it.type === "experience") {
    const fm = it.attrs.failure_modes as string[] | undefined;
    const ap = it.attrs.applicability as string[] | undefined;
    if (ap?.length) parts.push(`  applies when: ${truncate(ap.join("; "), 200)}`);
    if (fm?.length) parts.push(`  fails when: ${truncate(fm.join("; "), 200)}`);
  }
  if (lin.length) parts.push(`  lineage: ${lin.join("; ")}`);
  if (ev.length) parts.push(`  evidence: ${ev.join(" ")}`);
  return parts.join("\n") + "\n";
}

function renderBundle(b: Omit<ContextBundle, "text">, charBudget: number): string {
  const head = `# Memory context for: ${truncate(b.query, 120)}\n`;
  const sections: string[] = [head];
  if (b.current_versions.length) {
    sections.push("## Current versions\n" + b.current_versions.map((v) => `- ${v.subject}: ${v.key} ${v.value} [${v.memory_id}]\n`).join(""));
  }
  if (b.warnings.length) sections.push("## Warnings\n" + b.warnings.map((w) => `- ${w}\n`).join(""));
  let used = sections.join("").length;
  for (const [title, list] of [["## Facts", b.facts], ["## Experience", b.experiences]] as const) {
    if (list.length === 0) continue;
    let sec = `${title}\n`;
    for (const it of list) {
      const l = line(it);
      if (used + sec.length + l.length > charBudget) break;
      sec += l;
    }
    sections.push(sec);
    used += sec.length;
  }
  if (b.facts.length + b.experiences.length === 0) sections.push("No matching memories.\n");
  sections.push("Cite memory ids in brackets. After the task, call memory_feedback with the ids you used.\n");
  return sections.join("\n");
}

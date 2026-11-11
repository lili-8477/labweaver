import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Claim, DistillationResult, EvidenceRef, Experience, RunClaim } from "./distiller-prompts.js";
import { contentHash } from "./content-hash.js";
import { InvalidDirError, isDirFkViolation, resolveDir, scopeOf } from "./memory-dirs.js";
import { embedForMerge, findSimilar, type MergeCheck, type SimilarMemory } from "./memory-merge.js";
import { conditionKey, normalizeFacets } from "./facets.js";
import { decideReconcile, renderClaimBody, renderExperienceBody, truncate, type Candidate } from "./claims.js";
import { linkEvidence, strictest, upsertEvidence, writeEdge, type AccessClass } from "./lineage-repo.js";
import type { Domain } from "./memory-domain.js";
import { vectorLiteral } from "./embedder-client.js";
import { withTx } from "./tx.js";

export interface SessionMeta {
  username:           string;
  project_dir:        string | null;
  // Nullable because /memory/distill (agent-driven) may not know the session
  // UUID, and user-authored memories elsewhere already pass NULL.
  source_session_id:  string | null;
}

export interface WriteDistillationArgs {
  sessionMeta:    SessionMeta;
  result:         DistillationResult;
  promptVersion:  number;
}

export interface InsertMemoryRowArgs {
  username:           string;
  project_dir:        string | null;
  source:             "distilled" | "user" | "import";
  type:               string;
  source_session_id:  string | null;
  name:               string;
  description:        string;
  body:               string;
  facets:             Record<string, string[] | undefined>;
  content_hash:       Buffer;
  // Directory to file the memory under; defaults by (scope, type).
  dir_key?:           string;
  // Lab knowledge for the UI, or technical know-how for the agent only.
  domain:             Domain;
  // Embedding already computed for the merge check: stored on the chunk
  // directly instead of going through embedder_queue.
  embedding?:         number[];
  // false: no embedding at all, the memory is found by keywords and facets
  // only (an imported inventory row or data record). Default true.
  embed?:             boolean;
  // Scientific-memory columns (migration 0020); omitted for plain memories.
  science?:           ScienceColumns;
}

export interface ScienceColumns {
  claim_kind?:       string | null;
  confidence?:       number | null;
  validation_level?: string | null;
  observed_at?:      string | null;
  access_class?:     string;
  condition_key?:    Buffer | null;
  attrs?:            Record<string, unknown>;
}

export async function insertMemoryRow(
  client: PoolClient,
  args:   InsertMemoryRowArgs,
): Promise<string | null> {
  const memId = randomUUID();
  const dirKey = resolveDir(args.username, args.project_dir, args.type, args.dir_key);
  const sc = args.science ?? {};
  let ins;
  try {
    ins = await client.query<{ memory_id: string }>(
      `INSERT INTO memories (
         memory_id, username, project_dir, type, source,
         name, description, body, source_session_id, content_hash, dir_key,
         claim_kind, confidence, validation_level, observed_at, access_class,
         condition_key, attrs, domain
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 $12, $13, $14, $15, COALESCE($16, 'internal'), $17, $18::jsonb, $19)
       ON CONFLICT (username, project_dir, type, content_hash) DO NOTHING
       RETURNING memory_id`,
      [
        memId, args.username, args.project_dir, args.type, args.source,
        args.name, args.description, args.body, args.source_session_id, args.content_hash,
        dirKey,
        sc.claim_kind ?? null, sc.confidence ?? null, sc.validation_level ?? null,
        sc.observed_at ?? null, sc.access_class ?? null, sc.condition_key ?? null,
        JSON.stringify(sc.attrs ?? {}), args.domain,
      ],
    );
  } catch (e) {
    if (isDirFkViolation(e)) throw new InvalidDirError(dirKey, scopeOf(args.username, args.project_dir));
    throw e;
  }
  if (ins.rowCount === 0) return null; // dedup; nothing else to write

  const writtenId = ins.rows[0]!.memory_id;
  const chunk = await client.query<{ chunk_id: string }>(
    `INSERT INTO memory_chunks (memory_id, chunk_idx, content, embedding)
     VALUES ($1, 0, $2, $3::vector) RETURNING chunk_id`,
    [writtenId, args.body, args.embedding ? vectorLiteral(args.embedding) : null],
  );
  if (!args.embedding && args.embed !== false) {
    await client.query(
      `INSERT INTO embedder_queue (chunk_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [chunk.rows[0]!.chunk_id],
    );
  }
  for (const [k, vs] of Object.entries(args.facets)) {
    if (!vs) continue;
    for (const v of vs) {
      await client.query(
        `INSERT INTO memory_facets (memory_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [writtenId, k, v],
      );
    }
  }
  return writtenId;
}

export interface DistillationOutcome {
  // Run claim and claims written (null when a claim duplicated an existing one).
  run_id:      string | null;
  claim_ids:   Array<string | null>;
  experience_ids: Array<string | null>;
  // Claims not written because an equivalent claim exists.
  duplicates:  Array<{ index: number | "run"; memory_id: string }>;
  // Edges the server wrote by rule (§5.3).
  superseded:  Array<{ new_id: string; old_id: string }>;
  qualified:   Array<{ new_id: string; other_id: string; differs_on: string[] }>;
  // Same-condition claims with a different statement: label each with
  // memory_link (SUPPORTS or CONTRADICTS).
  related:     Array<{ new_id: string; other_id: string; sim: number | null }>;
  // Experiences and preferences held back as near-duplicates of existing
  // memories; the agent folds them in with memory_merge.
  similar:     Array<{ name: string; matches: SimilarMemory[] }>;
}

// Cosine similarity at or above which a claim with no condition key match is
// still a reconcile candidate (it may be the same finding under a different
// condition).
const RELATED_SIMILARITY = 0.8;
const CANDIDATE_LIMIT = 10;

// Writes one distillation in one transaction (spec §5.2–5.3):
//   run claim (exactly one) → claims → experiences, each claim reconciled
//   against existing claims, experiences linked DERIVED_FROM their source.
export async function writeDistillation(
  pool: Pool,
  args: WriteDistillationArgs & { merge?: MergeCheck },
): Promise<DistillationOutcome> {
  const meta = args.sessionMeta;
  const r = args.result;
  const texts = [
    claimText(r.run),
    ...r.claims.map(claimText),
    ...r.experiences.map((e) => renderExperienceBody(e)),
  ];
  const embeddings = args.merge ? await embedForMerge(args.merge, texts) : null;
  const emb = (i: number) => embeddings?.[i];

  const out: DistillationOutcome = {
    run_id: null, claim_ids: [], experience_ids: [],
    duplicates: [], superseded: [], qualified: [], related: [], similar: [],
  };
  return await withTx(pool, async (client) => {
    const sessionEvidence: EvidenceRef[] = meta.source_session_id
      ? [{ uri: `transcript://${meta.source_session_id}`, role: "source" }]
      : [];

    const run = await writeClaim(client, meta, args.promptVersion, {
      kind: "run", claim: r.run, embedding: emb(0), extraEvidence: sessionEvidence,
      duplicateSimilarity: args.merge?.similarity ?? 0.9,
    }, out, "run");
    out.run_id = run.memory_id;

    const claimIds: Array<string | null> = [];
    for (const [i, c] of r.claims.entries()) {
      if (c.claim_kind === "feedback") {
        // Preferences stay ordinary user-scope feedback rows (user/preferences).
        await writePreference(client, meta, args, c, emb(i + 1), out);
        claimIds.push(null);
        continue;
      }
      const w = await writeClaim(client, meta, args.promptVersion, {
        kind: c.claim_kind, claim: c, embedding: emb(i + 1), extraEvidence: [],
        duplicateSimilarity: args.merge?.similarity ?? 0.9,
      }, out, i);
      claimIds.push(w.memory_id ?? w.duplicate_of);
    }
    out.claim_ids = claimIds;

    const runRef = run.memory_id ?? run.duplicate_of;
    for (const [i, e] of r.experiences.entries()) {
      const sourceId = e.source === "run" ? runRef : claimIds[e.source] ?? null;
      const id = await writeExperience(client, meta, args, e, sourceId, emb(1 + r.claims.length + i), out);
      out.experience_ids.push(id);
    }
    return out;
  });
}

function claimText(c: RunClaim | Claim): string {
  return renderClaimBody({
    statement:  c.statement,
    conditions: normalizeFacets(c.conditions),
    parameters: "parameters" in c ? c.parameters : undefined,
    inputs:     "inputs" in c ? c.inputs : undefined,
    outputs:    "outputs" in c ? c.outputs : undefined,
    qc:         c.qc,
  });
}

interface ClaimWrite {
  kind:                string;
  claim:               RunClaim | Claim;
  embedding?:          number[];
  extraEvidence:       EvidenceRef[];
  duplicateSimilarity: number;
}

async function writeClaim(
  client:        PoolClient,
  meta:          SessionMeta,
  promptVersion: number,
  w:             ClaimWrite,
  out:           DistillationOutcome,
  index:         number | "run",
): Promise<{ memory_id: string | null; duplicate_of: string | null }> {
  const c = w.claim;
  const facets = normalizeFacets(c.conditions);
  const key = conditionKey(c.subject, facets);
  const observedAt = c.observed_at ? new Date(c.observed_at) : new Date();

  const candidates = await claimCandidates(client, {
    username: meta.username, project_dir: meta.project_dir, claim_kind: w.kind,
    condition_key: key, subject: c.subject, embedding: w.embedding,
  });
  const d = decideReconcile(
    { username: meta.username, condition_key: key, facets, observed_at: observedAt },
    candidates, w.duplicateSimilarity,
  );
  if (d.duplicate_of !== null) {
    out.duplicates.push({ index, memory_id: d.duplicate_of });
    return { memory_id: null, duplicate_of: d.duplicate_of };
  }

  const evidence = [...w.extraEvidence, ...c.evidence];
  const ev = [];
  for (const e of evidence) {
    ev.push({ ...(await upsertEvidence(client, {
      uri: e.uri, actor: meta.username, access_class: e.access_class,
      observed_at: c.observed_at ?? null,
    })), role: e.role ?? "source" });
  }
  const body = claimText(c);
  const attrs: Record<string, unknown> = { subject: c.subject, statement: c.statement };
  if ("parameters" in c) Object.assign(attrs, { inputs: c.inputs, parameters: c.parameters, outputs: c.outputs });
  if (c.qc) attrs.qc = c.qc;

  const project = meta.project_dir !== null;
  const memory_id = await insertMemoryRow(client, {
    username:          meta.username,
    project_dir:       meta.project_dir,
    source:            "distilled",
    type:              "claim",
    source_session_id: meta.source_session_id,
    name:              truncate(c.subject, 80),
    description:       truncate(c.statement, 200),
    body,
    facets,
    content_hash:      contentHash({ body: `${w.kind}\n${body}`, promptVersion }),
    dir_key:           w.kind === "run" ? (project ? "project/trajectories" : "user/notes") : undefined,
    domain:            c.domain,
    embedding:         w.embedding,
    science: {
      claim_kind:    w.kind,
      confidence:    "confidence" in c ? c.confidence ?? null : null,
      observed_at:   observedAt.toISOString(),
      access_class:  strictest(ev.map((e) => e.access_class)),
      condition_key: key,
      attrs,
    },
  });
  // Content-hash dedup: the identical claim already exists.
  if (memory_id === null) return { memory_id: null, duplicate_of: null };

  for (const e of ev) await linkEvidence(client, memory_id, e.evidence_id, e.role);
  for (const old of d.supersedes) {
    await writeEdge(client, { src_id: memory_id, dst_id: old, rel: "SUPERSEDES", actor: "distiller" });
    out.superseded.push({ new_id: memory_id, old_id: old });
  }
  for (const q of d.qualifies) {
    await writeEdge(client, {
      src_id: memory_id, dst_id: q.memory_id, rel: "QUALIFIES", actor: "distiller",
      note: `differs on ${q.differs_on.join(", ")}`,
    });
    out.qualified.push({ new_id: memory_id, other_id: q.memory_id, differs_on: q.differs_on });
  }
  for (const rel of d.related) out.related.push({ new_id: memory_id, other_id: rel.memory_id, sim: rel.sim });
  return { memory_id, duplicate_of: null };
}

async function claimCandidates(
  client: PoolClient,
  a: {
    username: string; project_dir: string | null; claim_kind: string;
    condition_key: Buffer; subject: string; embedding?: number[];
  },
): Promise<Candidate[]> {
  const r = await client.query<{
    memory_id: string; username: string; condition_key: Buffer | null;
    observed_at: Date; sim: number | null; facets: Record<string, string[]>;
  }>(
    `WITH c AS (
       SELECT m.memory_id, m.username, m.condition_key,
              COALESCE(m.observed_at, m.created_at) AS observed_at,
              (SELECT MAX(1 - (mc.embedding <=> $6::vector)) FROM memory_chunks mc
                WHERE mc.memory_id = m.memory_id AND mc.embedding IS NOT NULL)::float8 AS sim,
              lower(m.attrs->>'subject') = lower($5) AS same_subject
         FROM memories m
        WHERE m.type = 'claim' AND m.status = 'active' AND m.deleted_at IS NULL
          AND m.claim_kind = $3
          AND m.username = $1 AND m.project_dir IS NOT DISTINCT FROM $2)
     SELECT c.memory_id, c.username, c.condition_key, c.observed_at, c.sim, COALESCE((SELECT jsonb_object_agg(key, vals) FROM (
              SELECT key, jsonb_agg(value ORDER BY value) AS vals FROM memory_facets
               WHERE memory_id = c.memory_id GROUP BY key) f), '{}'::jsonb) AS facets
       FROM c
      WHERE c.condition_key = $4 OR c.same_subject OR c.sim >= $7
      ORDER BY (c.condition_key = $4) DESC, c.sim DESC NULLS LAST
      LIMIT $8`,
    [
      a.username, a.project_dir, a.claim_kind, a.condition_key, a.subject.trim(),
      a.embedding ? vectorLiteral(a.embedding) : null, RELATED_SIMILARITY, CANDIDATE_LIMIT,
    ],
  );
  return r.rows;
}

async function writeExperience(
  client:   PoolClient,
  meta:     SessionMeta,
  args:     WriteDistillationArgs & { merge?: MergeCheck },
  e:        Experience,
  sourceId: string | null,
  embedding: number[] | undefined,
  out:      DistillationOutcome,
): Promise<string | null> {
  const body = renderExperienceBody(e);
  // Experiences are personal until reviewed: user scope, user/experience.
  if (args.merge && embedding) {
    const matches = await findSimilar(client, {
      username: meta.username, project_dir: null, dir_key: "user/experience",
      embedding, similarity: args.merge.similarity,
    });
    if (matches.length > 0) {
      out.similar.push({ name: e.task, matches });
      return null;
    }
  }
  const src = sourceId
    ? (await client.query<{ access_class: AccessClass }>(
        `SELECT access_class FROM memories WHERE memory_id = $1`, [sourceId])).rows[0]
    : undefined;
  const facets = normalizeFacets({ ...e.conditions });
  const id = await insertMemoryRow(client, {
    username:          meta.username,
    project_dir:       null,
    source:            "distilled",
    type:              "experience",
    source_session_id: meta.source_session_id,
    name:              truncate(e.task, 80),
    description:       truncate(e.solution, 200),
    body,
    facets,
    content_hash:      contentHash({ body: `experience\n${body}`, promptVersion: args.promptVersion }),
    dir_key:           "user/experience",
    domain:            e.domain,
    embedding,
    science: {
      validation_level: "anecdotal",
      access_class:     src?.access_class ?? "internal",
      attrs: {
        task: e.task, solution: e.solution, applicability: e.applicability,
        boundary_conditions: e.boundary_conditions, failure_modes: e.failure_modes,
        expected_qc: e.expected_qc, search_keys: e.search_keys,
      },
    },
  });
  if (id && sourceId) {
    await writeEdge(client, { src_id: id, dst_id: sourceId, rel: "DERIVED_FROM", actor: "distiller" });
  }
  return id;
}

async function writePreference(
  client:    PoolClient,
  meta:      SessionMeta,
  args:      WriteDistillationArgs & { merge?: MergeCheck },
  c:         Claim,
  embedding: number[] | undefined,
  out:       DistillationOutcome,
): Promise<void> {
  const name = truncate(c.subject, 80);
  if (args.merge && embedding) {
    const matches = await findSimilar(client, {
      username: meta.username, project_dir: null, dir_key: "user/preferences",
      embedding, similarity: args.merge.similarity,
    });
    if (matches.length > 0) {
      out.similar.push({ name, matches });
      return;
    }
  }
  await insertMemoryRow(client, {
    username: meta.username, project_dir: null, source: "distilled", type: "feedback",
    source_session_id: meta.source_session_id, name,
    description: truncate(c.statement, 200), body: c.statement,
    facets: normalizeFacets(c.conditions),
    content_hash: contentHash({ body: `${name}\n${c.statement}`, promptVersion: args.promptVersion }),
    domain: c.domain,
    embedding,
  });
}

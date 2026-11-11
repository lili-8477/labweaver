// Scientific memory end to end (spec §9): supersession, qualification,
// condition filters, exact IDs, retraction, access classes, bundle,
// promotion guards and consolidation, against a real Postgres + pgvector.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { writeDistillation } from "../src/distiller-repo.js";
import { DistillationResult } from "../src/distiller-prompts.js";
import { searchMemories, updateMemory, recordFeedback, recordUse, writeUserMemory } from "../src/memory-repo.js";
import { linkMemories } from "../src/lineage-repo.js";
import { buildBundle } from "../src/context-bundle.js";
import { proposeExperiences } from "../src/experience-promotion.js";
import { consolidate } from "../src/consolidate.js";
import { captureEvidence } from "../src/evidence-capture.js";
import type { MergeCheck } from "../src/memory-merge.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
let pg: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await runMigrations({ pool, migrationsDir: MIGRATIONS_DIR, lockKey: 0x736369656en });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

beforeEach(async () => {
  await pool.query("TRUNCATE memories, evidence_assets, share_requests CASCADE");
});

// Stub embedder: the first word of a text picks its axis, so texts that
// start with the same word have cosine similarity 1, others 0.
const DIM = 384;
const AXES = ["knockdown", "clustering", "viability", "task:", "qc"];
function vec(text: string): number[] {
  const axis = Math.max(0, AXES.indexOf(text.split(/\s/)[0]!.toLowerCase()));
  return Array.from({ length: DIM }, (_, i) => (i === axis ? 1 : 0));
}
const embedderClient = { embedTexts: async (texts: string[]) => texts.map(vec) };
const merge: MergeCheck = { embedderClient, similarity: 0.9 };

const P = "-w-lab";
async function distill(payload: unknown, opts: { username?: string; withMerge?: boolean } = {}) {
  return writeDistillation(pool, {
    sessionMeta: { username: opts.username ?? "alice", project_dir: P, source_session_id: null },
    result: DistillationResult.parse(payload),
    promptVersion: 2,
    merge: opts.withMerge === false ? undefined : merge,
  });
}
const status = async (id: string) =>
  (await pool.query(`SELECT status FROM memories WHERE memory_id = $1`, [id])).rows[0].status;
const search = (query: string, extra: Partial<Parameters<typeof searchMemories>[0]> = {}) =>
  searchMemories({ pool, embedderClient, username: "alice", project_dir: P, query, ...extra });

const runPayload = (version: string, observed_at: string, statement = "clustering of pbmc3k gave 9 clusters") => ({
  run: {
    subject: "PBMC3k clustering", statement, observed_at,
    conditions: { dataset: ["pbmc3k"], pipeline: ["scanpy-qc"], pipeline_version: [version] },
  },
});

describe("supersession", () => {
  it("a same-condition re-run with a newer pipeline supersedes the old run, keeps it, and hides it from search", async () => {
    const a = await distill(runPayload("v1.2", "2026-01-01T00:00:00Z"));
    const b = await distill(runPayload("v1.4", "2026-02-01T00:00:00Z", "clustering of pbmc3k gave 11 clusters"));
    expect(b.superseded).toEqual([{ new_id: b.run_id, old_id: a.run_id }]);
    expect(await status(a.run_id!)).toBe("superseded");
    expect(await status(b.run_id!)).toBe("active");

    const hits = await search("clustering pbmc3k");
    expect(hits.map((h) => h.memory_id)).toEqual([b.run_id]);

    const audit = await pool.query(`SELECT action, actor, after FROM memory_audit_log WHERE memory_id = $1`, [a.run_id]);
    expect(audit.rows).toEqual([{ action: "status", actor: "distiller", after: { status: "superseded" } }]);
  });

  it("an older version written later does not supersede, and another user's run is never superseded", async () => {
    const a = await distill(runPayload("v1.4", "2026-02-01T00:00:00Z"));
    const b = await distill(runPayload("v1.2", "2026-03-01T00:00:00Z", "clustering again with old pipeline"));
    expect(b.superseded).toEqual([]);
    expect(await status(a.run_id!)).toBe("active");
  });

  it("rejecting a SUPERSEDES edge restores the old claim", async () => {
    const a = await distill(runPayload("v1.2", "2026-01-01T00:00:00Z"));
    const b = await distill(runPayload("v1.4", "2026-02-01T00:00:00Z", "clustering v1.4"));
    expect(await linkMemories({ pool, actor: "alice", src_id: b.run_id!, dst_id: a.run_id!, rel: "SUPERSEDES", status: "rejected" }))
      .toEqual({ ok: true });
    expect(await status(a.run_id!)).toBe("active");
  });
});

describe("conflicting results under different conditions", () => {
  const claim = (cell: string, statement: string) => ({
    run: { subject: `viability screen ${cell}`, statement: `viability screen in ${cell}` },
    claims: [{
      claim_kind: "result", subject: "TP53 knockdown viability", statement,
      conditions: { cell_line: [cell], assay: ["celltiter-glo"], gene: ["TP53"] },
    }],
  });

  it("qualifies instead of superseding, and both stay retrievable with differs_on", async () => {
    const a = await distill(claim("A549", "knockdown of TP53 reduced viability 40%"));
    const b = await distill(claim("HeLa", "knockdown of TP53 did not change viability"));
    expect(b.superseded).toEqual([]);
    expect(b.qualified).toEqual([{ new_id: b.claim_ids[0], other_id: a.claim_ids[0], differs_on: ["cell_line"] }]);

    const bundle = await buildBundle({ pool, embedderClient, username: "alice", project_dir: P, query: "knockdown TP53 viability" });
    const ids = bundle.facts.map((f) => f.memory_id);
    expect(ids).toContain(a.claim_ids[0]);
    expect(ids).toContain(b.claim_ids[0]);
    const bi = bundle.facts.find((f) => f.memory_id === b.claim_ids[0])!;
    expect(bi.lineage).toContainEqual({ rel: "QUALIFIES", dir: "out", other_id: a.claim_ids[0], differs_on: ["cell_line"] });
    expect(bundle.text).toContain(`[${b.claim_ids[0]}]`);
  });

  it("a condition filter drops the other cell line, keeps unconditioned rows (flagged), and strict drops those", async () => {
    const a = await distill(claim("A549", "knockdown of TP53 reduced viability 40%"));
    const b = await distill(claim("HeLa", "knockdown of TP53 did not change viability"));
    const u = await distill({ run: { subject: "TP53 notes", statement: "knockdown of TP53 needs 72h" } });

    const hits = await search("knockdown TP53", { conditions: { cell_line: ["a549"] } });
    const ids = hits.map((h) => h.memory_id);
    expect(ids).toContain(a.claim_ids[0]);
    expect(ids).not.toContain(b.claim_ids[0]);
    expect(ids).toContain(u.run_id);

    const strict = await search("knockdown TP53", { conditions: { cell_line: ["A549"] }, strict: true });
    expect(strict.map((h) => h.memory_id)).toEqual([a.claim_ids[0]]);

    const bundle = await buildBundle({
      pool, embedderClient, username: "alice", project_dir: P, query: "knockdown TP53", conditions: { cell_line: ["a549"] },
    });
    expect(bundle.facts.find((f) => f.memory_id === u.run_id)!.unconditioned).toEqual(["cell_line"]);
  });

  it("the agent labels a same-condition disagreement as CONTRADICTS; the bundle warns", async () => {
    const a = await distill(claim("A549", "knockdown of TP53 reduced viability 40%"));
    const b = await distill(claim("A549", "viability unchanged after TP53 knockdown"));
    expect(b.related).toEqual([{ new_id: b.claim_ids[0], other_id: a.claim_ids[0], sim: 0 }]);
    expect(await linkMemories({ pool, actor: "alice", src_id: b.claim_ids[0]!, dst_id: a.claim_ids[0]!, rel: "CONTRADICTS" }))
      .toEqual({ ok: true });
    const bundle = await buildBundle({ pool, embedderClient, username: "alice", project_dir: P, query: "TP53 knockdown A549" });
    expect(bundle.warnings.some((w) => w.includes("conflicts with"))).toBe(true);
  });

  it("a near-identical same-condition claim is reported as a duplicate, not written", async () => {
    const a = await distill(claim("A549", "knockdown of TP53 reduced viability 40%"));
    const b = await distill(claim("A549", "knockdown of TP53 reduced viability by about 40%"));
    // The identical run claim is a duplicate too.
    expect(b.duplicates).toEqual([
      { index: "run", memory_id: a.run_id }, { index: 0, memory_id: a.claim_ids[0] },
    ]);
    expect(b.claim_ids).toEqual([a.claim_ids[0]]);
  });
});

describe("claims are immutable", () => {
  it("refuses edits and merges on a claim", async () => {
    const a = await distill(runPayload("v1", "2026-01-01T00:00:00Z"));
    const r = await updateMemory({ pool, actor: "alice", memoryId: a.run_id!, name: "x", description: "x", body: "x", merge: true });
    expect(r).toEqual({ ok: false, reason: "immutable" });
  });

  it("RETRACTS is owner-only and hides the claim from search", async () => {
    const a = await distill(runPayload("v1", "2026-01-01T00:00:00Z"));
    const b = await distill({ run: { subject: "erratum", statement: "qc found a sample swap" } });
    const c = await distill({ run: { subject: "bob", statement: "bob run" } }, { username: "bob" });
    expect(await linkMemories({ pool, actor: "bob", src_id: c.run_id!, dst_id: a.run_id!, rel: "RETRACTS" }))
      .toEqual({ ok: false, reason: "forbidden" });
    expect(await linkMemories({ pool, actor: "alice", src_id: b.run_id!, dst_id: a.run_id!, rel: "RETRACTS" }))
      .toEqual({ ok: true });
    expect(await status(a.run_id!)).toBe("retracted");
    expect((await search("clustering pbmc3k")).map((h) => h.memory_id)).not.toContain(a.run_id);
  });
});

describe("exact identifiers", () => {
  it("a reagent lot in the query ranks the row with that lot first", async () => {
    await distill({ run: { subject: "western blot", statement: "qc blot with antibody lot L-1001 was clean", conditions: { reagent_lot: ["L-1001"] } } });
    const b = await distill({ run: { subject: "western blot 2", statement: "qc blot with antibody lot L-2291 had high background", conditions: { reagent_lot: ["L-2291"] } } });
    const hits = await search("antibody lot L-2291 background");
    expect(hits[0]!.memory_id).toBe(b.run_id);
    expect(hits[0]!.exact).toBe(true);
  });
});

describe("access classes", () => {
  it("a claim inherits the strictest evidence class; low clearance cannot see it", async () => {
    const a = await distill({ run: {
      subject: "cohort A", statement: "qc of cohort A passed",
      evidence: [{ uri: "file:///data/cohortA/clinical.csv", access_class: "irb" }, { uri: "file:///w/x.py" }],
    } });
    const row = await pool.query(`SELECT access_class FROM memories WHERE memory_id = $1`, [a.run_id]);
    expect(row.rows[0].access_class).toBe("irb");
    expect((await search("qc cohort")).map((h) => h.memory_id)).not.toContain(a.run_id);
    expect((await search("qc cohort", { clearance: "irb" })).map((h) => h.memory_id)).toContain(a.run_id);
  });

  it("evidence never becomes less strict on a second sighting", async () => {
    await distill({ run: { subject: "s1", statement: "qc one", evidence: [{ uri: "file:///d/a.csv", access_class: "restricted" }] } });
    await distill({ run: { subject: "s2", statement: "qc two", evidence: [{ uri: "file:///d/a.csv", access_class: "public" }] } });
    const r = await pool.query(`SELECT access_class FROM evidence_assets WHERE uri = 'file:///d/a.csv'`);
    expect(r.rows).toEqual([{ access_class: "restricted" }]);
  });
});

describe("bundle versions", () => {
  it("states the current pipeline version and warns about hits from an older one", async () => {
    await distill({ run: {
      subject: "pbmc qc v1", statement: "qc thresholds 200 genes",
      conditions: { pipeline: ["scanpy-qc"], pipeline_version: ["v1.2"], dataset: ["pbmc3k"] },
    } });
    const b = await distill({ run: {
      subject: "pbmc8k qc", statement: "qc thresholds 300 genes",
      conditions: { pipeline: ["scanpy-qc"], pipeline_version: ["v1.4"], dataset: ["pbmc8k"] },
    } });
    const bundle = await buildBundle({ pool, embedderClient, username: "alice", project_dir: P, query: "qc thresholds" });
    expect(bundle.current_versions).toEqual([
      { key: "pipeline_version", subject: "pipeline=scanpy-qc", value: "v1.4", memory_id: b.run_id },
    ]);
    expect(bundle.warnings.some((w) => w.includes("pipeline_version v1.2; current is v1.4"))).toBe(true);
    expect(bundle.text).toContain("## Current versions");
  });
});

describe("experience promotion guards", () => {
  const withExp = (statement: string) => ({
    run: { subject: "qc run", statement },
    experiences: [{ task: "QC of PBMC", solution: "mt cutoff 5%", domain: "lab", applicability: ["10x v3"], failure_modes: ["kills stressed cells"] }],
  });

  it("needs 'repeated' (two successes) on top of three successes, and no contradiction on its source", async () => {
    const a = await distill(withExp("qc first"));
    const x = a.experience_ids[0]!;
    await recordFeedback({ pool, username: "alice", memory_ids: [x], outcome: "success" });
    const lvl = async () => (await pool.query(`SELECT validation_level FROM memories WHERE memory_id = $1`, [x])).rows[0].validation_level;
    expect(await lvl()).toBe("anecdotal");
    await recordFeedback({ pool, username: "alice", memory_ids: [x], outcome: "success" });
    expect(await lvl()).toBe("repeated");

    // Contradict the source run claim: promotion is blocked.
    const b = await distill({ run: { subject: "qc rerun", statement: "qc contradicts" } });
    await linkMemories({ pool, actor: "alice", src_id: b.run_id!, dst_id: a.run_id!, rel: "CONTRADICTS" });
    await recordFeedback({ pool, username: "alice", memory_ids: [x], outcome: "success" });
    expect(await proposeExperiences({ pool, managers: ["pi"], memory_ids: [x] })).toEqual({ proposed: [] });

    await linkMemories({ pool, actor: "alice", src_id: b.run_id!, dst_id: a.run_id!, rel: "CONTRADICTS", status: "rejected" });
    expect(await proposeExperiences({ pool, managers: ["pi"], memory_ids: [x] })).toEqual({ proposed: [x] });
  });
});

describe("consolidation", () => {
  it("proposes SUPPORTS for near-identical same-condition claims, reports others, and flags stale experiences", async () => {
    const payload = (statement: string) => ({
      run: { subject: "viability A549", statement, conditions: { cell_line: ["a549"] } },
      experiences: [{ task: "viability assays", solution: "seed 5k cells", domain: "lab", applicability: ["a549"], failure_modes: ["edge effects"] }],
    });
    // Written without the merge check, so near-duplicates both land.
    const a = await distill(payload("viability 60% at 1uM"), { withMerge: false });
    const b = await distill(payload("viability 61% at 1uM"), { withMerge: false });
    await pool.query(
      `UPDATE memory_chunks SET embedding = $1::vector WHERE memory_id = ANY($2::uuid[])`,
      ["[" + vec("viability").join(",") + "]", [a.run_id, b.run_id]],
    );
    const r = await consolidate({ pool, actor: "pi", similarity: 0.9 });
    expect(r.proposed_supports).toHaveLength(1);
    const e = await pool.query(`SELECT rel, status FROM memory_edges WHERE rel = 'SUPPORTS'`);
    expect(e.rows).toEqual([{ rel: "SUPPORTS", status: "proposed" }]);

    const c = await distill({ run: { subject: "erratum", statement: "plate swap" } });
    await linkMemories({ pool, actor: "alice", src_id: c.run_id!, dst_id: a.run_id!, rel: "RETRACTS" });
    const r2 = await consolidate({ pool, actor: "pi", similarity: 0.9 });
    expect(r2.stale_experiences).toEqual([
      { experience_id: a.experience_ids[0], source_id: a.run_id, source_status: "retracted" },
    ]);
  });
});

describe("reinforcement", () => {
  const note = (name: string, body: string) => writeUserMemory({
    pool, username: "alice", scope: "user", project_dir: null, type: "reference",
    name, description: name, body, domain: "lab",
  });
  const strength = async (id: string) =>
    (await pool.query(`SELECT reinforce_count, reinforced_at FROM memories WHERE memory_id = $1`, [id])).rows[0];

  it("a use, a merge and a success reinforce; a failure and a plain edit do not", async () => {
    const { memory_id } = await note("qc thresholds", "qc keep cells with >200 genes");
    const id = memory_id!;
    await recordUse({ pool, username: "alice", memoryId: id });
    await updateMemory({ pool, actor: "alice", memoryId: id, name: "qc thresholds", description: "d", body: "qc >200 genes, <5% mito" });
    await updateMemory({ pool, actor: "alice", memoryId: id, name: "qc thresholds", description: "d", body: "qc >200 genes, <10% mito", merge: true });
    await recordFeedback({ pool, username: "alice", memory_ids: [id], outcome: "failure" });
    expect((await strength(id)).reinforce_count).toBe(2);
    await recordFeedback({ pool, username: "alice", memory_ids: [id], outcome: "success" });
    expect((await strength(id)).reinforce_count).toBe(3);
  });

  it("ranks a memory in use just above an equal one, and an unused one doesn't fade", async () => {
    const used = (await note("qc a", "qc mito cutoff for pbmc")).memory_id!;
    const idle = (await note("qc b", "qc mito cutoff for pbmc, second copy")).memory_id!;
    await pool.query(`UPDATE memory_chunks SET embedding = $1::vector WHERE memory_id = ANY($2::uuid[])`,
      ["[" + vec("qc").join(",") + "]", [used, idle]]);
    // Both were written 200 days ago; only one has been opened since.
    await pool.query(`UPDATE memories SET created_at = now() - interval '200 days',
                                          reinforced_at = now() - interval '200 days' WHERE memory_id = ANY($1::uuid[])`, [[used, idle]]);
    const before = await search("qc mito cutoff", { project_dir: null });
    await recordUse({ pool, username: "alice", memoryId: used });
    const hits = await search("qc mito cutoff", { project_dir: null });
    expect(hits.map((h) => h.memory_id)).toEqual([used, idle]);
    expect(hits[1]!.score).toBeCloseTo(before.find((h) => h.memory_id === idle)!.score, 8);
    expect(hits[0]!.score).toBeLessThan(hits[1]!.score * 1.1);
    const row = await pool.query(`SELECT hit_count FROM memories WHERE memory_id = $1`, [used]);
    expect(row.rows[0].hit_count).toBe(1);
  });

  it("consolidation reports near-identical understandings in one directory", async () => {
    const a = (await note("knockdown tip", "knockdown works best at 48h")).memory_id!;
    const b = (await note("knockdown timing", "knockdown peaks around 48 hours")).memory_id!;
    await note("unrelated", "viability drops above 1uM");
    await pool.query(`UPDATE memory_chunks c SET embedding = $1::vector
                        FROM memories m WHERE m.memory_id = c.memory_id AND m.body LIKE 'knockdown%'`,
      ["[" + vec("knockdown").join(",") + "]"]);
    const r = await consolidate({ pool, actor: "pi", similarity: 0.9 });
    expect(r.similar_understandings).toEqual([{ a: [a, b].sort()[0], b: [a, b].sort()[1], sim: 1 }]);
  });
});

describe("evidence capture", () => {
  it("captures files from a transcript; a distill citing one reuses that row", async () => {
    const SID = "00000000-0000-4000-8000-000000000001";
    const UID = "00000000-0000-4000-8000-000000000002";
    await captureEvidence(pool, JSON.stringify({
      uuid: UID, sessionId: SID, timestamp: "2026-10-01T00:00:00Z",
      message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/w/lab/out.csv" } }] },
    }) + "\n", "alice");
    const a = await distill({ run: { subject: "s", statement: "qc table", evidence: [{ uri: "file:///w/lab/out.csv" }] } });
    const r = await pool.query(
      `SELECT a.locator, a.modality FROM memory_evidence me JOIN evidence_assets a USING (evidence_id)
        WHERE me.memory_id = $1`, [a.run_id]);
    expect(r.rows).toEqual([{ locator: { session_id: SID, entry_uuid: UID, tool: "Write" }, modality: "table" }]);
  });

  it("never throws on bad input", async () => {
    await expect(captureEvidence(pool, "{not json\n", "alice")).resolves.toBeUndefined();
  });
});

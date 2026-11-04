import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { writeDistillation } from "../src/distiller-repo.js";
import { DistillationResult } from "../src/distiller-prompts.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
let pg: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await runMigrations({ pool, migrationsDir: MIGRATIONS_DIR, lockKey: 0x62696f666c77n });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

beforeEach(async () => {
  await pool.query("TRUNCATE token_usage_log, sessions, memories, evidence_assets CASCADE");
  await pool.query("TRUNCATE memory_distill_cursor");
});

const SID = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

const RESULT = DistillationResult.parse({
  run: {
    subject: "scanpy preprocessing", statement: "Ran sc.pp.* QC on PBMC3K; 2638 cells kept.",
    conditions: { dataset: ["PBMC3K"], pipeline: ["scanpy-qc"], pipeline_version: ["v1.2"] },
    evidence: [{ uri: "file:///w/p/scripts/qc.py", role: "input" }],
  },
  claims: [
    { claim_kind: "decision", subject: "mt filter", statement: "drop top 1% mt%", conditions: { dataset: ["PBMC3K"] } },
    { claim_kind: "feedback", subject: "prefer Seurat conventions", statement: "label clusters the Seurat way" },
  ],
  experiences: [{
    task: "QC of 10x PBMC data", solution: "percentile mt filter", domain: "lab", applicability: ["10x v3 PBMC"],
    failure_modes: ["removes stressed but real cells"], source: 0,
  }],
});

describe("writeDistillation", () => {
  it("writes the run claim, claims, preference and experience with chunks, facets and queue rows", async () => {
    const out = await writeDistillation(pool, {
      sessionMeta: { username: "alice", project_dir: "-w-p", source_session_id: SID(8) },
      result: RESULT,
      promptVersion: 2,
    });

    const m = await pool.query(
      "SELECT type, source, claim_kind, dir_key, project_dir FROM memories ORDER BY type, claim_kind");
    expect(m.rows.map((r) => [r.type, r.claim_kind, r.dir_key])).toEqual([
      ["claim", "decision", "project/decisions"],
      ["claim", "run", "project/trajectories"],
      ["experience", null, "user/experience"],
      ["feedback", null, "user/preferences"],
    ]);
    for (const r of m.rows) expect(r.source).toBe("distilled");
    expect(out.run_id).not.toBeNull();
    expect(out.claim_ids).toHaveLength(2);
    expect(out.claim_ids[1]).toBeNull(); // the preference is not a claim

    const c = await pool.query("SELECT COUNT(*)::int AS n FROM memory_chunks");
    expect(c.rows[0].n).toBe(m.rowCount);
    const q = await pool.query("SELECT COUNT(*)::int AS n FROM embedder_queue");
    expect(q.rows[0].n).toBe(m.rowCount);

    const f = await pool.query("SELECT key, value FROM memory_facets ORDER BY key, value");
    const kv = f.rows.map((r) => `${r.key}=${r.value}`);
    expect(kv).toContain("dataset=pbmc3k"); // normalized
    expect(kv).toContain("pipeline_version=v1.2");
  });

  it("links evidence (cited file + session transcript) and DERIVED_FROM", async () => {
    const out = await writeDistillation(pool, {
      sessionMeta: { username: "alice", project_dir: "-w-p", source_session_id: SID(8) },
      result: RESULT,
      promptVersion: 2,
    });
    const ev = await pool.query(
      `SELECT a.uri, a.modality, me.role FROM memory_evidence me JOIN evidence_assets a USING (evidence_id)
        WHERE me.memory_id = $1 ORDER BY a.uri`, [out.run_id]);
    expect(ev.rows).toEqual([
      { uri: "file:///w/p/scripts/qc.py", modality: "file", role: "input" },
      { uri: `transcript://${SID(8)}`, modality: "transcript", role: "source" },
    ]);
    const e = await pool.query("SELECT src_id, dst_id, rel, status FROM memory_edges");
    expect(e.rows).toEqual([
      { src_id: out.experience_ids[0], dst_id: out.claim_ids[0], rel: "DERIVED_FROM", status: "accepted" },
    ]);
    const x = await pool.query("SELECT validation_level FROM memories WHERE type = 'experience'");
    expect(x.rows[0].validation_level).toBe("anecdotal");
  });

  it("is idempotent: re-running yields no duplicate memory rows", async () => {
    const args = {
      sessionMeta: { username: "alice", project_dir: "-w-p", source_session_id: SID(9) },
      result: RESULT,
      promptVersion: 2,
    };
    await writeDistillation(pool, args);
    const before = (await pool.query("SELECT COUNT(*)::int AS n FROM memories")).rows[0].n;
    await writeDistillation(pool, args);
    const after = (await pool.query("SELECT COUNT(*)::int AS n FROM memories")).rows[0].n;
    expect(after).toBe(before);
  });
});

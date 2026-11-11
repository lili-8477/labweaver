import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { writeDistillation } from "../src/distiller-repo.js";
import { DistillationResult } from "../src/distiller-prompts.js";
import { writeUserMemory, updateMemory, getAuditTrail, getMemory } from "../src/memory-repo.js";
import type { MergeCheck } from "../src/memory-merge.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
let pg: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await runMigrations({ pool, migrationsDir: MIGRATIONS_DIR, lockKey: 0x6d65726765n });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

beforeEach(async () => {
  await pool.query("TRUNCATE memories CASCADE");
});

// Bodies starting with the same word embed to the same axis, so "tabs ..."
// bodies are similar (sim 1) and "tabs" vs "spaces" are orthogonal (sim 0).
const DIM = 384;
const AXES = ["tabs", "spaces", "summary", "qc"];
function vec(text: string): number[] {
  const axis = Math.max(0, AXES.indexOf(text.split(" ")[0]!));
  return Array.from({ length: DIM }, (_, i) => (i === axis ? 1 : 0));
}
const merge: MergeCheck = {
  embedderClient: { embedTexts: async (texts) => texts.map(vec) },
  similarity: 0.9,
};
const down: MergeCheck = {
  embedderClient: { embedTexts: async () => { throw new Error("down"); } },
  similarity: 0.9,
};

const write = (body: string, extra: Partial<Parameters<typeof writeUserMemory>[0]> = {}) =>
  writeUserMemory({ domain: "lab",
    pool, username: "alice", scope: "user", project_dir: null, type: "feedback",
    name: body, description: "d", body, merge, ...extra,
  });

describe("writeUserMemory merge check", () => {
  it("holds back a near-duplicate in the same directory and returns the match", async () => {
    const first = await write("tabs over spaces");
    const second = await write("tabs please, not spaces");
    expect(second.memory_id).toBeNull();
    expect(second.similar).toEqual([
      expect.objectContaining({ memory_id: first.memory_id, body: "tabs over spaces", sim: 1 }),
    ]);
    const n = await pool.query(`SELECT count(*)::int AS n FROM memories`);
    expect(n.rows[0].n).toBe(1);
  });

  it("writes when forced, when the text differs, or when the match is in another directory or owner", async () => {
    await write("tabs over spaces");
    expect((await write("tabs again", { force_new: true })).memory_id).not.toBeNull();
    expect((await write("spaces sometimes")).memory_id).not.toBeNull();
    expect((await write("tabs as a note", { type: "reference" })).memory_id).not.toBeNull(); // user/notes
    expect((await write("tabs for bob", { username: "bob" })).memory_id).not.toBeNull();
  });

  it("ignores forgotten memories", async () => {
    const first = await write("tabs over spaces");
    await pool.query(`UPDATE memories SET deleted_at = now() WHERE memory_id = $1`, [first.memory_id]);
    expect((await write("tabs please")).memory_id).not.toBeNull();
  });

  it("stores the inline embedding and skips the embedder queue", async () => {
    const { memory_id } = await write("tabs over spaces");
    const r = await pool.query(
      `SELECT mc.embedding IS NOT NULL AS embedded,
              EXISTS (SELECT 1 FROM embedder_queue q WHERE q.chunk_id = mc.chunk_id) AS queued
         FROM memory_chunks mc WHERE mc.memory_id = $1`,
      [memory_id],
    );
    expect(r.rows[0]).toEqual({ embedded: true, queued: false });
  });

  it("writes without a check (and queues embedding) when the embedder is down", async () => {
    await write("tabs over spaces");
    const r = await write("tabs please", { merge: down });
    expect(r.memory_id).not.toBeNull();
    const q = await pool.query(`SELECT count(*)::int AS n FROM embedder_queue`);
    expect(q.rows[0].n).toBe(1);
  });
});

describe("writeDistillation merge check", () => {
  it("always writes the run claim and holds back similar experiences", async () => {
    // Experience bodies start with "Task:", which the stub embeds on axis 0.
    await write("Task: qc thresholds", { type: "reference", dir: "user/experience" });

    const out = await writeDistillation(pool, {
      sessionMeta: { username: "alice", project_dir: "-p", source_session_id: null },
      result: DistillationResult.parse({
        run: { subject: "s", statement: "summary of the session" },
        experiences: [{ task: "qc thresholds", solution: "200 genes, 5% mt", domain: "lab", applicability: ["pbmc"], failure_modes: ["neurons"] }],
      }),
      promptVersion: 2,
      merge,
    });

    expect(out.similar.map((s) => s.name)).toEqual(["qc thresholds"]);
    expect(out.run_id).not.toBeNull();
    const names = await pool.query(`SELECT name FROM memories WHERE source = 'distilled' ORDER BY name`);
    expect(names.rows.map((r) => r.name)).toEqual(["s"]);
  });
});

describe("updateMemory merge", () => {
  async function distilledId(): Promise<string> {
    await writeDistillation(pool, {
      sessionMeta: { username: "alice", project_dir: null, source_session_id: null },
      result: DistillationResult.parse({
        run: { subject: "s", statement: "summary" },
        claims: [{ claim_kind: "feedback", subject: "p", statement: "tabs" }],
      }),
      promptVersion: 2,
    });
    const r = await pool.query(`SELECT memory_id FROM memories WHERE name = 'p'`);
    return r.rows[0].memory_id;
  }

  it("may rewrite a distilled row and is audited as 'merge'", async () => {
    const id = await distilledId();
    const base = { pool, actor: "alice", memoryId: id, name: "p", description: "d", body: "tabs, 4 wide" };

    expect(await updateMemory(base)).toEqual({ ok: false, reason: "distilled" });
    expect(await updateMemory({ ...base, merge: true })).toEqual({ ok: true });
    expect((await getMemory({ pool, memoryId: id, username: "alice" }))!.body).toBe("tabs, 4 wide");

    const trail = await getAuditTrail({ pool, actor: "alice", memoryId: id });
    if ("error" in trail) throw new Error(trail.error);
    expect(trail.rows[0]).toMatchObject({ action: "merge", after: expect.objectContaining({ body: "tabs, 4 wide" }) });
  });

  it("still refuses another user's memory", async () => {
    const id = await distilledId();
    expect(await updateMemory({
      pool, actor: "bob", memoryId: id, name: "p", description: "d", body: "x", merge: true,
    })).toEqual({ ok: false, reason: "forbidden" });
  });
});

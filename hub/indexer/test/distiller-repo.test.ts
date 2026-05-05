import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { findSettledSessions, writeDistillation } from "../src/distiller-repo.js";
import type { DistillationResult } from "../src/distiller-prompts.js";

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
  await pool.query("TRUNCATE token_usage_log, sessions, memories CASCADE");
  await pool.query("TRUNCATE memory_distill_cursor");
});

const SID = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

async function insertSession(s: {
  sid: string;
  username: string;
  project: string;
  lastActive: string;
}) {
  await pool.query(
    `INSERT INTO sessions (session_id, username, encoded_project_dir, last_active)
     VALUES ($1, $2, $3, $4)`,
    [s.sid, s.username, s.project, s.lastActive],
  );
}

describe("findSettledSessions", () => {
  it("returns sessions with last_active > cursor AND < now() - settleSeconds", async () => {
    const now = new Date();
    const tenMinAgo  = new Date(now.getTime() - 10 * 60_000).toISOString();
    const oneMinAgo  = new Date(now.getTime() - 1  * 60_000).toISOString();

    await insertSession({ sid: SID(1), username: "alice", project: "-w-p1", lastActive: tenMinAgo });
    await insertSession({ sid: SID(2), username: "alice", project: "-w-p2", lastActive: oneMinAgo });

    const got = await findSettledSessions(pool, {
      username: "alice",
      cursor: new Date("1970-01-01"),
      settleSeconds: 300,
      limit: 50,
    });
    expect(got.map((s) => s.session_id)).toEqual([SID(1)]);
  });

  it("respects per-user scoping", async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    await insertSession({ sid: SID(3), username: "alice", project: "-w", lastActive: tenMinAgo });
    await insertSession({ sid: SID(4), username: "bob",   project: "-w", lastActive: tenMinAgo });
    const got = await findSettledSessions(pool, {
      username: "alice",
      cursor: new Date("1970-01-01"),
      settleSeconds: 300,
      limit: 50,
    });
    expect(got.map((s) => s.session_id)).toEqual([SID(3)]);
  });

  it("orders by last_active ascending and respects limit", async () => {
    const t1 = new Date(Date.now() - 30 * 60_000).toISOString();
    const t2 = new Date(Date.now() - 20 * 60_000).toISOString();
    const t3 = new Date(Date.now() - 10 * 60_000).toISOString();
    await insertSession({ sid: SID(7), username: "alice", project: "-w", lastActive: t3 });
    await insertSession({ sid: SID(5), username: "alice", project: "-w", lastActive: t1 });
    await insertSession({ sid: SID(6), username: "alice", project: "-w", lastActive: t2 });
    const got = await findSettledSessions(pool, {
      username: "alice",
      cursor: new Date("1970-01-01"),
      settleSeconds: 300,
      limit: 2,
    });
    expect(got.map((s) => s.session_id)).toEqual([SID(5), SID(6)]);
  });
});

const RESULT: DistillationResult = {
  summary: { name: "scanpy preprocessing", description: "QC + normalise + log1p", body: "Ran sc.pp.* pipeline on PBMC3K." },
  observations: [
    { type: "decision",     name: "use percentile filter", description: "drop top 1% mt%", body: "...", facets: { dataset: ["PBMC3K"] } },
    { type: "user-preference", name: "prefer Seurat conventions", description: "labels", body: "...", facets: {} },
    { type: "file-touched", name: "scripts/qc.py", description: "added mt-cutoff", body: "...", facets: { file: ["scripts/qc.py"] } },
  ],
};

describe("writeDistillation", () => {
  it("inserts summary + observations + chunks + facets + queue rows in one txn", async () => {
    await writeDistillation(pool, {
      sessionMeta: { username: "alice", project_dir: "-w-p", source_session_id: SID(8) },
      result: RESULT,
      promptVersion: 1,
    });

    const m = await pool.query("SELECT type, source FROM memories ORDER BY created_at");
    // 1 summary + 3 observations; user-preference becomes a feedback memory.
    const types = m.rows.map((r) => r.type);
    expect(types).toContain("session_summary");
    expect(types.filter((t) => t === "observation").length).toBe(2);
    expect(types).toContain("feedback");
    for (const r of m.rows) expect(r.source).toBe("distilled");

    const c = await pool.query("SELECT COUNT(*)::int AS n FROM memory_chunks");
    expect(c.rows[0].n).toBe(m.rowCount); // one chunk per memory at idx 0

    const q = await pool.query("SELECT COUNT(*)::int AS n FROM embedder_queue");
    expect(q.rows[0].n).toBe(m.rowCount);

    const f = await pool.query("SELECT key, value FROM memory_facets ORDER BY key, value");
    const kv = f.rows.map((r) => `${r.key}=${r.value}`);
    expect(kv).toContain("dataset=PBMC3K");
    expect(kv).toContain("file=scripts/qc.py");
  });

  it("is idempotent: re-running yields no duplicate memory rows", async () => {
    await writeDistillation(pool, {
      sessionMeta: { username: "alice", project_dir: "-w-p", source_session_id: SID(9) },
      result: RESULT,
      promptVersion: 1,
    });
    const before = (await pool.query("SELECT COUNT(*)::int AS n FROM memories")).rows[0].n;

    await writeDistillation(pool, {
      sessionMeta: { username: "alice", project_dir: "-w-p", source_session_id: SID(9) },
      result: RESULT,
      promptVersion: 1,
    });
    const after = (await pool.query("SELECT COUNT(*)::int AS n FROM memories")).rows[0].n;
    expect(after).toBe(before);
  });

  it("re-distills (creates fresh rows) when promptVersion bumps", async () => {
    await writeDistillation(pool, {
      sessionMeta: { username: "alice", project_dir: "-w-p", source_session_id: SID(10) },
      result: RESULT,
      promptVersion: 1,
    });
    const before = (await pool.query("SELECT COUNT(*)::int AS n FROM memories")).rows[0].n;

    await writeDistillation(pool, {
      sessionMeta: { username: "alice", project_dir: "-w-p", source_session_id: SID(10) },
      result: RESULT,
      promptVersion: 2,
    });
    const after = (await pool.query("SELECT COUNT(*)::int AS n FROM memories")).rows[0].n;
    expect(after).toBe(before * 2);
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { runMigrations } from "../../src/migrate.js";
import { runDistillerOnce } from "../../src/distiller.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));
const FIXTURE_JSONL  = fileURLToPath(new URL("../fixtures/tool-call-session.jsonl", import.meta.url));
const FIXTURE_RESULT = fileURLToPath(new URL("../fixtures/distillation-result.json", import.meta.url));

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

describe("end-to-end distillation against a fixture session", () => {
  it("turns a real JSONL fixture into expected memory + chunk + facet + queue rows", async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    const sid = "11111111-1111-1111-1111-111111111111";
    await pool.query(
      `INSERT INTO sessions (session_id, username, encoded_project_dir, last_active)
       VALUES ($1, 'alice', '-w-pbmc3k', $2)`,
      [sid, tenMinAgo],
    );
    const jsonl = await readFile(FIXTURE_JSONL, "utf8");
    const stubResult = JSON.parse(await readFile(FIXTURE_RESULT, "utf8"));

    const summary = await runDistillerOnce(pool, {
      llm: async (transcript) => {
        expect(transcript).toContain(jsonl.split("\n").filter(Boolean)[0]!.slice(0, 40));
        return stubResult;
      },
      readTranscript: async () => jsonl,
      settleSeconds: 300,
      perUserLimit: 50,
      maxDistillTokens: 80_000,
      promptVersion: 1,
    });
    expect(summary.sessionsDistilled).toBe(1);

    const types = (await pool.query("SELECT type FROM memories ORDER BY type")).rows.map((r) => r.type);
    expect(types).toEqual(["feedback", "observation", "session_summary"]);

    const facets = (await pool.query(
      "SELECT key, value FROM memory_facets ORDER BY key, value",
    )).rows.map((r) => `${r.key}=${r.value}`);
    expect(facets).toContain("dataset=PBMC3K");
    expect(facets).toContain("tool=scanpy");

    const queued = (await pool.query("SELECT COUNT(*)::int AS n FROM embedder_queue")).rows[0].n;
    expect(queued).toBe(3);
  });
});

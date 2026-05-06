import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { runDistillerOnce } from "../src/distiller.js";
import { setCursor, getCursor } from "../src/distiller-cursor.js";
import { DistillerLlmError } from "../src/llm-client.js";

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

const SID = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

const RESULT = {
  summary: { name: "n", description: "d", body: "summary body" },
  observations: [
    { type: "finding" as const, name: "f", description: "d", body: "finding body", facets: {} },
  ],
};

describe("runDistillerOnce", () => {
  it("processes one settled session per user, writes rows, advances cursor", async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    await pool.query(
      `INSERT INTO sessions (session_id, username, encoded_project_dir, last_active)
       VALUES ($1,'alice','-w-p',$2)`,
      [SID(1), tenMinAgo],
    );

    const llmFn = vi.fn(async () => RESULT);
    const transcriptFn = vi.fn(async () => "<jsonl chunk>");

    const summary = await runDistillerOnce(pool, {
      llm: llmFn,
      readTranscript: transcriptFn,
      settleSeconds: 300,
      perUserLimit: 50,
      maxDistillTokens: 80_000,
      promptVersion: 1,
    });
    expect(summary.usersScanned).toBe(1);
    expect(summary.sessionsDistilled).toBe(1);
    expect(llmFn).toHaveBeenCalledTimes(1);
    expect(transcriptFn).toHaveBeenCalledTimes(1);

    const c = (await pool.query("SELECT COUNT(*)::int AS n FROM memories")).rows[0].n;
    expect(c).toBe(2); // summary + 1 observation

    const cursor = await getCursor(pool, "alice");
    expect(cursor.toISOString()).toBe(new Date(tenMinAgo).toISOString());
  });

  it("does not re-process a session whose last_active is at-or-before cursor", async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000);
    await pool.query(
      `INSERT INTO sessions (session_id, username, encoded_project_dir, last_active)
       VALUES ($1,'alice','-w-p',$2)`,
      [SID(2), tenMinAgo.toISOString()],
    );
    await setCursor(pool, "alice", tenMinAgo); // already past it

    const llmFn = vi.fn(async () => RESULT);
    const summary = await runDistillerOnce(pool, {
      llm: llmFn,
      readTranscript: async () => "x",
      settleSeconds: 300,
      perUserLimit: 50,
      maxDistillTokens: 80_000,
      promptVersion: 1,
    });
    expect(summary.sessionsDistilled).toBe(0);
    expect(llmFn).not.toHaveBeenCalled();
  });

  it("keeps the cursor in place when the LLM throws", async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    await pool.query(
      `INSERT INTO sessions (session_id, username, encoded_project_dir, last_active)
       VALUES ($1,'alice','-w-p',$2)`,
      [SID(3), tenMinAgo],
    );

    const llmFn = vi.fn(async () => { throw new Error("api down"); });
    const summary = await runDistillerOnce(pool, {
      llm: llmFn,
      readTranscript: async () => "x",
      settleSeconds: 300,
      perUserLimit: 50,
      maxDistillTokens: 80_000,
      promptVersion: 1,
    });
    expect(summary.sessionsFailed).toBe(1);
    const cursor = await getCursor(pool, "alice");
    expect(cursor.toISOString()).toBe("1970-01-01T00:00:00.000Z");
  });

  it("trims transcript to maxDistillTokens (rough char heuristic)", async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    await pool.query(
      `INSERT INTO sessions (session_id, username, encoded_project_dir, last_active)
       VALUES ($1,'alice','-w-p',$2)`,
      [SID(4), tenMinAgo],
    );

    const huge = "x".repeat(2_000_000);
    const captured: { transcript?: string } = {};
    await runDistillerOnce(pool, {
      llm: async (transcript) => { captured.transcript = transcript; return RESULT; },
      readTranscript: async () => huge,
      settleSeconds: 300,
      perUserLimit: 50,
      maxDistillTokens: 1000,
      promptVersion: 1,
    });
    // Trim budget = maxDistillTokens × CHARS_PER_TOKEN (2). Conservative cap.
    expect(captured.transcript!.length).toBeLessThan(huge.length);
    expect(captured.transcript!.length).toBeLessThanOrEqual(2 * 1000 + 100);
  });

  it("on DistillerLlmError, writes sentinel summary and advances cursor", async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    await pool.query(
      `INSERT INTO sessions (session_id, username, encoded_project_dir, last_active)
       VALUES ($1,'alice','-w-p',$2)`,
      [SID(5), tenMinAgo],
    );

    const llmFn = vi.fn(async () => {
      throw new DistillerLlmError("LLM output failed schema validation: missing field");
    });
    const summary = await runDistillerOnce(pool, {
      llm: llmFn,
      readTranscript: async () => "x",
      settleSeconds: 300,
      perUserLimit: 50,
      maxDistillTokens: 80_000,
      promptVersion: 1,
    });

    expect(summary.sessionsFailed).toBe(1);
    expect(summary.sessionsDistilled).toBe(0);

    const cursor = await getCursor(pool, "alice");
    expect(cursor.toISOString()).toBe(new Date(tenMinAgo).toISOString());

    const sentinel = await pool.query(
      "SELECT name, description, body FROM memories WHERE type = 'session_summary'",
    );
    expect(sentinel.rows).toHaveLength(1);
    expect(sentinel.rows[0].name).toBe("raw distillation failed");
    expect(sentinel.rows[0].description).toBe("schema-or-parse-fail");
    expect(sentinel.rows[0].body).toContain("schema validation");
  });

  it("on Anthropic 400, writes sentinel summary and advances cursor", async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    await pool.query(
      `INSERT INTO sessions (session_id, username, encoded_project_dir, last_active)
       VALUES ($1,'alice','-w-p',$2)`,
      [SID(6), tenMinAgo],
    );

    const apiErr = Object.assign(new Error("prompt is too long: 213503 tokens > 200000"), {
      status: 400,
    });
    const llmFn = vi.fn(async () => { throw apiErr; });
    const summary = await runDistillerOnce(pool, {
      llm: llmFn,
      readTranscript: async () => "x",
      settleSeconds: 300,
      perUserLimit: 50,
      maxDistillTokens: 80_000,
      promptVersion: 1,
    });

    expect(summary.sessionsFailed).toBe(1);
    const cursor = await getCursor(pool, "alice");
    expect(cursor.toISOString()).toBe(new Date(tenMinAgo).toISOString());
    const sentinel = await pool.query(
      "SELECT description FROM memories WHERE type = 'session_summary'",
    );
    expect(sentinel.rows[0].description).toBe("anthropic-400");
  });
});

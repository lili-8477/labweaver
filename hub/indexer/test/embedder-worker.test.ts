import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createServer, type Server } from "node:http";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { runEmbedderOnce } from "../src/embedder-worker.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
let pg: StartedPostgreSqlContainer;
let pool: Pool;
let stub: Server;
let stubUrl: string;
let stubMode: "ok" | "fail" = "ok";

beforeAll(async () => {
  pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await runMigrations({ pool, migrationsDir: MIGRATIONS_DIR, lockKey: 0x62696f666c77n });
  await new Promise<void>((resolve) => {
    stub = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (stubMode === "fail") {
          res.writeHead(500); res.end("nope"); return;
        }
        const { texts } = JSON.parse(body);
        const vecs = texts.map(() => Array.from({ length: 384 }, () => 0.01));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ vectors: vecs }));
      });
    }).listen(0, "127.0.0.1", () => {
      const a = stub.address();
      if (typeof a === "object" && a) stubUrl = `http://127.0.0.1:${a.port}`;
      resolve();
    });
  });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
  await new Promise<void>((r) => stub.close(() => r()));
}, 30_000);

beforeEach(async () => {
  stubMode = "ok";
  await pool.query("TRUNCATE memories CASCADE");
});

async function seedChunk(content: string): Promise<number> {
  const m = await pool.query<{ memory_id: string }>(
    `INSERT INTO memories (memory_id, username, type, source, name, description, body, content_hash)
     VALUES (gen_random_uuid(),'alice','observation','distilled','n','d',$1,$2::bytea)
     RETURNING memory_id`,
    [content, Buffer.from(content)],
  );
  const c = await pool.query<{ chunk_id: string }>(
    `INSERT INTO memory_chunks (memory_id, chunk_idx, content) VALUES ($1, 0, $2) RETURNING chunk_id`,
    [m.rows[0]!.memory_id, content],
  );
  await pool.query("INSERT INTO embedder_queue (chunk_id) VALUES ($1)", [c.rows[0]!.chunk_id]);
  return Number(c.rows[0]!.chunk_id);
}

describe("runEmbedderOnce", () => {
  it("drains queued chunks and writes embeddings", async () => {
    await seedChunk("hello");
    await seedChunk("world");
    const summary = await runEmbedderOnce(pool, { embedderUrl: stubUrl, batchSize: 64 });
    expect(summary.embedded).toBe(2);
    const remaining = (await pool.query("SELECT COUNT(*)::int AS n FROM embedder_queue")).rows[0].n;
    expect(remaining).toBe(0);
    const filled = (await pool.query("SELECT COUNT(*)::int AS n FROM memory_chunks WHERE embedding IS NOT NULL")).rows[0].n;
    expect(filled).toBe(2);
  });

  it("on embedder failure, increments attempts and leaves rows in queue", async () => {
    const cid = await seedChunk("hello");
    stubMode = "fail";
    const summary = await runEmbedderOnce(pool, { embedderUrl: stubUrl, batchSize: 64 });
    expect(summary.failed).toBe(1);
    const r = await pool.query("SELECT attempts, last_error FROM embedder_queue WHERE chunk_id = $1", [cid]);
    expect(r.rows[0].attempts).toBe(1);
    expect(r.rows[0].last_error).toBeTruthy();
  });

  it("respects batchSize and processes oldest first", async () => {
    const c1 = await seedChunk("a");
    const c2 = await seedChunk("b");
    const c3 = await seedChunk("c");
    await runEmbedderOnce(pool, { embedderUrl: stubUrl, batchSize: 2 });
    // Two oldest processed; one remains.
    const remaining = await pool.query("SELECT chunk_id FROM embedder_queue ORDER BY chunk_id");
    expect(remaining.rows.map((r) => Number(r.chunk_id))).toEqual([c3]);
    void c1; void c2;
  });
});

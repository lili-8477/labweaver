import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";

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

describe("migration 0006 — memories", () => {
  it("creates memories table with all columns and constraints", async () => {
    const cols = await pool.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'memories' ORDER BY ordinal_position`,
    );
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
    expect(byName.memory_id).toMatchObject({ data_type: "uuid", is_nullable: "NO" });
    expect(byName.username).toMatchObject({ data_type: "text", is_nullable: "NO" });
    expect(byName.project_dir).toMatchObject({ is_nullable: "YES" });
    expect(byName.type).toMatchObject({ data_type: "text", is_nullable: "NO" });
    expect(byName.source).toMatchObject({ data_type: "text", is_nullable: "NO" });
    expect(byName.content_hash).toMatchObject({ data_type: "bytea", is_nullable: "NO" });
    expect(byName.hit_count).toMatchObject({ data_type: "integer", is_nullable: "NO" });
    expect(byName.deleted_at).toMatchObject({ is_nullable: "YES" });
  });

  it("rejects unknown type via CHECK constraint", async () => {
    await expect(
      pool.query(
        `INSERT INTO memories (memory_id, username, type, source, name, description, body, content_hash)
         VALUES (gen_random_uuid(), 'alice', 'unknown', 'user', 'n', 'd', 'b', '\\x00'::bytea)`,
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("enforces UNIQUE(username, project_dir, type, content_hash)", async () => {
    const h = "\\xdeadbeef";
    await pool.query(
      `INSERT INTO memories (memory_id, username, project_dir, type, source, name, description, body, content_hash)
       VALUES (gen_random_uuid(), 'alice', '-w-p', 'observation', 'distilled', 'n', 'd', 'b', $1::bytea)`,
      [h],
    );
    const dup = await pool.query(
      `INSERT INTO memories (memory_id, username, project_dir, type, source, name, description, body, content_hash)
       VALUES (gen_random_uuid(), 'alice', '-w-p', 'observation', 'distilled', 'n2', 'd2', 'b2', $1::bytea)
       ON CONFLICT (username, project_dir, type, content_hash) DO NOTHING
       RETURNING memory_id`,
      [h],
    );
    expect(dup.rowCount).toBe(0);
  });

  it("dedups across NULL project_dir (user-scope memories)", async () => {
    const h = "\\xcafebabe";
    await pool.query(
      `INSERT INTO memories (memory_id, username, project_dir, type, source, name, description, body, content_hash)
       VALUES (gen_random_uuid(), 'bob', NULL, 'user', 'user', 'n', 'd', 'b', $1::bytea)`,
      [h],
    );
    const dup = await pool.query(
      `INSERT INTO memories (memory_id, username, project_dir, type, source, name, description, body, content_hash)
       VALUES (gen_random_uuid(), 'bob', NULL, 'user', 'user', 'n2', 'd2', 'b2', $1::bytea)
       ON CONFLICT (username, project_dir, type, content_hash) DO NOTHING
       RETURNING memory_id`,
      [h],
    );
    expect(dup.rowCount).toBe(0);
  });

  it("registers in schema_migrations as version 6", async () => {
    const v = await pool.query("SELECT version FROM schema_migrations WHERE version = 6");
    expect(v.rowCount).toBe(1);
  });
});

describe("migration 0007 — memory_chunks", () => {
  it("creates the vector extension", async () => {
    const ext = await pool.query(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'",
    );
    expect(ext.rowCount).toBe(1);
  });

  it("creates memory_chunks with embedding vector(384) and generated tsv", async () => {
    const cols = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'memory_chunks' ORDER BY ordinal_position`,
    );
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r.data_type]));
    expect(byName.chunk_id).toBe("bigint");
    expect(byName.memory_id).toBe("uuid");
    expect(byName.chunk_idx).toBe("integer");
    expect(byName.content).toBe("text");
    expect(byName.embedding).toBe("USER-DEFINED"); // pgvector vector type
    expect(byName.tsv).toBe("tsvector");
  });

  it("inserts a chunk and round-trips a 384-dim embedding", async () => {
    const m = await pool.query(
      `INSERT INTO memories (memory_id, username, type, source, name, description, body, content_hash)
       VALUES (gen_random_uuid(), 'alice', 'observation', 'distilled', 'n', 'd', 'b', '\\xab'::bytea)
       RETURNING memory_id`,
    );
    const mid = m.rows[0].memory_id;
    const vec = "[" + Array.from({ length: 384 }, () => "0.01").join(",") + "]";
    await pool.query(
      `INSERT INTO memory_chunks (memory_id, chunk_idx, content, embedding)
       VALUES ($1, 0, 'hello world', $2::vector)`,
      [mid, vec],
    );
    const got = await pool.query(
      "SELECT content, tsv @@ plainto_tsquery('english','hello') AS hit FROM memory_chunks WHERE memory_id = $1",
      [mid],
    );
    expect(got.rows[0].content).toBe("hello world");
    expect(got.rows[0].hit).toBe(true);
  });

  it("creates the HNSW vector index", async () => {
    const idx = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'memory_chunks_embedding_idx'`,
    );
    expect(idx.rows[0].indexdef.toLowerCase()).toContain("hnsw");
    expect(idx.rows[0].indexdef.toLowerCase()).toContain("vector_cosine_ops");
  });

  it("cascades delete from memories to memory_chunks", async () => {
    const m = await pool.query(
      `INSERT INTO memories (memory_id, username, type, source, name, description, body, content_hash)
       VALUES (gen_random_uuid(), 'alice', 'observation', 'distilled', 'n', 'd', 'b', '\\xcc'::bytea)
       RETURNING memory_id`,
    );
    const mid = m.rows[0].memory_id;
    await pool.query(
      `INSERT INTO memory_chunks (memory_id, chunk_idx, content)
       VALUES ($1, 0, 'ephemeral chunk')`,
      [mid],
    );
    await pool.query("DELETE FROM memories WHERE memory_id = $1", [mid]);
    const orphan = await pool.query(
      "SELECT 1 FROM memory_chunks WHERE memory_id = $1",
      [mid],
    );
    expect(orphan.rowCount).toBe(0);
  });
});

describe("migration 0008 — facets, embedder_queue, distill_cursor", () => {
  it("creates memory_facets with composite PK", async () => {
    const pk = await pool.query(
      `SELECT a.attname FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'memory_facets'::regclass AND i.indisprimary
        ORDER BY a.attname`,
    );
    expect(pk.rows.map((r) => r.attname)).toEqual(["key", "memory_id", "value"]);
  });

  it("creates embedder_queue keyed on chunk_id", async () => {
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='embedder_queue' ORDER BY ordinal_position`,
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names).toEqual(["chunk_id", "attempts", "last_error", "enqueued_at"]);
  });

  it("creates memory_distill_cursor with PK = username and 1970-01-01 default", async () => {
    await pool.query(
      `INSERT INTO memory_distill_cursor (username) VALUES ('alice')
       ON CONFLICT (username) DO NOTHING`,
    );
    const got = await pool.query(
      "SELECT EXTRACT(YEAR FROM last_seen_session_last_active) AS y FROM memory_distill_cursor WHERE username='alice'",
    );
    expect(Number(got.rows[0].y)).toBe(1970);
  });

  it("cascades embedder_queue delete when memory_chunks row is removed", async () => {
    const m = await pool.query(
      `INSERT INTO memories (memory_id, username, type, source, name, description, body, content_hash)
       VALUES (gen_random_uuid(), 'alice', 'observation', 'distilled', 'n', 'd', 'b', '\\xee'::bytea)
       RETURNING memory_id`,
    );
    const c = await pool.query(
      `INSERT INTO memory_chunks (memory_id, chunk_idx, content) VALUES ($1, 0, 'x') RETURNING chunk_id`,
      [m.rows[0].memory_id],
    );
    await pool.query("INSERT INTO embedder_queue (chunk_id) VALUES ($1)", [c.rows[0].chunk_id]);
    await pool.query("DELETE FROM memory_chunks WHERE chunk_id = $1", [c.rows[0].chunk_id]);
    const orphan = await pool.query("SELECT 1 FROM embedder_queue WHERE chunk_id = $1", [c.rows[0].chunk_id]);
    expect(orphan.rowCount).toBe(0);
  });

  it("cascades memory_facets delete when memories row is removed", async () => {
    const m = await pool.query(
      `INSERT INTO memories (memory_id, username, type, source, name, description, body, content_hash)
       VALUES (gen_random_uuid(), 'alice', 'observation', 'distilled', 'n', 'd', 'b', '\\xff'::bytea)
       RETURNING memory_id`,
    );
    await pool.query(
      `INSERT INTO memory_facets (memory_id, key, value) VALUES ($1, 'gene', 'TP53')`,
      [m.rows[0].memory_id],
    );
    await pool.query("DELETE FROM memories WHERE memory_id = $1", [m.rows[0].memory_id]);
    const orphan = await pool.query("SELECT 1 FROM memory_facets WHERE memory_id = $1", [m.rows[0].memory_id]);
    expect(orphan.rowCount).toBe(0);
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { importDir, importEntries, importedFiles, type ImportEntry } from "../src/memory-import.js";
import { createBuildJob, listBuildJobs, updateBuildJob } from "../src/memory-build-jobs.js";
import { searchMemories } from "../src/memory-search.js";

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
  await pool.query("TRUNCATE memories, memory_build_jobs CASCADE");
});

const entry = (over: Partial<ImportEntry> = {}): ImportEntry => ({
  category: "data_record",
  name: "Order 20643R",
  description: "NovaSeq order 20643R, 12 libraries",
  body: "order_id: 20643R\nlibraries: 12\nplatform: NovaSeq X",
  facets: { order_id: ["20643R"] },
  origin_kind: "file",
  origin: "local_projects/ngs/orders.csv",
  origin_sha256: "ab".repeat(32),
  ...over,
});

describe("importEntries", () => {
  it("writes lab reference rows from the import source, in the category's directory, with provenance", async () => {
    const out = await importEntries({
      pool, username: "alice", project_dir: "local_projects/ngs", builder_version: 1,
      entries: [entry(), entry({ category: "protocol", name: "RNA extraction SOP", body: "1. Lyse cells", facets: {} })],
    });
    expect(out).toMatchObject({ created: 2, duplicates: 0 });

    const rows = await pool.query(
      `SELECT memory_id, type, source, domain, dir_key, scope FROM memories ORDER BY name`);
    expect(rows.rows.map((r) => [r.type, r.source, r.domain, r.dir_key, r.scope])).toEqual([
      ["reference", "import", "lab", "project/data-records", "project"],
      ["reference", "import", "lab", "project/protocols", "project"],
    ]);

    const facets = await pool.query(
      `SELECT key, value FROM memory_facets f JOIN memories m USING (memory_id)
        WHERE m.name = 'Order 20643R' ORDER BY key`);
    const byKey = Object.fromEntries(facets.rows.map((r) => [r.key, r.value]));
    expect(byKey).toMatchObject({
      category: "data_record", order_id: "20643R", origin_kind: "file",
      origin: "local_projects/ngs/orders.csv", origin_sha256: "ab".repeat(32), builder_version: "1",
    });
    expect(byKey.imported_at).toMatch(/^\d{4}-\d\d-\d\dT/);

    const audit = await pool.query(`SELECT actor, action FROM memory_audit_log`);
    expect(audit.rows).toEqual([{ actor: "alice", action: "write" }, { actor: "alice", action: "write" }]);
    // Only the protocol is embedded: a data record is IDs and fields, found by keywords.
    const queued = await pool.query(
      `SELECT m.name FROM embedder_queue q JOIN memory_chunks c USING (chunk_id) JOIN memories m USING (memory_id)`);
    expect(queued.rows.map((r) => r.name)).toEqual(["RNA extraction SOP"]);
  });

  it("embeds protocols, pipelines and references, not inventory or data records", async () => {
    await importEntries({ pool, username: "alice", project_dir: null, builder_version: 2, entries: [
      entry({ category: "inventory", name: "TRIzol", body: "Reagent: TRIzol\nLot: L123" }),
      entry({ category: "data_record" }),
      entry({ category: "protocol", name: "SOP", body: "1. Lyse" }),
      entry({ category: "pipeline", name: "QC", body: "fastqc then multiqc" }),
      entry({ category: "reference", name: "Core page", body: "Prices" }),
    ] });
    const queued = await pool.query(
      `SELECT m.name FROM embedder_queue q JOIN memory_chunks c USING (chunk_id) JOIN memories m USING (memory_id) ORDER BY 1`);
    expect(queued.rows.map((r) => r.name)).toEqual(["Core page", "QC", "SOP"]);
  });

  it("is idempotent: the same entries again create nothing", async () => {
    const args = { pool, username: "alice", project_dir: null, builder_version: 1, entries: [entry()] };
    await importEntries(args);
    expect(await importEntries(args)).toMatchObject({ created: 0, duplicates: 1, memory_ids: [] });
    const n = await pool.query(`SELECT count(*)::int AS n FROM memories`);
    expect(n.rows[0].n).toBe(1);
  });

  it("files a reference entry in the scope's default reference directory", async () => {
    await importEntries({ pool, username: "alice", project_dir: null, builder_version: 1,
      entries: [entry({ category: "reference", name: "Core facility page" })] });
    const r = await pool.query(`SELECT dir_key FROM memories`);
    expect(r.rows[0].dir_key).toBe("user/notes");
  });

  it("maps every category to a directory that exists in every scope", async () => {
    const dirs = new Set((await pool.query(`SELECT dir_key FROM memory_dirs`)).rows.map((r) => r.dir_key));
    for (const scope of ["user", "project", "org"] as const) {
      for (const c of ["protocol", "inventory", "data_record", "pipeline", "reference"] as const) {
        expect(dirs.has(importDir(scope, c)), `${scope}/${c}`).toBe(true);
      }
    }
  });
});

describe("importedFiles", () => {
  it("reports which source checksums already have live imported memories in the scope", async () => {
    const other = "cd".repeat(32);
    await importEntries({ pool, username: "alice", project_dir: "-w-p", builder_version: 1, entries: [entry()] });
    const seen = (args: { username?: string; project_dir?: string | null }) => importedFiles({
      pool, username: args.username ?? "alice", project_dir: args.project_dir === undefined ? "-w-p" : args.project_dir,
      sha256s: ["ab".repeat(32), other],
    });
    expect(await seen({})).toEqual(["ab".repeat(32)]);
    // Another scope or member has not imported it.
    expect(await seen({ project_dir: null })).toEqual([]);
    expect(await seen({ username: "bob" })).toEqual([]);
    // Forgotten memories do not count: the file can be imported again.
    await pool.query(`UPDATE memories SET deleted_at = now()`);
    expect(await seen({})).toEqual([]);
  });
});

describe("searching imported memories", () => {
  it("finds the data record for an exact order ID first", async () => {
    await importEntries({ pool, username: "alice", project_dir: null, builder_version: 1, entries: [
      entry({ category: "protocol", name: "Library prep SOP", body: "Prepare libraries before sequencing orders are placed.", facets: {} }),
      entry(),
      entry({ name: "Order 20701R", body: "order_id: 20701R\nlibraries: 8", facets: { order_id: ["20701R"] } }),
    ] });
    const hits = await searchMemories({
      pool, username: "alice", project_dir: null, query: "20643R", limit: 5,
      embedderClient: { embedTexts: async () => { throw new Error("down"); } },
    });
    expect(hits[0]!.name).toBe("Order 20643R");
  });
});

describe("build jobs", () => {
  it("creates, updates and lists a member's jobs, newest first and only their own", async () => {
    const a = await createBuildJob(pool, { username: "alice", project_dir: "local_projects/ngs", origin_kind: "folder", origin: "local_projects/ngs/data" });
    await createBuildJob(pool, { username: "bob", project_dir: null, origin_kind: "file", origin: "local_projects/x/a.pdf" });
    const b = await createBuildJob(pool, { username: "alice", project_dir: null, origin_kind: "file", origin: "local_projects/ngs/sop.pdf" });

    await updateBuildJob(pool, { username: "alice", job_id: a, status: "running", files_seen: 4, files_parsed: 3, files_skipped: 1 });
    await updateBuildJob(pool, { username: "alice", job_id: a, status: "done", entries_created: 7, duplicates: 2, report: { skipped: [{ path: "x.bam", reason: "binary data" }] } });
    // Another member cannot touch alice's job.
    await updateBuildJob(pool, { username: "bob", job_id: a, status: "failed", error: "nope" });

    const jobs = await listBuildJobs(pool, { username: "alice" });
    expect(jobs.map((j) => j.job_id)).toEqual([b, a]);
    expect(jobs[1]).toMatchObject({
      status: "done", files_seen: 4, files_parsed: 3, files_skipped: 1, entries_created: 7, duplicates: 2,
      report: { skipped: [{ path: "x.bam", reason: "binary data" }] }, error: null,
    });
    expect(jobs[1]!.finished_at).not.toBeNull();
    expect(jobs[0]!.status).toBe("queued");
  });
});

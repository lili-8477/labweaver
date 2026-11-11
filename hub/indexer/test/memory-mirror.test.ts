import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { importEntries, type ImportEntry } from "../src/memory-import.js";
import { writeUserMemory, forgetMemory } from "../src/memory-write.js";
import { ownerSignatures, syncOwner } from "../src/memory-mirror.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
let pg: StartedPostgreSqlContainer;
let pool: Pool;
let root: string;

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
  await pool.query("TRUNCATE memories CASCADE");
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mirror-"));
});

const entry = (over: Partial<ImportEntry> = {}): ImportEntry => ({
  category: "protocol", name: "RNA extraction SOP", description: "TRIzol RNA extraction",
  body: "1. Lyse cells in TRIzol.", origin_kind: "file", origin: "local_projects/ngs/sop.md",
  origin_sha256: "ab".repeat(32), ...over,
});

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p); else out.push(path.relative(dir, p));
    }
  };
  await walk(dir);
  return out.sort();
}

describe("syncOwner", () => {
  it("writes a member's memories as markdown under memory/<scope>/<folder>/, with a frontmatter header", async () => {
    const [p] = (await importEntries({ pool, username: "alice", project_dir: null, builder_version: 2, entries: [entry()] })).memory_ids;
    await importEntries({ pool, username: "alice", project_dir: "-workspace-local_projects-ngs", builder_version: 2, entries: [
      entry({ category: "data_record", name: "Order 20643R", body: "order_id: 20643R", facets: { order_id: ["20643R"] } }),
    ] });
    await writeUserMemory({ pool, username: "alice", scope: "user", project_dir: null, type: "feedback",
      name: "Prefer Seurat", description: "d", body: "Use Seurat conventions.", domain: "lab" });
    await importEntries({ pool, username: "bob", project_dir: null, builder_version: 2, entries: [entry({ name: "Bob's SOP" })] });

    expect(await syncOwner(pool, root, "alice")).toMatchObject({ written: 3, removed: 0 });
    const mine = path.join(root, "users", "alice");
    expect(await files(mine)).toEqual([
      "README.md",
      `project/ngs/data-records/order-20643r-${(await idOf("Order 20643R")).slice(0, 8)}.md`,
      `user/preferences/prefer-seurat-${(await idOf("Prefer Seurat")).slice(0, 8)}.md`,
      `user/protocols/rna-extraction-sop-${p!.slice(0, 8)}.md`,
    ]);
    // The org copy is mounted at memory/org, so the folder is always there.
    expect((await fs.stat(path.join(mine, "org"))).isDirectory()).toBe(true);

    const md = await fs.readFile(path.join(mine, `user/protocols/rna-extraction-sop-${p!.slice(0, 8)}.md`), "utf8");
    expect(md).toMatch(new RegExp(`^---\\nid: "${p}"\\nname: "RNA extraction SOP"\\n`));
    expect(md).toContain('source: "import"');
    expect(md).toContain('  category: ["protocol"]');
    expect(md).toContain("\n---\n\n# RNA extraction SOP\n\n1. Lyse cells in TRIzol.\n");
  });

  it("names a project the same whichever way its folder was encoded", async () => {
    for (const enc of ["-workspace-local_projects-gaussian-tutorial", "-workspace-local-projects-gaussian-tutorial",
      "/workspace/local_projects/gaussian-tutorial"]) {
      await importEntries({ pool, username: "alice", project_dir: enc, builder_version: 2, entries: [entry({ name: `SOP ${enc.length}` })] });
    }
    await syncOwner(pool, root, "alice");
    const projects = await fs.readdir(path.join(root, "users", "alice", "project"));
    expect(projects).toEqual(["gaussian-tutorial"]);
  });

  it("removes the file of a forgotten memory and rewrites nothing that did not change", async () => {
    const [a, b] = (await importEntries({ pool, username: "alice", project_dir: null, builder_version: 2, entries: [
      entry(), entry({ category: "pipeline", name: "QC", body: "fastqc" }),
    ] })).memory_ids;
    await syncOwner(pool, root, "alice");
    expect(await syncOwner(pool, root, "alice")).toEqual({ written: 0, removed: 0 });

    await forgetMemory({ pool, username: "alice", memoryId: b! });
    expect(await syncOwner(pool, root, "alice")).toEqual({ written: 0, removed: 1 });
    expect(await files(path.join(root, "users", "alice"))).toEqual(["README.md", `user/protocols/rna-extraction-sop-${a!.slice(0, 8)}.md`]);
  });

  it("writes the org copy without restricted or IRB memories", async () => {
    const [open, closed] = (await importEntries({ pool, username: "__org__", project_dir: null, builder_version: 2, entries: [
      entry({ name: "Lab SOP" }), entry({ name: "Patient cohort" }),
    ] })).memory_ids;
    await pool.query(`UPDATE memories SET access_class = 'irb' WHERE memory_id = $1`, [closed]);
    await syncOwner(pool, root, "__org__");
    expect(await files(path.join(root, "org"))).toEqual(["README.md", `protocols/lab-sop-${open!.slice(0, 8)}.md`]);
  });
});

describe("ownerSignatures", () => {
  it("changes for the owner whose memories changed, and only theirs", async () => {
    const [a] = (await importEntries({ pool, username: "alice", project_dir: null, builder_version: 2, entries: [entry()] })).memory_ids;
    await importEntries({ pool, username: "bob", project_dir: null, builder_version: 2, entries: [entry()] });
    const before = await ownerSignatures(pool);
    await forgetMemory({ pool, username: "alice", memoryId: a! });
    const after = await ownerSignatures(pool);
    expect(after.get("alice")).not.toBe(before.get("alice"));
    expect(after.get("bob")).toBe(before.get("bob"));
  });
});

async function idOf(name: string): Promise<string> {
  return (await pool.query(`SELECT memory_id FROM memories WHERE name = $1`, [name])).rows[0].memory_id;
}

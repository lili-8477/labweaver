import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { writeUserMemory, recordFeedback, getMemory, listDirs } from "../src/memory-repo.js";
import { proposeExperiences, PROMOTE_AFTER_SUCCESSES } from "../src/experience-promotion.js";
import { decideShareRequest } from "../src/share-repo.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
let pg: StartedPostgreSqlContainer;
let pool: Pool;
const managers = ["pi"];

beforeAll(async () => {
  pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await runMigrations({ pool, migrationsDir: MIGRATIONS_DIR, lockKey: 0x657870n });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

beforeEach(async () => {
  await pool.query("TRUNCATE memories, share_requests CASCADE");
});

async function experience(name: string, dir = "user/experience"): Promise<string> {
  const { memory_id } = await writeUserMemory({ domain: "lab",
    pool, username: "alice", scope: "user", project_dir: null,
    type: "project", name, description: "d", body: `${name} body`, dir,
  });
  return memory_id!;
}

async function succeed(id: string, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await recordFeedback({ pool, username: "alice", memory_ids: [id], outcome: "success" });
  }
}

const requests = async () =>
  (await pool.query(`SELECT share_id, artifact_ref, requester, status FROM share_requests`)).rows;

describe("proposeExperiences", () => {
  it("proposes personal experience once it reaches the success threshold, exactly once", async () => {
    const id = await experience("filter low-quality cells before doublet removal");
    await succeed(id, PROMOTE_AFTER_SUCCESSES - 1);
    expect(await proposeExperiences({ pool, managers, memory_ids: [id] })).toEqual({ proposed: [] });

    await succeed(id, 1);
    expect(await proposeExperiences({ pool, managers, memory_ids: [id] })).toEqual({ proposed: [id] });
    expect(await proposeExperiences({ pool, managers, memory_ids: [id] })).toEqual({ proposed: [] });
    expect(await requests()).toEqual([
      expect.objectContaining({ artifact_ref: id, requester: "alice", status: "pending" }),
    ]);
  });

  it("ignores other directories and does nothing without managers", async () => {
    const note = await experience("a note", "user/notes");
    const exp  = await experience("an experience");
    await succeed(note, 5);
    await succeed(exp, 5);
    expect(await proposeExperiences({ pool, managers: [], memory_ids: [note, exp] })).toEqual({ proposed: [] });
    expect(await proposeExperiences({ pool, managers, memory_ids: [note, exp] })).toEqual({ proposed: [exp] });
  });

  it("an approved proposal lands in org/experience", async () => {
    const id = await experience("pin scanpy version per project");
    await succeed(id, PROMOTE_AFTER_SUCCESSES);
    await proposeExperiences({ pool, managers, memory_ids: [id] });
    const [req] = await requests();

    const r = await decideShareRequest({
      pool, actor: "pi", managers, shareId: req.share_id, decision: "approve",
      workspacesRoot: "/nope", shareSnapshotsDir: "/nope",
    });
    expect(r.ok).toBe(true);
    const promoted = await pool.query(`SELECT memory_id FROM memories WHERE username = '__org__'`);
    expect((await getMemory({ pool, memoryId: promoted.rows[0].memory_id, username: "alice" }))!.dir_key).toBe("org/experience");
  });
});

describe("listDirs all_projects", () => {
  it("counts project directories across every project of the caller", async () => {
    for (const p of ["-a", "-b"]) {
      await writeUserMemory({ domain: "lab",
        pool, username: "alice", scope: "project", project_dir: p,
        type: "project", name: `n${p}`, description: "d", body: `b${p}`,
      });
    }
    const dirs = await listDirs({ pool, username: "alice", project_dir: null, all_projects: true });
    expect(dirs.find((d) => d.dir_key === "project/decisions")!.entry_count).toBe(2);
    const scoped = await listDirs({ pool, username: "alice", project_dir: null });
    expect(scoped.some((d) => d.scope === "project")).toBe(false);
  });
});

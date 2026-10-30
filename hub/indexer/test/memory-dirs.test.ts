import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runMigrations } from "../src/migrate.js";
import { contentHash } from "../src/content-hash.js";
import { defaultDir, scopeOf } from "../src/memory-dirs.js";
import { getContext, getDir, listDirs, listMemories, memoryTree, writeUserMemory } from "../src/memory-repo.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const LOCK = 0x62696f666c77n;
let pg: StartedPostgreSqlContainer;
let pool: Pool;
let preDirsMigrations: string;

const V1_TYPES = ["user", "feedback", "project", "reference", "session_summary", "observation"];
const OWNERS: Array<[string, string | null]> = [["alice", null], ["alice", "-w-p"], ["__org__", null]];

// Bring the DB up to 0016 only, so the backfill in 0017 runs over pre-existing rows.
beforeAll(async () => {
  pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  preDirsMigrations = await mkdtemp(path.join(tmpdir(), "mig-"));
  for (const f of await readdir(MIGRATIONS_DIR)) {
    const v = Number(/^(\d+)_/.exec(f)?.[1]);
    if (f.endsWith(".sql") && v < 17) await cp(path.join(MIGRATIONS_DIR, f), path.join(preDirsMigrations, f));
  }
  await runMigrations({ pool, migrationsDir: preDirsMigrations, lockKey: LOCK });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
  if (preDirsMigrations) await rm(preDirsMigrations, { recursive: true, force: true });
}, 30_000);

describe("migration 0017 backfill", () => {
  it("assigns every existing row (deleted ones too) the directory defaultDir() picks", async () => {
    let n = 0;
    for (const [username, project_dir] of OWNERS) {
      for (const type of V1_TYPES) {
        n++;
        await pool.query(
          `INSERT INTO memories (memory_id, username, project_dir, type, source, name, description, body,
                                 content_hash, deleted_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'distilled', $4, 'd', 'b', $5, $6)`,
          [username, project_dir, type, `${username}-${project_dir}-${type}`,
           contentHash({ body: `b${n}`, promptVersion: 1 }), n % 2 === 0 ? new Date() : null],
        );
      }
    }
    await runMigrations({ pool, migrationsDir: MIGRATIONS_DIR, lockKey: LOCK });

    const r = await pool.query<{ username: string; project_dir: string | null; type: string; scope: string; dir_key: string }>(
      `SELECT username, project_dir, type, scope, dir_key FROM memories`,
    );
    expect(r.rowCount).toBe(n);
    for (const row of r.rows) {
      expect(row.scope).toBe(scopeOf(row.username, row.project_dir));
      expect(row.dir_key).toBe(defaultDir(scopeOf(row.username, row.project_dir), row.type));
    }
    // Spot-check the mapping itself.
    const pick = (u: string, p: string | null, t: string) =>
      r.rows.find((x) => x.username === u && x.project_dir === p && x.type === t)!.dir_key;
    expect(pick("alice", null, "feedback")).toBe("user/preferences");
    expect(pick("alice", null, "observation")).toBe("user/experience");
    expect(pick("alice", null, "session_summary")).toBe("user/notes");
    expect(pick("alice", "-w-p", "reference")).toBe("project/entities");
    expect(pick("alice", "-w-p", "session_summary")).toBe("project/trajectories");
    expect(pick("alice", "-w-p", "feedback")).toBe("project/decisions");
    expect(pick("__org__", null, "project")).toBe("org/entities");
    expect(pick("__org__", null, "reference")).toBe("org/references");
    expect(pick("__org__", null, "feedback")).toBe("org/experience");
  });

  it("rejects a directory from another scope (memories_dir_fk)", async () => {
    await expect(pool.query(
      `INSERT INTO memories (memory_id, username, project_dir, type, source, name, description, body,
                             content_hash, dir_key)
       VALUES (gen_random_uuid(), 'alice', NULL, 'user', 'user', 'n', 'd', 'b', '\\x01'::bytea, 'project/decisions')`,
    )).rejects.toThrow(/memories_dir_fk/);
  });

  it("allows the 'merge' audit action", async () => {
    const m = await pool.query<{ memory_id: string }>(`SELECT memory_id FROM memories LIMIT 1`);
    await pool.query(
      `INSERT INTO memory_audit_log (memory_id, actor, action) VALUES ($1, 'alice', 'merge')`,
      [m.rows[0]!.memory_id],
    );
  });
});

describe("directories and tree", () => {
  beforeEach(async () => {
    await pool.query("TRUNCATE memories CASCADE");
  });

  async function write(
    username: string, scope: "user" | "project", project_dir: string | null, name: string,
    extra: { dir_key?: string; type?: "user" | "feedback" | "project" | "reference" } = {},
  ): Promise<string> {
    const { memory_id } = await writeUserMemory({
      pool, username, scope, project_dir, type: extra.type ?? "user", name,
      description: `${name} desc`, body: `${name} body`, dir_key: extra.dir_key,
    });
    return memory_id!;
  }

  it("listDirs: user+org directories always, project ones only with a project", async () => {
    await write("alice", "user", null, "pref");
    await write("alice", "project", "-w-p", "dec");
    await write("alice", "project", "-w-other", "elsewhere");

    const noProject = await listDirs({ pool, username: "alice", project_dir: null });
    expect(noProject.map((d) => d.dir_key)).toEqual([
      "org/entities", "org/experience", "org/references",
      "user/preferences", "user/experience", "user/notes",
    ]);

    const withProject = await listDirs({ pool, username: "alice", project_dir: "-w-p", cap: 1 });
    expect(withProject).toHaveLength(9);
    const byKey = Object.fromEntries(withProject.map((d) => [d.dir_key, d]));
    expect(byKey["project/decisions"]!.entry_count).toBe(1);          // -w-other not counted
    expect(byKey["user/preferences"]).toMatchObject({ entry_count: 1, over_cap: false, scope: "user" });
    expect(byKey["user/notes"]).toMatchObject({ entry_count: 0, updated_at: null });
    expect(byKey["project/decisions"]!.l0).toBe("Decisions and findings, with dates and evidence");
  });

  it("listMemories: dir_key narrows the list to one directory", async () => {
    await write("alice", "user", null, "pref", { dir_key: "user/preferences" });
    await write("alice", "user", null, "note", { dir_key: "user/notes" });
    const all = await listMemories({ pool, username: "alice", project_dir: null, scope: "user" });
    expect(all.items.map((i) => i.name).sort()).toEqual(["note", "pref"]);
    const notes = await listMemories({ pool, username: "alice", project_dir: null, dir_key: "user/notes" });
    expect(notes.items.map((i) => i.name)).toEqual(["note"]);
  });

  it("getDir: L1 entries ranked by the prior (hits), only the caller's", async () => {
    const a = await write("alice", "user", null, "a");
    const b = await write("alice", "user", null, "b");
    await write("bob", "user", null, "bobs");
    await pool.query(`UPDATE memories SET hit_count = 10 WHERE memory_id = $1`, [b]);

    const dir = await getDir({ pool, username: "alice", project_dir: null, dir_key: "user/preferences" });
    expect(dir).toMatchObject({ dir_key: "user/preferences", entry_count: 2, over_cap: false });
    expect(dir!.entries.map((e) => e.memory_id)).toEqual([b, a]);
    expect(dir!.entries[0]).toMatchObject({ name: "b", description: "b desc", type: "user", source: "user", hit_count: 10 });

    expect(await getDir({ pool, username: "alice", project_dir: null, dir_key: "project/decisions" })).toBeNull();
    expect(await getDir({ pool, username: "alice", project_dir: null, dir_key: "user/nope" })).toBeNull();
  });

  it("writes honour an explicit dir_key", async () => {
    const id = await write("alice", "user", null, "n", { dir_key: "user/notes" });
    const r = await pool.query(`SELECT dir_key FROM memories WHERE memory_id = $1`, [id]);
    expect(r.rows[0].dir_key).toBe("user/notes");
  });

  it("memoryTree: instances per project, counts, over_cap, deleted rows and truncation", async () => {
    const pref1 = await write("alice", "user", null, "pref1");
    const pref2 = await write("alice", "user", null, "pref2");
    const pref3 = await write("alice", "user", null, "pref3");
    await write("alice", "project", "-w-b", "decB");
    await write("alice", "project", "-w-a", "decA");
    await write("bob", "user", null, "bobs");
    await pool.query(`UPDATE memories SET deleted_at = now() WHERE memory_id = $1`, [pref3]);
    await pool.query(`UPDATE memories SET hit_count = 5 WHERE memory_id = $1`, [pref2]);

    const tree = await memoryTree({ pool, username: "alice", project_dir: null, cap: 1, limit: 1 });
    expect(tree.cap).toBe(1);
    expect(tree.limit).toBe(1);
    expect(tree.dirs.map((d) => `${d.dir_key}@${d.project_dir}`)).toEqual([
      "user/preferences@null", "user/experience@null", "user/notes@null",
      "project/entities@-w-a", "project/trajectories@-w-a", "project/decisions@-w-a",
      "project/entities@-w-b", "project/trajectories@-w-b", "project/decisions@-w-b",
      "org/entities@null", "org/experience@null", "org/references@null",
    ]);
    const prefs = tree.dirs[0]!;
    expect(prefs).toMatchObject({
      scope: "user", l0: "Working habits, preferences and corrections",
      entry_count: 2, deleted_count: 1, over_cap: true, truncated: true,
    });
    expect(prefs.memories).toHaveLength(1);
    expect(prefs.memories[0]).toEqual({
      memory_id: pref2, name: "pref2", description: "pref2 desc",
      dir_key: "user/preferences", scope: "user", project_dir: null,
      type: "user", source: "user", hit_count: 5, last_hit_at: null,
      created_at: expect.any(String), updated_at: expect.any(String), deleted_at: null,
    });
    expect(tree.dirs[5]!.memories.map((m) => m.name)).toEqual(["decA"]);
    expect(tree.dirs[1]).toMatchObject({ entry_count: 0, memories: [], truncated: false, over_cap: false });

    const withDeleted = await memoryTree({ pool, username: "alice", project_dir: null, include_deleted: true });
    const prefsAll = withDeleted.dirs[0]!;
    expect(prefsAll.memories.map((m) => m.memory_id)).toEqual([pref2, pref1, pref3]);   // live first
    expect(prefsAll.memories[2]!.deleted_at).not.toBeNull();
    expect(prefsAll.truncated).toBe(false);

    const oneProject = await memoryTree({ pool, username: "alice", project_dir: "-w-empty" });
    expect(oneProject.dirs.filter((d) => d.scope === "project").map((d) => d.project_dir))
      .toEqual(["-w-empty", "-w-empty", "-w-empty"]);
  });

  it("getContext: directory lines then top entries, project first, within budget", async () => {
    const ids: string[] = [];
    for (const n of ["p1", "p2", "p3", "p4"]) ids.push(await write("alice", "project", "-workspace-x", n));
    await write("alice", "user", null, "pref");

    const ctx = await getContext({ pool, username: "alice", project_path: "/workspace/x", budget_tokens: 2000 });
    const lines = ctx.system_prompt.split("\n").filter((l) => l.startsWith("- ") || l.startsWith("  - "));
    expect(lines[0]).toBe("- project/decisions (4): Decisions and findings, with dates and evidence");
    expect(lines.slice(1, 4).every((l) => l.startsWith("  - p"))).toBe(true);   // top 3 of 4
    expect(lines[4]).toBe("- user/preferences (1): Working habits, preferences and corrections");
    expect(ctx.memory_ids).toHaveLength(4);

    const tight = await getContext({ pool, username: "alice", project_path: "/workspace/x", budget_tokens: 1 });
    expect(tight.memory_ids).toHaveLength(1);   // first entry always fits
  });
});

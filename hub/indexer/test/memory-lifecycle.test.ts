// Merge-on-write, per-directory caps and the retention pass.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { writeDistillation } from "../src/distiller-repo.js";
import { writeUserMemory } from "../src/memory-repo.js";
import type { WritePolicy } from "../src/memory-merge.js";
import { enforceDirCap, runRetentionOnce } from "../src/memory-retention.js";

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
  await pool.query("TRUNCATE memories CASCADE");
});

// Embeds a body to a unit vector chosen by its first word: same first word →
// identical vectors (cosine 1), "near" → cosine 0.8 with "fastp", any other
// word → its own axis, orthogonal to the rest.
const DIM = 384;
const axes = new Map<string, number>();
function vec(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  const word = text.split(" ")[0]!;
  if (word === "near") { v[0] = 0.8; v[1] = 0.6; return v; }
  if (word === "fastp") { v[0] = 1; return v; }
  if (!axes.has(word)) axes.set(word, 2 + axes.size);
  v[axes.get(word)!] = 1;
  return v;
}
let sessions = 0;
const policy = (over: Partial<WritePolicy> = {}): WritePolicy => ({
  embedderClient:  { embedTexts: async (texts) => texts.map(vec) },
  mergeSimilarity: 0.9,
  dirCap:          50,
  ...over,
});

function write(body: string, extra: Partial<Parameters<typeof writeUserMemory>[0]> = {}) {
  return writeUserMemory({
    pool, username: "alice", scope: "user", project_dir: null, type: "user",
    name: body.slice(0, 20), description: `${body} (desc)`, body, policy: policy(), ...extra,
  });
}

function distill(observations: Array<{ name: string; body: string; type?: "finding" | "user-preference" }>, p = policy()) {
  return writeDistillation(pool, {
    sessionMeta: { username: "alice", project_dir: null, source_session_id: null },
    result: {
      summary: { name: "session", description: "s", body: `summary${++sessions} of the session` },
      observations: observations.map((o) => ({
        type: o.type ?? "finding", name: o.name, description: `${o.name} desc`, body: o.body, facets: { tool: ["fastp"] },
      })),
    },
    promptVersion: 1,
    policy: p,
  });
}

async function row(id: string) {
  const r = await pool.query(
    `SELECT m.*, (SELECT COUNT(*)::int FROM memory_chunks c WHERE c.memory_id = m.memory_id) AS chunks,
            (SELECT COUNT(*)::int FROM memory_chunks c WHERE c.memory_id = m.memory_id AND c.embedding IS NOT NULL) AS embedded
       FROM memories m WHERE memory_id = $1`,
    [id],
  );
  return r.rows[0];
}

describe("merge-on-write", () => {
  it("folds a near-duplicate into the existing row with a 'merge' audit entry", async () => {
    const first = await write("fastp is the adapter trimmer we use");
    expect(first).toMatchObject({ dir_key: "user/preferences", merged: false });
    const second = await write("fastp trims adapters; prefer it over trimmomatic");
    expect(second).toEqual({ memory_id: first.memory_id, dir_key: "user/preferences", merged: true });

    const live = await pool.query(`SELECT COUNT(*)::int AS n FROM memories WHERE deleted_at IS NULL`);
    expect(live.rows[0].n).toBe(1);
    const m = await row(first.memory_id!);
    expect(m.body).toBe("fastp trims adapters; prefer it over trimmomatic");
    expect(m).toMatchObject({ chunks: 1, embedded: 1 });   // embedding stored at write, no queue round-trip

    const audit = await pool.query(
      `SELECT action, before, after FROM memory_audit_log WHERE memory_id = $1 ORDER BY audit_id`,
      [first.memory_id],
    );
    expect(audit.rows.map((a) => a.action)).toEqual(["write", "merge"]);
    expect(audit.rows[1].before.body).toBe("fastp is the adapter trimmer we use");
    expect(audit.rows[1].after.body).toBe("fastp trims adapters; prefer it over trimmomatic");
    expect(audit.rows[1].after.sim).toBeCloseTo(1);
  });

  it("does not merge below the similarity threshold, across directories, or across owners", async () => {
    const a = await write("fastp one");
    const below = await write("near fastp but not quite");                      // cosine 0.8
    const otherDir = await write("fastp two", { dir_key: "user/notes" });
    const otherOwner = await write("fastp three", { username: "bob" });
    for (const r of [below, otherDir, otherOwner]) {
      expect(r.merged).toBe(false);
      expect(r.memory_id).not.toBe(a.memory_id);
    }
  });

  it("an exact duplicate is still dropped without a merge", async () => {
    const a = await write("fastp exact");
    expect(await write("fastp exact")).toEqual({ memory_id: null, dir_key: "user/preferences", merged: false });
    const audit = await pool.query(`SELECT action FROM memory_audit_log WHERE memory_id = $1`, [a.memory_id]);
    expect(audit.rows.map((x) => x.action)).toEqual(["write"]);
  });

  it("writes without a merge check when the embedder is down", async () => {
    await write("fastp one");
    const down = policy({ embedderClient: { embedTexts: async () => { throw new Error("down"); } } });
    const r = await write("fastp again", { policy: down });
    expect(r.merged).toBe(false);
    expect(await row(r.memory_id!)).toMatchObject({ chunks: 1, embedded: 0 });   // left for the embedder queue
  });

  it("distillation merges into distilled rows but never overwrites a user-authored one", async () => {
    // User-authored 'feedback' lands in user/preferences, like distilled user-preferences.
    const user = await write("fastp is mandatory", { type: "feedback" });
    const res = await distill([{ name: "pref", body: "fastp please", type: "user-preference" }]);
    expect(res).toEqual({ written: 1, merged: 0 });   // the summary; the observation was dropped
    expect((await row(user.memory_id!)).body).toBe("fastp is mandatory");

    const obs = await distill([{ name: "trim", body: "near trimmed with fastp" }]);
    expect(obs).toEqual({ written: 2, merged: 0 });
    const again = await distill([{ name: "trim2", body: "near trimmed again with fastp" }]);
    expect(again).toEqual({ written: 1, merged: 1 });
    const exp = await pool.query(
      `SELECT name, source FROM memories WHERE dir_key = 'user/experience' AND deleted_at IS NULL`,
    );
    expect(exp.rows).toEqual([{ name: "trim2", source: "distilled" }]);
  });

  it("a user write merged into a distilled row makes it user-authored", async () => {
    await distill([{ name: "pref", body: "fastp by default", type: "user-preference" }]);
    const r = await write("fastp always", { type: "feedback" });
    expect(r.merged).toBe(true);
    expect(await row(r.memory_id!)).toMatchObject({ source: "user", type: "feedback", body: "fastp always" });
  });
});

describe("per-directory cap", () => {
  async function seedDistilled(n: number, project_dir: string | null = null): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = await pool.query<{ memory_id: string }>(
        `INSERT INTO memories (memory_id, username, project_dir, type, source, name, description, body,
                               content_hash, dir_key, created_at)
         VALUES (gen_random_uuid(), 'alice', $1, 'observation', 'distilled', $2, 'd', 'b', $3, $4,
                 now() - make_interval(days => $5::int))
         RETURNING memory_id`,
        [project_dir, `d${i}`, Buffer.from(`d${i}-${project_dir}`), project_dir ? "project/decisions" : "user/experience", 10 - i],
      );
      ids.push(r.rows[0]!.memory_id);
    }
    return ids;
  }

  it("retires the lowest-value distilled rows when a write exceeds the cap", async () => {
    const [old, , hit] = await seedDistilled(3);
    await pool.query(`UPDATE memories SET hit_count = 3, last_hit_at = now() WHERE memory_id = $1`, [hit]);
    const res = await distill([{ name: "new", body: "brand new finding" }], policy({ dirCap: 3 }));
    expect(res.written).toBe(2);

    const live = await pool.query(
      `SELECT name FROM memories WHERE dir_key = 'user/experience' AND deleted_at IS NULL ORDER BY name`,
    );
    expect(live.rows.map((r) => r.name)).toEqual(["d1", "d2", "new"]);   // d0: oldest, never hit
    const audit = await pool.query(`SELECT actor, action, after FROM memory_audit_log WHERE memory_id = $1`, [old]);
    expect(audit.rows).toEqual([{ actor: "__system__", action: "forget", after: { reason: "dir_cap" } }]);
  });

  it("never retires user-authored rows; the directory stays over cap", async () => {
    for (const b of ["alpha", "bravo", "charlie"]) await write(b, { policy: policy({ dirCap: 2 }) });
    const live = await pool.query(`SELECT COUNT(*)::int AS n FROM memories WHERE deleted_at IS NULL`);
    expect(live.rows[0].n).toBe(3);
  });

  it("the global pass trims every instance independently", async () => {
    await seedDistilled(4, null);
    await seedDistilled(2, "-w-p");
    expect(await enforceDirCap(pool, { cap: 2 })).toBe(2);
    const live = await pool.query(
      `SELECT project_dir, COUNT(*)::int AS n FROM memories WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 1`,
    );
    expect(live.rows).toEqual([{ project_dir: "-w-p", n: 2 }, { project_dir: null, n: 2 }]);
  });
});

describe("retention pass", () => {
  const POLICY = { staleDays: 90, purgeDays: 30, dirCap: 50 };

  async function seed(name: string, cols: { source?: string; hit_count?: number; age_days?: number; deleted_days?: number | null }) {
    const r = await pool.query<{ memory_id: string }>(
      `INSERT INTO memories (memory_id, username, project_dir, type, source, name, description, body,
                             content_hash, dir_key, hit_count, created_at, updated_at, deleted_at)
       VALUES (gen_random_uuid(), 'alice', NULL, 'observation', $1, $2, 'd', 'b', $3, 'user/experience', $4,
               now() - make_interval(days => $5::int), now() - make_interval(days => $5::int),
               CASE WHEN $6::int IS NULL THEN NULL ELSE now() - make_interval(days => $6::int) END)
       RETURNING memory_id`,
      [cols.source ?? "distilled", name, Buffer.from(name), cols.hit_count ?? 0, cols.age_days ?? 0, cols.deleted_days ?? null],
    );
    const id = r.rows[0]!.memory_id;
    await pool.query(`INSERT INTO memory_chunks (memory_id, chunk_idx, content) VALUES ($1, 0, 'b')`, [id]);
    await pool.query(`INSERT INTO memory_facets (memory_id, key, value) VALUES ($1, 'tool', 'x')`, [id]);
    await pool.query(`INSERT INTO memory_audit_log (memory_id, actor, action) VALUES ($1, 'alice', 'write')`, [id]);
    return id;
  }

  it("retires stale never-recalled distilled rows and purges old soft-deletes with their dependents", async () => {
    const stale   = await seed("stale",   { age_days: 100 });
    const recalled = await seed("recalled", { age_days: 100, hit_count: 1 });
    const fresh   = await seed("fresh",   { age_days: 10 });
    const userOld = await seed("userOld", { age_days: 400, source: "user" });
    const purge   = await seed("purge",   { age_days: 200, deleted_days: 31, source: "user" });
    const recent  = await seed("recent",  { age_days: 200, deleted_days: 5 });

    expect(await runRetentionOnce(pool, POLICY)).toEqual({ retired_stale: 1, retired_over_cap: 0, purged: 1 });

    const state = await pool.query<{ memory_id: string; deleted: boolean }>(
      `SELECT memory_id, deleted_at IS NOT NULL AS deleted FROM memories`,
    );
    const deleted = Object.fromEntries(state.rows.map((r) => [r.memory_id, r.deleted]));
    expect(deleted).toEqual({
      [stale]: true, [recalled]: false, [fresh]: false, [userOld]: false, [recent]: true,
    });
    for (const t of ["memory_chunks", "memory_facets", "memory_audit_log"]) {
      const r = await pool.query(`SELECT COUNT(*)::int AS n FROM ${t} WHERE memory_id = $1`, [purge]);
      expect(r.rows[0].n).toBe(0);
    }
    const audit = await pool.query(
      `SELECT actor, after FROM memory_audit_log WHERE memory_id = $1 AND action = 'forget'`, [stale],
    );
    expect(audit.rows).toEqual([{ actor: "__system__", after: { reason: "retention" } }]);
  });
});

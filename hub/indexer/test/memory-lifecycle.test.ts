// Merge-on-write.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { writeDistillation } from "../src/distiller-repo.js";
import { writeUserMemory } from "../src/memory-repo.js";
import type { WritePolicy } from "../src/memory-merge.js";

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
    expect(m.reinforce_count).toBe(1);
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

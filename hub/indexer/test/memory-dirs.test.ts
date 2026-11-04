import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { DistillationResult } from "../src/distiller-prompts.js";
import { runMigrations } from "../src/migrate.js";
import { insertMemoryRow, writeDistillation } from "../src/distiller-repo.js";
import { contentHash } from "../src/content-hash.js";
import { InvalidDirError } from "../src/memory-dirs.js";
import {
  searchMemories, writeUserMemory, updateMemory, getAuditTrail, getMemory,
  listMemories, listDirs, getDir, recordFeedback, memoryTree,
} from "../src/memory-repo.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
let pg: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await runMigrations({ pool, migrationsDir: MIGRATIONS_DIR, lockKey: 0x6d656d646972n });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

beforeEach(async () => {
  await pool.query("TRUNCATE memories CASCADE");
});

const DIM = 384;
const QUERY_VEC = Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0));
const FAR_VEC   = Array.from({ length: DIM }, (_, i) => (i === 0 ? -1 : 0));
const MID_VEC   = Array.from({ length: DIM }, (_, i) => (i === 1 ? 1 : 0));
const vecLiteral = (v: number[]) => "[" + v.join(",") + "]";
const embedder = { embedTexts: async () => [QUERY_VEC] };

let seq = 0;
interface Seed {
  username:     string;
  project_dir?: string | null;
  body:         string;
  vec?:         number[] | null;   // null = leave un-embedded
  type?:        string;
  name?:        string;
  dir?:         string;
  facets?:      Record<string, string[]>;
}

async function seed(rows: Seed[]): Promise<string[]> {
  const client = await pool.connect();
  const ids: string[] = [];
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      const n = seq++;
      const id = await insertMemoryRow(client, { domain: "lab",
        username:          r.username,
        project_dir:       r.project_dir ?? null,
        source:            "user",
        type:              r.type ?? "observation",
        source_session_id: null,
        name:              r.name ?? `m-${n}`,
        description:       `d-${n}`,
        body:              r.body,
        facets:            r.facets ?? {},
        content_hash:      contentHash({ body: `${n}`, promptVersion: 0 }),
        dir_key:           r.dir,
      });
      if (!id) throw new Error("seed dedup");
      if (r.vec !== null) {
        await client.query(
          `UPDATE memory_chunks SET embedding = $1::vector WHERE memory_id = $2`,
          [vecLiteral(r.vec ?? MID_VEC), id],
        );
      }
      ids.push(id);
    }
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  return ids;
}

const search = (extra: Partial<Parameters<typeof searchMemories>[0]> = {}) =>
  searchMemories({
    pool, embedderClient: embedder, username: "alice", project_dir: "-w-p",
    query: "scanpy normalisation", limit: 50, ...extra,
  });

describe("searchMemories candidate selection", () => {
  it("filters visibility before the vector cap: other users' near chunks can't crowd the caller out", async () => {
    await seed(Array.from({ length: 300 }, () => ({ username: "bob", body: "unrelated", vec: QUERY_VEC })));
    const [mine] = await seed([{ username: "alice", body: "unrelated too", vec: MID_VEC }]);

    const hits = await search();
    expect(hits.map((h) => h.memory_id)).toEqual([mine]);
  });

  it("returns a full-text-only match that is outside the 200 nearest vectors", async () => {
    await seed(Array.from({ length: 201 }, () => ({ username: "alice", body: "unrelated", vec: QUERY_VEC })));
    const [ftsHit] = await seed([{ username: "alice", body: "scanpy normalisation recipe", vec: FAR_VEC }]);

    const hits = await search({ limit: 300 });
    expect(hits.map((h) => h.memory_id)).toContain(ftsHit);
  });

  it("ranks an un-embedded memory by full text with a finite score, below an embedded match", async () => {
    const [embedded, bare] = await seed([
      { username: "alice", body: "scanpy normalisation", vec: QUERY_VEC },
      { username: "alice", body: "scanpy normalisation", vec: null },
    ]);
    const hits = await search();
    expect(hits.map((h) => h.memory_id)).toEqual([embedded, bare]);
    for (const h of hits) expect(Number.isFinite(h.score)).toBe(true);
  });

  it("works without an embedder (full-text only)", async () => {
    const [hit] = await seed([{ username: "alice", body: "scanpy normalisation" }]);
    const hits = await search({
      embedderClient: { embedTexts: async () => { throw new Error("down"); } },
    });
    expect(hits.map((h) => h.memory_id)).toEqual([hit]);
    expect(Number.isFinite(hits[0]!.score)).toBe(true);
  });

  it("returns one hit per memory when several chunks match", async () => {
    const [id] = await seed([{ username: "alice", body: "scanpy normalisation part one" }]);
    await pool.query(
      `INSERT INTO memory_chunks (memory_id, chunk_idx, content, embedding)
       VALUES ($1, 1, 'scanpy normalisation part two', $2::vector)`,
      [id, vecLiteral(QUERY_VEC)],
    );
    const hits = await search();
    expect(hits.map((h) => h.memory_id)).toEqual([id]);
    expect(hits[0]!.snippet).toBe("scanpy normalisation part two");
  });

  it("filters by directory and reports dir_key", async () => {
    const [notes, prefs] = await seed([
      { username: "alice", body: "scanpy normalisation", type: "reference" },
      { username: "alice", body: "scanpy normalisation", type: "feedback" },
    ]);
    const all = await search();
    expect(new Map(all.map((h) => [h.memory_id, h.dir_key]))).toEqual(
      new Map([[notes, "user/notes"], [prefs, "user/preferences"]]),
    );
    const only = await search({ dirs: ["user/preferences"] });
    expect(only.map((h) => h.memory_id)).toEqual([prefs]);
  });
});

describe("listDirs / getDir", () => {
  it("lists visible directories with counts; project dirs only with a project_dir", async () => {
    await seed([
      { username: "alice", body: "a", type: "feedback" },
      { username: "alice", body: "b", type: "feedback" },
      { username: "alice", project_dir: "-w-p", body: "c", type: "project" },
      { username: "alice", project_dir: "-w-other", body: "d", type: "project" },
      { username: "bob",   body: "e", type: "feedback" },
      { username: "__org__", body: "f", type: "reference" },
      { username: "alice", body: "g", type: "feedback", name: "raw distillation failed" },
    ]);

    const noProject = await listDirs({ pool, username: "alice", project_dir: null });
    expect(noProject.map((d) => d.dir_key)).toEqual([
      "org/entities", "org/experience", "org/references",
      "user/preferences", "user/experience", "user/notes",
    ]);

    const withProject = await listDirs({ pool, username: "alice", project_dir: "-w-p" });
    const counts = Object.fromEntries(withProject.map((d) => [d.dir_key, d.entry_count]));
    expect(counts).toEqual({
      "project/entities": 0, "project/trajectories": 0, "project/decisions": 1,
      "org/entities": 0, "org/experience": 0, "org/references": 1,
      "user/preferences": 2, "user/experience": 0, "user/notes": 0,
    });
    expect(withProject.find((d) => d.dir_key === "user/experience")!.updated_at).toBeNull();
    expect(withProject[0]!.l0.length).toBeGreaterThan(0);
  });

  it("getDir returns L0 + ranked entries, and null for unknown or invisible dirs", async () => {
    const [a] = await seed([{ username: "alice", body: "x", type: "feedback", name: "likes tabs" }]);
    const dir = await getDir({ pool, username: "alice", project_dir: null, dir_key: "user/preferences" });
    expect(dir!.entry_count).toBe(1);
    expect(dir!.entries).toEqual([
      expect.objectContaining({ memory_id: a, name: "likes tabs" }),
    ]);

    expect(await getDir({ pool, username: "alice", project_dir: null, dir_key: "nope/x" })).toBeNull();
    expect(await getDir({ pool, username: "alice", project_dir: null, dir_key: "project/decisions" })).toBeNull();
  });
});

describe("writes and directories", () => {
  it("defaults the directory from (scope, type), honours an explicit one, and rejects a cross-scope one", async () => {
    const dflt = await writeUserMemory({ domain: "lab",
      pool, username: "alice", scope: "project", project_dir: "-w-p",
      type: "reference", name: "n1", description: "d", body: "b1",
    });
    expect((await getMemory({ pool, memoryId: dflt.memory_id!, username: "alice" }))!.dir_key).toBe("project/entities");

    const explicit = await writeUserMemory({ domain: "lab",
      pool, username: "alice", scope: "project", project_dir: "-w-p",
      type: "project", name: "n2", description: "d", body: "b2", dir: "project/trajectories",
    });
    expect((await getMemory({ pool, memoryId: explicit.memory_id!, username: "alice" }))!.dir_key).toBe("project/trajectories");

    await expect(writeUserMemory({ domain: "lab",
      pool, username: "alice", scope: "user", project_dir: null,
      type: "user", name: "n3", description: "d", body: "b3", dir: "project/decisions",
    })).rejects.toBeInstanceOf(InvalidDirError);
  });

  it("files distilled rows by default mapping", async () => {
    await writeDistillation(pool, {
      sessionMeta: { username: "alice", project_dir: "-w-p", source_session_id: null },
      result: DistillationResult.parse({
        run: { subject: "s", statement: "summary" },
        claims: [{ claim_kind: "observation", subject: "o", statement: "obs" }],
      }),
      promptVersion: 2,
    });
    const { items } = await listMemories({ pool, username: "alice", project_dir: "-w-p" });
    expect(new Map(items.map((i) => [i.name, i.dir_key]))).toEqual(new Map([
      ["s", "project/trajectories"],
      ["o", "project/decisions"],
    ]));
  });

  it("updateMemory moves within a scope, audits it, and rejects a cross-scope move", async () => {
    const { memory_id } = await writeUserMemory({ domain: "lab",
      pool, username: "alice", scope: "user", project_dir: null,
      type: "user", name: "n", description: "d", body: "b",
    });
    const id = memory_id!;
    const base = { pool, actor: "alice", memoryId: id, name: "n", description: "d", body: "b" };

    expect(await updateMemory({ ...base, dir: "user/notes" })).toEqual({ ok: true });
    expect((await getMemory({ pool, memoryId: id, username: "alice" }))!.dir_key).toBe("user/notes");
    const trail = await getAuditTrail({ pool, actor: "alice", memoryId: id });
    if ("error" in trail) throw new Error(trail.error);
    expect(trail.rows[0]).toMatchObject({
      action: "update",
      before: expect.objectContaining({ dir_key: "user/preferences" }),
      after:  expect.objectContaining({ dir_key: "user/notes" }),
    });

    await expect(updateMemory({ ...base, dir: "org/experience" })).rejects.toBeInstanceOf(InvalidDirError);
    expect((await getMemory({ pool, memoryId: id, username: "alice" }))!.dir_key).toBe("user/notes");
  });

  it("listMemories filters by dir", async () => {
    const [, pref] = await seed([
      { username: "alice", body: "a", type: "reference" },
      { username: "alice", body: "b", type: "feedback" },
    ]);
    const { items } = await listMemories({ pool, username: "alice", project_dir: null, dir: "user/preferences" });
    expect(items.map((i) => i.memory_id)).toEqual([pref]);
  });
});

describe("recordFeedback", () => {
  it("counts outcomes only on memories the caller can see, and is not a hit", async () => {
    const [mine, org, bobs] = await seed([
      { username: "alice", body: "a" },
      { username: "__org__", body: "o" },
      { username: "bob", body: "b" },
    ]);
    const r = await recordFeedback({ pool, username: "alice", memory_ids: [mine!, org!, bobs!, mine!], outcome: "success" });
    expect(r).toEqual({ updated: 2 });
    await recordFeedback({ pool, username: "alice", memory_ids: [mine!], outcome: "failure" });

    const rows = await pool.query(
      `SELECT memory_id, hit_count, success_count, failure_count, last_hit_at IS NOT NULL AS used
         FROM memories ORDER BY username`,
    );
    const by = Object.fromEntries(rows.rows.map((x) => [x.memory_id, x]));
    expect(by[mine!]).toMatchObject({ hit_count: 0, success_count: 1, failure_count: 1, used: false });
    expect(by[org!]).toMatchObject({ hit_count: 0, success_count: 1, failure_count: 0 });
    expect(by[bobs!]).toMatchObject({ hit_count: 0, used: false });
  });

  it("ranks a memory that helped tasks above one that preceded failures", async () => {
    const [helped, hurt] = await seed([
      { username: "alice", body: "x", type: "feedback", name: "helped" },
      { username: "alice", body: "y", type: "feedback", name: "hurt" },
    ]);
    for (let i = 0; i < 3; i++) {
      await recordFeedback({ pool, username: "alice", memory_ids: [helped!], outcome: "success" });
      await recordFeedback({ pool, username: "alice", memory_ids: [hurt!], outcome: "failure" });
    }
    const dir = await getDir({ pool, username: "alice", project_dir: null, dir_key: "user/preferences" });
    expect(dir!.entries.map((e) => e.name)).toEqual(["helped", "hurt"]);
  });
});

describe("memoryTree", () => {
  it("groups the caller's memories into facet topics ranked by skill readiness", async () => {
    const qc = { pipeline: ["scrna-qc"], tool: ["scanpy"] };
    const [a, b, c] = await seed([
      { username: "alice", project_dir: "-w-p", body: "qc 1", facets: qc },
      { username: "alice", body: "qc 2", facets: qc },
      { username: "alice", body: "qc 3", facets: { ...qc, file: ["x.py"] } },
      { username: "alice", body: "plot", facets: { tool: ["matplotlib"] } },
      { username: "bob",   body: "bob qc", facets: qc },
    ]);
    await recordFeedback({ pool, username: "alice", memory_ids: [a!, b!, c!], outcome: "success" });

    const tree = await memoryTree({ pool, username: "alice" });

    expect(tree.memories).toHaveLength(4);                       // bob's excluded
    expect(tree.memories.find((m) => m.memory_id === c)!.topics)
      .toEqual(["pipeline:scrna-qc", "tool:scanpy"]);            // file facet is not a topic
    expect(tree.topics.map((t) => t.topic)).toEqual(["pipeline:scrna-qc", "tool:scanpy"]); // singletons dropped
    expect(tree.topics[0]).toMatchObject({
      memory_count: 3, success_count: 3, readiness: 1, ready: true,
      dirs: expect.arrayContaining(["project/decisions", "user/experience"]),
    });
    expect(tree.dirs.some((d) => d.dir_key === "project/decisions")).toBe(true);
  });

  it("scores partial readiness when a topic has knowledge but no proven uses", async () => {
    await seed([1, 2].map((i) => ({ username: "alice", body: `p${i}`, facets: { pipeline: ["bulk-rna"] } })));
    const [topic] = (await memoryTree({ pool, username: "alice" })).topics;
    expect(topic).toMatchObject({ value: "bulk-rna", ready: false });
    expect(topic!.readiness).toBeCloseTo(1 / 3);
  });
});

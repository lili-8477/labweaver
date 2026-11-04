// Memory access, held to one rule across every read path: a viewer sees
// their own and the org's memories within their clearance, and only the
// owner sees their deleted rows. One fixture, each path asked the same thing.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { insertMemoryRow } from "../src/distiller-repo.js";
import { contentHash } from "../src/content-hash.js";
import type { AccessClass } from "../src/access-classes.js";
import type { Domain } from "../src/memory-domain.js";
import {
  forgetMemory, getMemory, listDirs, listMemories, memoryTree, recordFeedback, restoreMemory,
  recordUse, searchMemories, timelineMemories, updateMemory, usedSince,
} from "../src/memory-repo.js";
import { lineageOf } from "../src/lineage-repo.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const DIM = 384;
const VEC = `[${Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;
const embedder = { embedTexts: async (t: string[]) => t.map(() => Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0))) };

let pg: StartedPostgreSqlContainer;
let pool: Pool;
const id: Record<string, string> = {};

async function seed(key: string, username: string, opts: { access?: AccessClass; deleted?: boolean; domain?: Domain } = {}) {
  const client = await pool.connect();
  try {
    const body = `visibility marker ${key}`;
    const memId = await insertMemoryRow(client, {
      domain: opts.domain ?? "lab", username, project_dir: null, source: "user", type: "observation", source_session_id: null,
      name: key, description: key, body, facets: {},
      content_hash: contentHash({ body, promptVersion: 0 }),
      science: opts.access ? { access_class: opts.access } : undefined,
    });
    await client.query(`UPDATE memory_chunks SET embedding = $1::vector WHERE memory_id = $2`, [VEC, memId]);
    if (opts.deleted) await client.query(`UPDATE memories SET deleted_at = now() WHERE memory_id = $1`, [memId]);
    id[key] = memId!;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await runMigrations({ pool, migrationsDir: MIGRATIONS_DIR, lockKey: 0x62696f666c77n });
  await seed("alice-own", "alice");
  await seed("alice-technical", "alice", { domain: "technical" });
  await seed("alice-deleted", "alice", { deleted: true });
  await seed("bob-own", "bob");
  await seed("bob-deleted", "bob", { deleted: true });
  await seed("org-internal", "__org__");
  await seed("org-irb", "__org__", { access: "irb" });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

/** The fixture keys a read path returned. */
const keysOf = (ids: string[]) => Object.keys(id).filter((k) => ids.includes(id[k]!)).sort();

/** Every read path, as alice with the given clearance (and domain, on the UI's listing paths): the keys each one shows. */
async function seenBy(clearance: AccessClass, domain?: Domain): Promise<Record<string, string[]>> {
  const viewer = { pool, username: "alice", clearance, domain };
  const byId = await Promise.all(Object.values(id).map((memoryId) => getMemory({ ...viewer, memoryId })));
  return {
    get:      keysOf(byId.flatMap((m) => (m ? [m.memory_id] : []))),
    search:   keysOf((await searchMemories({ ...viewer, embedderClient: embedder, project_dir: null, query: "visibility marker", limit: 50 })).map((h) => h.memory_id)),
    timeline: keysOf((await timelineMemories({ ...viewer, limit: 50 })).map((e) => e.memory_id)),
    list:     keysOf((await listMemories({ ...viewer, project_dir: null, include_deleted: true })).items.map((i) => i.memory_id)),
    tree:     keysOf((await memoryTree(viewer)).memories.map((m) => m.memory_id)),
  };
}

describe("memory visibility", () => {
  it("is the same on every read path: own and org, within clearance; deleted rows only for their owner", async () => {
    const live = ["alice-own", "alice-technical", "org-internal"];
    const withDeleted = ["alice-deleted", "alice-own", "alice-technical", "org-internal"];
    expect(await seenBy("internal")).toEqual({
      get: withDeleted, search: live, timeline: live, list: withDeleted, tree: live,
    });
  });

  it("keeps technical memories out of the lab view's listings", async () => {
    const lab = await seenBy("internal", "lab");
    for (const path of ["search", "list", "tree"] as const) expect(lab[path]).not.toContain("alice-technical");
    expect(lab.list).toContain("alice-own");
    // Opening one by id still works: the domain filters listings, not access.
    expect(lab.get).toContain("alice-technical");
    const dirOf = (await getMemory({ pool, username: "alice", memoryId: id["alice-technical"]! }))!.dir_key;
    const count = async (domain?: Domain) =>
      (await listDirs({ pool, username: "alice", project_dir: null, domain })).find((d) => d.dir_key === dirOf)!.entry_count;
    expect(await count("lab")).toBe((await count()) - 1);
  });

  it("opens restricted memories to cleared viewers, on every path", async () => {
    const seen = await seenBy("irb");
    for (const keys of Object.values(seen)) expect(keys).toContain("org-irb");
    for (const keys of Object.values(seen)) expect(keys).not.toContain("bob-own");
  });

  it("counts only visible entries in directories", async () => {
    const dir = (await getMemory({ pool, username: "alice", memoryId: id["org-internal"]! }))!.dir_key;
    const count = async (clearance: AccessClass) =>
      (await listDirs({ pool, username: "alice", project_dir: null, clearance })).find((d) => d.dir_key === dir)!.entry_count;
    expect(await count("internal")).toBe(1);
    expect(await count("irb")).toBe(2);
  });

  it("shows lineage only to visible, live memories", async () => {
    for (const other of ["bob-own", "org-internal", "org-irb", "alice-deleted"]) {
      await pool.query(`INSERT INTO memory_edges (src_id, dst_id, rel, status, actor) VALUES ($1, $2, 'SUPPORTS', 'accepted', 'alice')`, [id["alice-own"], id[other]]);
    }
    const linked = async (clearance: AccessClass) =>
      keysOf(((await lineageOf(pool, [id["alice-own"]!], { username: "alice", clearance })).get(id["alice-own"]!) ?? []).map((e) => e.other_id));
    expect(await linked("internal")).toEqual(["org-internal"]);
    expect(await linked("irb")).toEqual(["org-internal", "org-irb"]);
  });

  it("records feedback only on visible memories", async () => {
    const r = await recordFeedback({
      pool, username: "alice", outcome: "success",
      memory_ids: [id["alice-own"]!, id["org-internal"]!, id["org-irb"]!, id["bob-own"]!],
    });
    expect(r.updated).toBe(2);
  });
});

describe("memory changes", () => {
  it("are the owner's alone, whatever the change", async () => {
    const edit = { pool, actor: "alice", memoryId: id["bob-own"]!, name: "n", description: "d", body: "b" };
    expect(await updateMemory(edit)).toEqual({ ok: false, reason: "forbidden" });
    expect(await restoreMemory({ pool, actor: "alice", memoryId: id["bob-deleted"]! })).toEqual({ ok: false, reason: "forbidden" });
    expect(await forgetMemory({ pool, username: "alice", memoryId: id["bob-own"]! })).toEqual({ ok: false });
    expect(await updateMemory({ ...edit, memoryId: "00000000-0000-0000-0000-000000000000" })).toEqual({ ok: false, reason: "not_found" });
    // Nothing changed for bob.
    expect(await getMemory({ pool, username: "bob", memoryId: id["bob-own"]! })).toMatchObject({ name: "bob-own", deleted_at: null });
  });

  it("commit as a whole and are audited", async () => {
    expect(await forgetMemory({ pool, username: "alice", memoryId: id["alice-own"]! })).toEqual({ ok: true });
    expect(await forgetMemory({ pool, username: "alice", memoryId: id["alice-own"]! })).toEqual({ ok: false });
    expect(await restoreMemory({ pool, actor: "alice", memoryId: id["alice-own"]! })).toEqual({ ok: true });
    const audit = await pool.query(`SELECT action FROM memory_audit_log WHERE memory_id = $1 ORDER BY audit_id`, [id["alice-own"]]);
    expect(audit.rows.map((r) => r.action)).toEqual(["forget", "restore"]);
  });
});

describe("memory uses", () => {
  it("are the user's own, distinct, and from the given time on", async () => {
    const before = new Date(Date.now() - 1000);
    await recordUse({ pool, username: "alice", memoryId: id["org-internal"]! });
    await recordUse({ pool, username: "alice", memoryId: id["org-internal"]! });
    await recordUse({ pool, username: "bob", memoryId: id["bob-own"]! });
    expect(keysOf(await usedSince({ pool, username: "alice", since: before }))).toEqual(["org-internal"]);
    expect(await usedSince({ pool, username: "alice", since: new Date(Date.now() + 60_000) })).toEqual([]);
  });
});


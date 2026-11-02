import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runMigrations } from "../src/migrate.js";
import { contentHash } from "../src/content-hash.js";
import { defaultDir, scopeOf } from "../src/memory-dirs.js";
import { GRAPH_MEMORY_LIMIT, GRAPH_NODE_LIMIT, memoryGraph, normName, type MemoryGraph } from "../src/memory-graph.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
let pg: StartedPostgreSqlContainer;
let pool: Pool;
let ws: string;
const ids: Record<string, string> = {};

async function file(rel: string, text: string) {
  await mkdir(path.dirname(path.join(ws, rel)), { recursive: true });
  await writeFile(path.join(ws, rel), text);
}
const skill = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

async function memory(key: string, username: string, project_dir: string | null,
                      facets: Record<string, string[]>, deleted = false) {
  const r = await pool.query<{ memory_id: string }>(
    `INSERT INTO memories (memory_id, username, project_dir, type, source, name, description, body,
                           content_hash, dir_key, deleted_at)
     VALUES (gen_random_uuid(), $1, $2, 'feedback', 'user', $3, 'd', 'b', $4, $5, $6)
     RETURNING memory_id`,
    [username, project_dir, key, contentHash({ body: key, promptVersion: 1 }),
     defaultDir(scopeOf(username, project_dir), "feedback"), deleted ? new Date() : null],
  );
  ids[key] = r.rows[0]!.memory_id;
  for (const [k, vs] of Object.entries(facets)) {
    for (const v of vs) {
      await pool.query(`INSERT INTO memory_facets (memory_id, key, value) VALUES ($1, $2, $3)`, [ids[key], k, v]);
    }
  }
}

const graph = (username: string, include_deleted = false) =>
  memoryGraph({ pool, workspacesRoot: ws, username, include_deleted });
const nodeIds = (g: MemoryGraph, kind?: string) =>
  g.nodes.filter((n) => !kind || n.kind === kind).map((n) => n.id).sort();
const hasEdge = (g: MemoryGraph, source: string, target: string, kind: string) =>
  g.edges.some((e) => e.source === source && e.target === target && e.kind === kind);

beforeAll(async () => {
  pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await runMigrations({ pool, migrationsDir: MIGRATIONS_DIR, lockKey: 0x62696f666c77n });

  ws = await mkdtemp(path.join(tmpdir(), "graph-ws-"));
  await file("alice/.claude/skills/hci-scrnaseq/SKILL.md",
    skill("hci-scrnaseq", "Single-cell pipeline", "For FASTQ retrieval run `hci-data-prep`. Loads pbmc3k.h5ad. Extract the reads first."));
  await file("alice/.claude/skills/hci-data-prep/SKILL.md", skill("hci-data-prep", "Fetch FASTQ", "Downloads reads."));
  await mkdir(path.join(ws, "alice/.claude/skills/no-manifest"), { recursive: true });
  await file("alice/.claude/skills/polish/SKILL.md",
    skill("polish", "Final quality pass on interface spacing and alignment", "See `hci-data-prep`."));
  await file("shared/skills/chip-seq/SKILL.md",
    skill("chip-seq", "ChIP-seq", "Not to be confused with `hci-scrnaseq-v2`, hci_scrnaseq_old or plain hci-data-prep prose."));
  await file("shared/skills/hci-data-prep/SKILL.md", skill("hci-data-prep", "Org copy of the FASTQ fetch", "Run hci-data-prep first."));
  await file("bob/.claude/skills/bob-secret/SKILL.md", skill("bob-secret", "Bob's RNA-seq helper", "samtools"));
  await file("alice/local_projects/pbmc/.labweaver-project.json", JSON.stringify({ name: "PBMC study" }));
  await mkdir(path.join(ws, "alice/local_projects/other"), { recursive: true });
  await mkdir(path.join(ws, "alice/local_projects/_template"), { recursive: true });
  await mkdir(path.join(ws, "alice/local_projects/.trash"), { recursive: true });
  await mkdir(path.join(ws, "bob/local_projects/bobproj"), { recursive: true });

  await memory("m1", "alice", "-workspace-local-projects-pbmc", {
    tool: ["HCI_scRNAseq"], file: ["/workspace/local_projects/pbmc/pbmc3k.h5ad"], gene: ["CD3E"],
  });
  await memory("m2", "alice", null, { pipeline: ["hci data prep"], gene: ["cd3e"], tool: ["samtools"] });
  await memory("m3", "__org__", null, { tool: ["Samtools"], dataset: ["GSE116839"] });
  await memory("m4", "alice", null, { gene: ["MS4A1"] });
  await memory("m5", "bob", "-workspace-local-projects-bobproj", { gene: ["MS4A1"], tool: ["bob-secret"] });
  await memory("m6", "alice", null, { gene: ["MS4A1"] }, true);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
  if (ws) await rm(ws, { recursive: true, force: true });
}, 30_000);

describe("memoryGraph", () => {
  it("builds memory, skill, resource and topic nodes visible to the user", async () => {
    const g = await graph("alice");
    expect(nodeIds(g, "memory")).toEqual([ids.m1, ids.m2, ids.m3, ids.m4].sort());
    // The UI-design skill "polish" is not lab knowledge and is left out.
    expect(nodeIds(g, "skill")).toEqual([
      "skill:org:chip-seq", "skill:org:hci-data-prep", "skill:user:hci-data-prep", "skill:user:hci-scrnaseq",
    ]);
    expect(nodeIds(g, "resource")).toEqual([
      "resource:dataset:GSE116839",
      "resource:file:/workspace/local_projects/pbmc/pbmc3k.h5ad",
      "resource:project:other",
      "resource:project:pbmc",
    ]);
    // CD3E and samtools are shared by two memories; MS4A1 only by m4 (bob's and
    // the deleted one do not count).
    expect(nodeIds(g, "topic")).toEqual(["topic:gene:cd3e", "topic:tool:samtools"]);
    expect(g.dropped).toEqual({ memory: 0, skill: 0, resource: 0, topic: 0 });

    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(byId.get("resource:project:pbmc")).toMatchObject({ label: "PBMC study", path: "/workspace/local_projects/pbmc" });
    expect(byId.get("resource:file:/workspace/local_projects/pbmc/pbmc3k.h5ad")).toMatchObject({ label: "pbmc3k.h5ad", type: "file" });
    expect(byId.get("skill:user:hci-scrnaseq")).toMatchObject({
      label: "hci-scrnaseq", description: "Single-cell pipeline", scope: "user",
      path: "/workspace/.claude/skills/hci-scrnaseq/SKILL.md",
    });
    expect(byId.get("skill:org:chip-seq")).toMatchObject({ path: "/workspace/shared/skills/chip-seq/SKILL.md" });
    expect(byId.get(ids.m3!)).toMatchObject({ kind: "memory", scope: "org", dir_key: "org/experience" });
    // Every edge joins two nodes in the graph.
    for (const e of g.edges) expect(byId.has(e.source) && byId.has(e.target)).toBe(true);
  });

  it("links facets to skills (normalised, user skill first), resources and topics", async () => {
    const g = await graph("alice");
    expect(hasEdge(g, ids.m1!, "skill:user:hci-scrnaseq", "facet")).toBe(true);
    expect(hasEdge(g, ids.m2!, "skill:user:hci-data-prep", "facet")).toBe(true);
    expect(hasEdge(g, ids.m2!, "skill:org:hci-data-prep", "facet")).toBe(false);
    expect(hasEdge(g, ids.m1!, "resource:file:/workspace/local_projects/pbmc/pbmc3k.h5ad", "facet")).toBe(true);
    expect(hasEdge(g, ids.m3!, "resource:dataset:GSE116839", "facet")).toBe(true);
    for (const m of [ids.m1!, ids.m2!]) expect(hasEdge(g, m, "topic:gene:cd3e", "facet")).toBe(true);
    for (const m of [ids.m2!, ids.m3!]) expect(hasEdge(g, m, "topic:tool:samtools", "facet")).toBe(true);
  });

  it("links project memories and in-project files to the project folder", async () => {
    const g = await graph("alice");
    expect(hasEdge(g, ids.m1!, "resource:project:pbmc", "project")).toBe(true);
    expect(hasEdge(g, "resource:file:/workspace/local_projects/pbmc/pbmc3k.h5ad", "resource:project:pbmc", "project")).toBe(true);
    expect(g.edges.filter((e) => e.kind === "project")).toHaveLength(2);
  });

  it("links explicit skill references and whole-word resource names in SKILL.md", async () => {
    const g = await graph("alice");
    const mentions = g.edges.filter((e) => e.kind === "mention").map((e) => `${e.source} -> ${e.target}`).sort();
    expect(mentions).toEqual([
      "skill:user:hci-scrnaseq -> resource:file:/workspace/local_projects/pbmc/pbmc3k.h5ad",
      "skill:user:hci-scrnaseq -> skill:user:hci-data-prep",
    ]);
  });

  it("never shows another user's memories, skills or projects", async () => {
    const g = await graph("alice");
    const all = JSON.stringify(g);
    expect(all).not.toContain(ids.m5!);
    expect(all).not.toContain("bob");
    const b = await graph("bob");
    expect(nodeIds(b, "memory")).toEqual([ids.m3!, ids.m5!].sort());
    expect(nodeIds(b, "skill")).toEqual(["skill:org:chip-seq", "skill:org:hci-data-prep", "skill:user:bob-secret"]);
    expect(nodeIds(b, "resource")).toEqual(["resource:dataset:GSE116839", "resource:project:bobproj"]);
    expect(hasEdge(b, ids.m5!, "skill:user:bob-secret", "facet")).toBe(true);
    expect(nodeIds(b, "topic")).toEqual([]);
  });

  it("includes soft-deleted memories only on request, marked deleted", async () => {
    expect(nodeIds(await graph("alice"))).not.toContain(ids.m6);
    const g = await graph("alice", true);
    expect(g.nodes.find((n) => n.id === ids.m6)).toMatchObject({ kind: "memory", deleted: true });
    // Two live-or-deleted alice memories now share MS4A1.
    expect(hasEdge(g, ids.m6!, "topic:gene:ms4a1", "facet")).toBe(true);
  });

  it("caps memories and total nodes and reports what was dropped", async () => {
    const n = GRAPH_MEMORY_LIMIT + 20;
    await pool.query(
      `INSERT INTO memories (memory_id, username, project_dir, type, source, name, description, body, content_hash, dir_key)
       SELECT gen_random_uuid(), 'carol', NULL, 'user', 'user', 'c' || i, 'd', 'b', decode(md5(i::text), 'hex'), 'user/notes'
         FROM generate_series(1, $1) i`, [n]);
    await pool.query(
      `INSERT INTO memory_facets (memory_id, key, value)
       SELECT memory_id, 'file', '/data/' || name || '.csv' FROM memories WHERE username = 'carol'`);
    const g = await graph("carol");   // carol has no workspace folder: no user skills or projects
    expect(nodeIds(g, "memory")).toHaveLength(GRAPH_MEMORY_LIMIT);
    expect(g.nodes).toHaveLength(GRAPH_NODE_LIMIT);
    // Visible: carol's n plus the org memory, which ranks last by the prior.
    // Of the 300 kept memories' files only 200 fit; the two org skills have
    // no edges, so they go first.
    expect(g.dropped).toEqual({ memory: n + 1 - GRAPH_MEMORY_LIMIT, skill: 2, resource: 100, topic: 0 });
    expect(nodeIds(g, "memory")).not.toContain(ids.m3);
    for (const e of g.edges) {
      expect(g.nodes.some((x) => x.id === e.source) && g.nodes.some((x) => x.id === e.target)).toBe(true);
    }
  });
});

describe("normName", () => {
  it("ignores case and treats -, _ and spaces alike", () => {
    expect(normName(" HCI_scRNAseq ")).toBe("hci-scrnaseq");
    expect(normName("hci  data_prep")).toBe("hci-data-prep");
  });
});

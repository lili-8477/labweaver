// A read-only markdown copy of memory (GLOSSARY.md), for people to open and
// the agent to grep: one file per live memory, with a frontmatter header,
// under <root>/users/<user>/{user,project/<project>}/<folder>/<name>.md and
// <root>/org/<folder>/<name>.md. User containers mount their folder at
// /workspace/memory and the org folder at /workspace/memory/org, read-only:
// the database stays the one source of truth, so nothing syncs back.
//
// startMirror keeps it current: every few seconds it finds the owners whose
// memories changed and rewrites their folder, and a full pass runs at start
// and nightly. A file is written only when its content changed, so the copy
// can be kept in git.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Pool } from "pg";
import { ORG_USER } from "./memory-dirs.js";

const POLL_MS = 10_000;
const FULL_MS = 24 * 60 * 60 * 1000;
/** The org copy is readable by every member, so it holds only what everyone may read. */
const ORG_ACCESS = ["public", "internal"];

const README = (who: string) => `# Memory (read-only copy)

${who} memories as plain files, one per memory, regenerated from the LabWeaver
database a few seconds after every change. Edits here are not saved: change a
memory in the Memory panel, or ask the agent.

Folders: user/ (your own), project/<name>/ (each project), org/ (the lab's).
`;

interface Row {
  memory_id: string; name: string; description: string; body: string; type: string; source: string;
  domain: string; scope: "user" | "project" | "org"; project_dir: string | null; dir_key: string | null;
  created_at: Date; updated_at: Date;
}

export function ownerRoot(root: string, owner: string): string {
  return owner === ORG_USER ? path.join(root, "org") : path.join(root, "users", owner);
}

function slug(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "memory";
}

/** "-workspace-local_projects-ngs" → "ngs"; other encoded dirs lose their leading dash. */
function projectName(projectDir: string): string {
  return projectDir.replace(/^-workspace-local_projects-/, "").replace(/^-+/, "") || "project";
}

function relPath(r: Row): string {
  const folder = r.dir_key?.split("/")[1] ?? "notes";
  const file = `${slug(r.name)}-${r.memory_id.slice(0, 8)}.md`;
  if (r.scope === "org") return path.join(folder, file);
  if (r.scope === "project") return path.join("project", projectName(r.project_dir ?? ""), folder, file);
  return path.join("user", folder, file);
}

function render(r: Row, facets: Record<string, string[]>): string {
  const q = JSON.stringify;
  const head = [
    `id: ${q(r.memory_id)}`, `name: ${q(r.name)}`, `description: ${q(r.description)}`,
    `type: ${q(r.type)}`, `source: ${q(r.source)}`, `domain: ${q(r.domain)}`, `scope: ${q(r.scope)}`,
    ...(r.project_dir ? [`project: ${q(projectName(r.project_dir))}`] : []),
    `directory: ${q(r.dir_key)}`,
    `created: ${q(r.created_at.toISOString())}`, `updated: ${q(r.updated_at.toISOString())}`,
  ];
  const keys = Object.keys(facets).sort();
  if (keys.length) head.push("facets:", ...keys.map((k) => `  ${k}: ${q(facets[k])}`));
  return `---\n${head.join("\n")}\n---\n\n# ${r.name}\n\n${r.body.trimEnd()}\n`;
}

async function writeIfChanged(file: string, content: string): Promise<boolean> {
  if ((await fs.readFile(file, "utf8").catch(() => null)) === content) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, content);
  await fs.rename(`${file}.tmp`, file);
  return true;
}

/** Every .md file under `dir`, relative to it. */
async function mdFiles(dir: string, sub = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(path.join(dir, sub), { withFileTypes: true }).catch(() => [])) {
    const rel = path.join(sub, e.name);
    if (e.isDirectory()) out.push(...await mdFiles(dir, rel));
    else if (e.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

async function removeEmptyDirs(dir: string, keep: Set<string>): Promise<void> {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory()) continue;
    const sub = path.join(dir, e.name);
    await removeEmptyDirs(sub, keep);
    if (!keep.has(sub) && (await fs.readdir(sub)).length === 0) await fs.rmdir(sub);
  }
}

/** Rewrite one owner's folder from the database ("__org__" for the lab's). */
export async function syncOwner(pool: Pool, root: string, owner: string): Promise<{ written: number; removed: number }> {
  const org = owner === ORG_USER;
  const rows = (await pool.query<Row>(
    `SELECT memory_id, name, description, body, type, source, domain, scope, project_dir, dir_key, created_at, updated_at
       FROM memories
      WHERE username = $1 AND deleted_at IS NULL ${org ? "AND access_class = ANY($2::text[])" : ""}`,
    org ? [owner, ORG_ACCESS] : [owner],
  )).rows;
  const facets = new Map<string, Record<string, string[]>>();
  if (rows.length) {
    const f = await pool.query<{ memory_id: string; key: string; value: string }>(
      `SELECT memory_id, key, value FROM memory_facets WHERE memory_id = ANY($1::uuid[]) ORDER BY key, value`,
      [rows.map((r) => r.memory_id)],
    );
    for (const { memory_id, key, value } of f.rows) {
      const m = facets.get(memory_id) ?? {};
      (m[key] ??= []).push(value);
      facets.set(memory_id, m);
    }
  }

  const dir = ownerRoot(root, owner);
  const wanted = new Map(rows.map((r) => [relPath(r), render(r, facets.get(r.memory_id) ?? {})]));
  let written = 0;
  for (const [rel, content] of wanted) if (await writeIfChanged(path.join(dir, rel), content)) written++;
  let removed = 0;
  for (const rel of await mdFiles(dir)) {
    if (rel === "README.md" || wanted.has(rel)) continue;
    await fs.rm(path.join(dir, rel));
    removed++;
  }
  await writeIfChanged(path.join(dir, "README.md"), README(org ? "The lab's" : "Your"));
  // A member's folder keeps an org/ folder: the org copy is mounted there.
  const keep = new Set<string>();
  if (!org) {
    await fs.mkdir(path.join(dir, "org"), { recursive: true });
    keep.add(path.join(dir, "org"));
  }
  await removeEmptyDirs(dir, keep);
  return { written, removed };
}

/** A value per owner that changes whenever one of their memories is written, edited or forgotten. */
export async function ownerSignatures(pool: Pool): Promise<Map<string, string>> {
  const r = await pool.query<{ username: string; sig: string }>(
    `SELECT username, count(*) FILTER (WHERE deleted_at IS NULL) || ':' || max(updated_at)::text AS sig
       FROM memories GROUP BY username`,
  );
  return new Map(r.rows.map((row) => [row.username, row.sig]));
}

/** Keep the copy current; returns a stop function. */
export function startMirror(a: {
  pool: Pool; root: string; log: (msg: string, err?: unknown) => void; pollMs?: number; fullMs?: number;
}): () => void {
  let seen = new Map<string, string>();
  let busy = false;
  const pass = async (full: boolean) => {
    if (busy) return;
    busy = true;
    try {
      const now = await ownerSignatures(a.pool);
      const owners = [...now.keys()].filter((o) => full || now.get(o) !== seen.get(o));
      // An owner with no rows left still needs their folder emptied.
      for (const o of seen.keys()) if (!now.has(o)) owners.push(o);
      for (const owner of owners) {
        const r = await syncOwner(a.pool, a.root, owner);
        if (r.written || r.removed) a.log(`memory copy for ${owner}: ${r.written} written, ${r.removed} removed`);
      }
      seen = now;
    } catch (e) {
      a.log("memory copy pass failed", e);
    } finally {
      busy = false;
    }
  };
  void pass(true);
  const poll = setInterval(() => void pass(false), a.pollMs ?? POLL_MS);
  const nightly = setInterval(() => void pass(true), a.fullMs ?? FULL_MS);
  return () => { clearInterval(poll); clearInterval(nightly); };
}

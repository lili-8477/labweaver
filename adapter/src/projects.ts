// Projects are the folders under <workspace>/local_projects/. Chats bind to
// one through chats.project_dir; the sidebar groups chats by it. Folders
// starting with "." or "_" (attachments, starter templates) are not projects.

import { promises as fs } from "node:fs";
import * as path from "node:path";

export const PROJECTS_ROOT = "local_projects";
// Display name chosen in the UI. The folder itself is never renamed: chats
// store their cwd and project memories key on the encoded path.
const META_FILE = ".labweaver-project.json";

export interface ProjectInfo {
  /** Workspace-relative, e.g. "local_projects/pbmc-qc". */
  dir: string;
  name: string;
  modified_at: string;
}

export async function listProjects(workspaceRoot: string): Promise<ProjectInfo[]> {
  const root = path.join(workspaceRoot, PROJECTS_ROOT);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const out: ProjectInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || /^[._]/.test(e.name)) continue;
    const st = await fs.stat(path.join(root, e.name));
    const name = await readDisplayName(path.join(root, e.name));
    out.push({ dir: `${PROJECTS_ROOT}/${e.name}`, name: name ?? e.name, modified_at: st.mtime.toISOString() });
  }
  return out;
}

async function readDisplayName(projectPath: string): Promise<string | null> {
  try {
    const meta = JSON.parse(await fs.readFile(path.join(projectPath, META_FILE), "utf8"));
    return typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : null;
  } catch {
    return null;
  }
}

/** Absolute path of an existing project given its workspace-relative dir. */
async function resolveProject(workspaceRoot: string, dir: unknown): Promise<string> {
  const name = typeof dir === "string" ? /^local_projects\/([^/]+)$/.exec(dir)?.[1] : undefined;
  if (!name || /^[._]/.test(name)) throw new Error(`not a project: ${String(dir)}`);
  const abs = path.join(workspaceRoot, PROJECTS_ROOT, name);
  const st = await fs.stat(abs).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`project not found: ${dir}`);
  return abs;
}

export async function renameProject(workspaceRoot: string, dir: unknown, name: string): Promise<void> {
  const abs = await resolveProject(workspaceRoot, dir);
  const trimmed = name.trim();
  if (!trimmed) throw new Error("name required");
  await fs.writeFile(path.join(abs, META_FILE), JSON.stringify({ name: trimmed.slice(0, 80) }) + "\n", "utf8");
}

/** Move a project folder to local_projects/.trash/<name>-<timestamp>; listProjects skips it. */
export async function trashProject(workspaceRoot: string, dir: unknown): Promise<string> {
  const abs = await resolveProject(workspaceRoot, dir);
  const trash = path.join(workspaceRoot, PROJECTS_ROOT, ".trash");
  await fs.mkdir(trash, { recursive: true });
  const dest = path.join(trash, `${path.basename(abs)}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await fs.rename(abs, dest);
  return path.relative(workspaceRoot, dest);
}

// Same slug rule as the frontend's drop-to-create-project (project-from-drop.ts).
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Create a project folder named after `name`, suffixed -2, -3… if taken. */
export async function createProject(workspaceRoot: string, name: string): Promise<ProjectInfo> {
  const slug = slugify(name);
  if (!slug) throw new Error("project name must contain letters or digits");
  const root = path.join(workspaceRoot, PROJECTS_ROOT);
  await fs.mkdir(root, { recursive: true });
  for (let n = 1; ; n++) {
    const dirName = n === 1 ? slug : `${slug}-${n}`;
    try {
      await fs.mkdir(path.join(root, dirName));
      return { dir: `${PROJECTS_ROOT}/${dirName}`, name: dirName, modified_at: new Date().toISOString() };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}

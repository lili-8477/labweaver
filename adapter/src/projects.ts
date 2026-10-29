// Projects are the folders under <workspace>/local_projects/. Chats bind to
// one through chats.project_dir; the sidebar groups chats by it. Folders
// starting with "." or "_" (attachments, starter templates) are not projects.

import { promises as fs } from "node:fs";
import * as path from "node:path";

export const PROJECTS_ROOT = "local_projects";

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
    out.push({ dir: `${PROJECTS_ROOT}/${e.name}`, name: e.name, modified_at: st.mtime.toISOString() });
  }
  return out;
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

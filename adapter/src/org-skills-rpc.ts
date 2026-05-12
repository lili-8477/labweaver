// Lists org-wide skills under <workspaceRoot>/shared/skills/<name>/SKILL.md.
// Mirrors skills-rpc.ts but reads from the org tier. Empty array when the
// directory does not exist (e.g. fresh deployment with no promoted skills).

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillSummary } from "./skills-rpc.js";

export async function listOrgSkills(workspaceRoot: string): Promise<SkillSummary[]> {
  const orgSkillsDir = join(workspaceRoot, "shared", "skills");
  let entries;
  try {
    entries = await readdir(orgSkillsDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: SkillSummary[] = [];
  for (const it of entries) {
    if (!it.isDirectory()) continue;
    const skill = join(orgSkillsDir, it.name);
    let manifest: string;
    try {
      manifest = await readFile(join(skill, "SKILL.md"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    out.push({
      name:        it.name,
      description: extractDescription(manifest),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function extractDescription(manifest: string): string {
  const fmMatch = manifest.match(/^---\n(?<fm>[\s\S]*?)\n---\n/);
  const fm = fmMatch?.groups?.fm;
  if (!fm) return "";
  const dm = fm.match(/^description:\s*(?<val>.+?)\s*$/m);
  const val = dm?.groups?.val;
  if (!val) return "";
  return val.replace(/^['"]|['"]$/g, "");
}

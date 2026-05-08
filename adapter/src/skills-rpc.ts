// Lists the user's per-user skills under <home>/.claude/skills/<name>/SKILL.md.
// Pure read-only file walk. Empty array when the directory does not exist.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface SkillSummary {
  name:        string;
  description: string;       // empty string when frontmatter has no description
}

export async function listUserSkills(home: string): Promise<SkillSummary[]> {
  const skillsDir = join(home, ".claude", "skills");
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: SkillSummary[] = [];
  for (const it of entries) {
    if (!it.isDirectory()) continue;
    const skill = join(skillsDir, it.name);
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
  // YAML frontmatter between leading "---" lines. Look for `description:` only.
  // Anything fancier (multi-line, quoted, escapes, CRLF line endings) we treat as
  // opaque and surface as empty — the manager's review UI shows the full manifest.
  const fmMatch = manifest.match(/^---\n(?<fm>[\s\S]*?)\n---\n/);
  const fm = fmMatch?.groups?.fm;
  if (!fm) return "";
  const dm = fm.match(/^description:\s*(?<val>.+?)\s*$/m);
  const val = dm?.groups?.val;
  if (!val) return "";
  return val.replace(/^['"]|['"]$/g, "");
}

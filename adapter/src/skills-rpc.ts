// Lists the user's per-user skills under <home>/.claude/skills/<name>/SKILL.md.
// Pure read-only file walk. Empty array when the directory does not exist.

import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { extractDescription } from "./frontmatter.js";

export interface SkillSummary {
  name:        string;
  description: string;       // empty string when frontmatter has no description
}

export async function listUserSkills(home: string): Promise<SkillSummary[]> {
  const skillsDir   = join(home, ".claude", "skills");
  const userTierDir = join(home, ".claude", "skills-user");
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: SkillSummary[] = [];
  for (const it of entries) {
    // Skills land here as real dirs (legacy) or symlinks. The bootstrap
    // populates this directory with symlinks to BOTH personal skills
    // (~/.claude/skills-user/<name>) and org skills
    // (~/.claude/skills-shared/<name>). Only personal skills belong in the
    // user skills list — org symlinks would otherwise be mis-classified as
    // the user's own and pick up the "Submit update" UI affordance.
    if (!it.isDirectory() && !it.isSymbolicLink()) continue;
    if (it.isSymbolicLink()) {
      let target: string;
      try {
        target = await readlink(join(skillsDir, it.name));
      } catch { continue; }
      // readlink returns the link's stored value verbatim — absolute path
      // when the symlink was created with one, relative otherwise. The
      // bootstrap stores absolute paths, so a prefix check is sufficient.
      if (!target.startsWith(userTierDir)) continue;
    }
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

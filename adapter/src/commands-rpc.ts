// Lists the user's slash commands under <home>/.claude/commands/<name>.md.
// Pure read-only file walk. Returns [] when the directory does not exist.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractDescription } from "./frontmatter.js";

export interface CommandSummary {
  name:        string;
  description: string;       // empty string when frontmatter has no description
}

export async function listUserCommands(home: string): Promise<CommandSummary[]> {
  const dir = join(home, ".claude", "commands");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: CommandSummary[] = [];
  for (const it of entries) {
    if (!it.isFile()) continue;
    if (!it.name.endsWith(".md")) continue;
    const name = it.name.slice(0, -3);
    let manifest: string;
    try {
      manifest = await readFile(join(dir, it.name), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    out.push({ name, description: extractDescription(manifest) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Parses the `description:` field from a leading YAML frontmatter block.
// Shared by skills-rpc, org-skills-rpc, and commands-rpc — all of which
// surface a name + one-line description for SKILL.md / command files.
//
// Anything beyond the simplest single-line value (multi-line, escaped,
// CRLF) is treated as opaque and surfaced as an empty string.

export function extractDescription(manifest: string): string {
  const fmMatch = manifest.match(/^---\n(?<fm>[\s\S]*?)\n---\n/);
  const fm = fmMatch?.groups?.fm;
  if (!fm) return "";
  const dm = fm.match(/^description:\s*(?<val>.+?)\s*$/m);
  const val = dm?.groups?.val;
  if (!val) return "";
  return val.replace(/^['"]|['"]$/g, "");
}

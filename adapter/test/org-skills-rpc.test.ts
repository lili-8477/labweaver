import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { listOrgSkills } from "../src/org-skills-rpc.js";

let workspaceRoot: string;
beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "ws-"));
});

describe("listOrgSkills", () => {
  it("returns [] when shared/skills does not exist", async () => {
    expect(await listOrgSkills(workspaceRoot)).toEqual([]);
  });

  it("lists each subdir that contains SKILL.md", async () => {
    const make = async (n: string, body: string) => {
      const d = path.join(workspaceRoot, "shared", "skills", n);
      await mkdir(d, { recursive: true });
      await writeFile(path.join(d, "SKILL.md"), body);
    };
    await make("alpha", `---\ndescription: alpha org skill\n---\nbody`);
    await make("beta",  `---\ndescription: beta\n---\nbody`);
    const r = await listOrgSkills(workspaceRoot);
    expect(r).toEqual([
      { name: "alpha", description: "alpha org skill" },
      { name: "beta",  description: "beta" },
    ]);
  });

  it("returns empty description when frontmatter is missing", async () => {
    const d = path.join(workspaceRoot, "shared", "skills", "x");
    await mkdir(d, { recursive: true });
    await writeFile(path.join(d, "SKILL.md"), "no frontmatter\n");
    expect(await listOrgSkills(workspaceRoot)).toEqual([{ name: "x", description: "" }]);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { listUserSkills } from "../src/skills-rpc.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "home-"));
});

describe("listUserSkills", () => {
  it("returns [] when ~/.claude/skills does not exist", async () => {
    expect(await listUserSkills(home)).toEqual([]);
  });

  it("lists each subdir that contains SKILL.md", async () => {
    const make = async (n: string, body: string) => {
      const d = path.join(home, ".claude", "skills", n);
      await mkdir(d, { recursive: true });
      await writeFile(path.join(d, "SKILL.md"), body);
    };
    await make("alpha", `---\ndescription: alpha skill\n---\nbody`);
    await make("beta",  `---\ndescription: "beta with quotes"\n---\nbody`);
    await mkdir(path.join(home, ".claude", "skills", "no-manifest"), { recursive: true });

    const r = await listUserSkills(home);
    expect(r).toEqual([
      { name: "alpha", description: "alpha skill" },
      { name: "beta",  description: "beta with quotes" },
    ]);
  });

  it("returns empty description when frontmatter is missing or has no description", async () => {
    const d = path.join(home, ".claude", "skills", "x");
    await mkdir(d, { recursive: true });
    await writeFile(path.join(d, "SKILL.md"), "no frontmatter here\n");
    expect(await listUserSkills(home)).toEqual([{ name: "x", description: "" }]);
  });
});

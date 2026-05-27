import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listUserCommands } from "../src/commands-rpc.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bioflow-commands-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeCmd(name: string, body: string) {
  const dir = join(home, ".claude", "commands");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), body);
}

describe("listUserCommands", () => {
  it("returns [] when the commands directory does not exist", async () => {
    expect(await listUserCommands(home)).toEqual([]);
  });

  it("lists each .md file with its parsed description", async () => {
    writeCmd("init", "---\ndescription: Initialize a new project\n---\n\nbody");
    writeCmd("review", "---\ndescription: Review pending changes\n---\n\nbody");

    const out = await listUserCommands(home);

    expect(out).toEqual([
      { name: "init",   description: "Initialize a new project" },
      { name: "review", description: "Review pending changes"   },
    ]);
  });

  it("uses empty description when frontmatter is missing", async () => {
    writeCmd("plain", "Just a body, no frontmatter.\n");
    const out = await listUserCommands(home);
    expect(out).toEqual([{ name: "plain", description: "" }]);
  });

  it("ignores non-.md files and subdirectories", async () => {
    writeCmd("real", "---\ndescription: Real\n---\n");
    const dir = join(home, ".claude", "commands");
    writeFileSync(join(dir, "notes.txt"), "x");
    mkdirSync(join(dir, "subdir"));
    const out = await listUserCommands(home);
    expect(out.map(c => c.name)).toEqual(["real"]);
  });

  it("sorts results alphabetically by name", async () => {
    writeCmd("zebra", "---\ndescription: z\n---\n");
    writeCmd("alpha", "---\ndescription: a\n---\n");
    const out = await listUserCommands(home);
    expect(out.map(c => c.name)).toEqual(["alpha", "zebra"]);
  });
});

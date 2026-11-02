import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autoModeHooks, autoProjectFile, startAutoRun } from "../src/auto-mode.js";

type Stop = () => Promise<{ decision?: string; reason?: string }>;

describe("autoModeHooks", () => {
  let home: string;
  let project: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "auto-"));
    project = path.join(home, "proj");
    await fs.mkdir(project);
  });
  afterEach(() => fs.rm(home, { recursive: true, force: true }));

  const stopHook = () => autoModeHooks(home, "c1").Stop![0]!.hooks[0] as unknown as Stop;

  it("bootstraps a new project, then follows progress.md", async () => {
    await startAutoRun(home, "c1", null);
    const stop = stopHook();
    const first = await stop();
    expect(first.decision).toBe("block");
    expect(first.reason).toContain("Do `tick-bootstrap` now, yourself.");
    expect(first.reason).toContain(`Project file: ${autoProjectFile(home, "c1")}`);

    // bootstrap records the project; the plan is still empty
    await fs.writeFile(autoProjectFile(home, "c1"), `${project}\n`);
    await fs.writeFile(path.join(project, "progress.md"), "## Plan\n\n## Review feedback\n");
    expect((await stop()).reason).toContain("`tick-planner`");

    await fs.writeFile(path.join(project, "progress.md"), "## Plan\n- ☑ qc   filter cells\n");
    const review = await stop();
    expect(review.reason).toContain("Dispatch `tick-reviewer` now.");
    expect(review.reason).toContain("Work item: - ☑ qc   filter cells");
  });

  it("marks a finished project complete and lets the turn stop", async () => {
    await startAutoRun(home, "c1", project);
    const file = path.join(project, "progress.md");
    await fs.writeFile(file, "## Plan\n- ☑ (reviewed) qc   filter\n## Retrospective: done\n");
    expect(await stopHook()()).toEqual({});
    expect(await fs.readFile(file, "utf8")).toMatch(/## Status: complete/);
  });

  it("stops when the same step does not advance", async () => {
    await startAutoRun(home, "c1", project);
    await fs.writeFile(path.join(project, "progress.md"), "## Plan\n- ☐ qc   filter\n");
    const stop = stopHook();
    for (let i = 0; i < 3; i++) expect((await stop()).decision).toBe("block");
    expect(await stop()).toEqual({});
  });
});

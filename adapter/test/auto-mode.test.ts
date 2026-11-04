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

  describe("outcome loop", () => {
    const plan = "## Plan\n- ☑ qc   filter cells\n- ☐ norm   normalise\n## Review feedback\n";
    async function reviewRound(after: string) {
      const sent: Array<{ outcome: string; since: string }> = [];
      await startAutoRun(home, "c1", project);
      const stop = autoModeHooks(home, "c1", async (outcome, since) => { sent.push({ outcome, since }); })
        .Stop![0]!.hooks[0] as unknown as Stop;
      const file = path.join(project, "progress.md");
      await fs.writeFile(file, plan);
      expect((await stop()).reason).toContain("Dispatch `tick-reviewer` now.");
      await fs.writeFile(file, after);
      await stop();
      return { sent, stop, file };
    }

    it("credits an approval as a success, from the turn's start", async () => {
      const before = new Date().toISOString();
      const { sent } = await reviewRound("## Plan\n- ☑ (reviewed) qc   filter cells | n=2638\n- ☐ norm   normalise\n## Review feedback\n");
      expect(sent.map((s) => s.outcome)).toEqual(["success"]);
      // The window opened when the turn's hooks were made, before the review.
      expect(sent[0]!.since >= before).toBe(true);
    });

    it("credits a rejection as a failure, and starts the next window at the verdict", async () => {
      const { sent, stop, file } = await reviewRound(`${plan}- ☐ 2026-10-20 reviewer: qc rejected: n_cells: expected >2000, got 12\n`);
      expect(sent.map((s) => s.outcome)).toEqual(["failure"]);
      // The executor fixes it, the reviewer approves: a second window.
      await fs.writeFile(file, `${plan}- ☑ 2026-10-20 reviewer: qc rejected: fixed\n`);
      await stop();
      await fs.writeFile(file, "## Plan\n- ☑ (reviewed) qc   filter cells\n- ☐ norm   normalise\n## Review feedback\n");
      await stop();
      expect(sent.map((s) => s.outcome)).toEqual(["failure", "success"]);
      expect(sent[1]!.since >= sent[0]!.since).toBe(true);
    });

    it("reports nothing when a review did not finish", async () => {
      const { sent } = await reviewRound(plan);
      expect(sent).toEqual([]);
    });
  });
});

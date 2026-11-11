// progress.md read once (src/progress.ts): the UI's checklist must
// point at the step the tick router will actually run next.

import { describe, expect, it } from "vitest";
import { nextStep, parseProgress } from "../src/progress.js";

const md = (sections: Record<string, string[]>, extra = ""): string =>
  Object.entries(sections).map(([h, lines]) => `## ${h}\n${lines.join("\n")}\n`).join("\n") + extra;

describe("parseProgress", () => {
  it("reads the plan as the agents write it", () => {
    const p = parseProgress(md({
      Pipeline: ["scrnaseq-qc"],
      Plan: [
        "- ☑ (reviewed) simulate   simulate 500 rows | reviewer: n=500",
        "- ☐ summarize   per-column stats",
      ],
    }));
    expect(p.pipeline).toBe("scrnaseq-qc");
    expect(p.steps).toEqual([
      { name: "simulate", description: "simulate 500 rows", done: true, reviewed: true },
      { name: "summarize", description: "per-column stats", done: false, reviewed: false },
    ]);
  });

  it("points at the step the router runs: an unreviewed step before the next unchecked one", () => {
    const doc = md({ Plan: ["- ☑ qc   filter cells", "- ☐ norm   normalise"], "Review feedback": [] });
    expect(nextStep(doc)).toMatchObject({ agent: "tick-reviewer", work: "- ☑ qc   filter cells" });
    expect(parseProgress(doc)).toMatchObject({ nextStepIndex: 0, nextAgent: "tick-reviewer" });
  });

  it("counts open review notes with or without a dash, and runs them before any plan step", () => {
    const doc = md({
      Plan: ["- ☐ qc   filter cells"],
      "Review feedback": ["☐ 2026-10-13 planner: missing input", "- ☐ 2026-10-14 reviewer: qc rejected", "☑ old"],
    });
    expect(parseProgress(doc)).toMatchObject({ pendingFeedback: 2, nextStepIndex: null, nextAgent: "tick-executor" });
    expect(nextStep(doc)).toMatchObject({ work: "☐ 2026-10-13 planner: missing input" });
  });

  it("is complete when the router would stop", () => {
    const done = md({ Plan: ["- ☑ (reviewed) qc   filter"], "Review feedback": [] }, "## Retrospective: done\n");
    expect(parseProgress(done)).toMatchObject({ complete: true, nextStepIndex: null, nextAgent: null });
  });
});

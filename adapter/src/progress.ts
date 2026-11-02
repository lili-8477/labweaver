// progress.md, read in one place. Auto mode routes with nextStep
// (auto-mode.ts); get_harness_progress shows the UI parseProgress, whose next
// step is nextStep's answer, so the checklist highlights the step that will
// actually run. Ported from LabWeaver v2's dsh-plugins/progress.js.

export type TickAgent = "tick-bootstrap" | "tick-planner" | "tick-executor" | "tick-reviewer" | "tick-retrospective";

export type NextStep = { complete: true } | { complete?: false; agent: TickAgent; work: string };

export interface HarnessStep {
  name: string;
  description: string;
  done: boolean;
  reviewed: boolean;
}

export interface HarnessProgress {
  pipeline: string | null;
  steps: HarnessStep[];
  complete: boolean;
  pendingFeedback: number;
  /** Index into steps of the step that runs next; null when the next work is
   *  review feedback or the project is complete. */
  nextStepIndex: number | null;
  nextAgent: TickAgent | null;
}

/** Lines of a `## <title>` section, trimmed, or null when the section is absent. */
export function section(md: string, title: string): string[] | null {
  const m = md.match(new RegExp(`^## ${title}(?:[ \\t][^\\n]*)?\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"));
  return m ? m[1]!.split("\n").map((l) => l.trim()).filter(Boolean) : null;
}

// A plan or feedback line, with or without a leading "- ".
const OPEN = /^(?:-\s*)?☐/u;
const STEP = /^(?:-\s*)?([☑☐])\s*(?:\(reviewed\)\s*)?(\S+)(?:\s+(.*))?$/u;

/**
 * The tick priority: which agent runs next and on what, given progress.md
 * (null when the project does not exist yet).
 */
export function nextStep(md: string | null): NextStep {
  if (md == null) return { agent: "tick-bootstrap", work: "the user's task message that started this auto-mode run (quote it verbatim)" };
  if (/^## Status: complete/m.test(md)) return { complete: true };
  const plan = section(md, "Plan") ?? [];
  if (plan.length === 0) return { agent: "tick-planner", work: "instantiate the plan from the pipeline template" };
  const feedback = (section(md, "Review feedback") ?? []).find((l) => OPEN.test(l));
  if (feedback) return { agent: "tick-executor", work: feedback };
  const unreviewed = plan.find((l) => l.includes("☑") && !l.includes("(reviewed)"));
  if (unreviewed) return { agent: "tick-reviewer", work: unreviewed };
  const todo = plan.find((l) => l.includes("☐"));
  if (todo) return { agent: "tick-executor", work: todo };
  if (!/^## Retrospective: done/m.test(md)) return { agent: "tick-retrospective", work: "the finished project" };
  return { complete: true };
}

/** The UI's view of progress.md: the plan's steps and what runs next. */
export function parseProgress(md: string): HarnessProgress {
  const steps: HarnessStep[] = [];
  const lines: string[] = [];
  for (const line of section(md, "Plan") ?? []) {
    const m = STEP.exec(line);
    if (!m) continue;
    // The description stops at " | ", which starts the step's evidence.
    steps.push({
      name: m[2] ?? "",
      description: ((m[3] ?? "").split(/\s*\|\s*/, 1)[0] ?? "").trim(),
      done: m[1] === "☑",
      reviewed: /\(reviewed\)/.test(line),
    });
    lines.push(line);
  }
  const next = nextStep(md);
  const index = next.complete ? -1 : lines.indexOf(next.work);
  return {
    pipeline: section(md, "Pipeline")?.[0] ?? null,
    steps,
    complete: !!next.complete,
    pendingFeedback: (section(md, "Review feedback") ?? []).filter((l) => OPEN.test(l)).length,
    nextStepIndex: index === -1 ? null : index,
    nextAgent: next.complete ? null : next.agent,
  };
}

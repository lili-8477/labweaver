// Auto mode (the self-driving tick harness), ported from LabWeaver v2's
// dsh-plugins/tick.js. An auto-mode message starts as `/tick <message>`
// (commands/tick.md) and the chat's project file, ~/.claude/auto/<chat id>,
// holds the project directory (empty until tick-bootstrap writes it). Each
// time the turn is about to stop, a Stop hook reads the project's progress.md,
// decides the next step in code (nextStep: no model call is spent on routing)
// and keeps the turn going with one short instruction: do the step itself or,
// for the reviewer, dispatch it as a subagent so the review runs in a clean
// context. It lets the turn stop when the project is complete, after
// MAX_ROUNDS, or when the same step comes up more than MAX_REPEATS rounds in a
// row (the step is not advancing progress.md).
//
// The outcome loop: after each review round it reads the verdict from
// progress.md and reports it to the memory-api, which credits the memories the
// agent used since the previous verdict (or since the turn began). No model
// call: the verdict is the reviewer's line in progress.md.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { nextStep, verdict, type TickAgent } from "./progress.js";

const MAX_ROUNDS = 40;
const MAX_REPEATS = 3;
// Steps that run as a subagent; the main agent does every other step itself.
const SUBAGENTS = new Set<TickAgent>(["tick-reviewer"]);

export const autoProjectFile = (home: string, chatId: string) =>
  path.join(home, ".claude", "auto", chatId);

const read = (p: string) => fs.readFile(p, "utf8").catch(() => null);

/** The project directory an auto run recorded for this chat, or null. */
export async function autoProjectDir(home: string, chatId: string): Promise<string | null> {
  return (await read(autoProjectFile(home, chatId)))?.trim() || null;
}

/** Start an auto run: the project file holds the chat's project (absolute),
 *  or nothing until tick-bootstrap creates one. */
export async function startAutoRun(home: string, chatId: string, projectDir: string | null): Promise<void> {
  const file = autoProjectFile(home, chatId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, projectDir ? `${projectDir}\n` : "");
}

function instruction(home: string, round: number, file: string, dir: string | null, agent: TickAgent, work: string): string {
  const sub = SUBAGENTS.has(agent);
  return [
    `[auto mode · round ${round}] ${sub ? "Dispatch" : "Do"} \`${agent}\` now${sub ? "" : ", yourself"}.`,
    `Agent file: ${path.join(home, ".claude", "agents", `${agent}.md`)}`,
    `Project directory: ${dir ?? "none yet"}`,
    `Project file: ${file}`,
    `Work item: ${work}`,
    `Follow the ${sub ? "Dispatch" : "Do"} procedure in ${path.join(home, ".claude", "commands", "tick.md")}.`,
  ].join("\n");
}

export type ReportOutcome = (outcome: "success" | "failure", since: string) => Promise<void>;

/** Stop hook that drives one auto-mode turn for `chatId`. */
export function autoModeHooks(home: string, chatId: string, reportOutcome?: ReportOutcome): NonNullable<Options["hooks"]> {
  const file = autoProjectFile(home, chatId);
  let rounds = 0;
  let last = "";
  let repeats = 0;
  // The current outcome window, and the plan line the last round sent to the reviewer.
  let since = new Date().toISOString();
  let reviewing: string | null = null;
  return {
    Stop: [{
      hooks: [async () => {
        const dir = (await read(file))?.trim() || null;
        const progress = dir ? path.join(dir, "progress.md") : null;
        const md = progress ? await read(progress) : null;
        const outcome = reviewing ? verdict(md, reviewing) : null;
        if (outcome && reportOutcome) {
          // Best effort: memory never blocks a run.
          reportOutcome(outcome, since).catch((e) => console.warn(`[auto] outcome report failed: ${(e as Error).message}`));
          since = new Date().toISOString();
        }
        reviewing = null;
        const step = nextStep(md);
        const key = step.complete ? "" : `${step.agent}\n${step.work}`;
        repeats = key === last ? repeats + 1 : 1;
        last = key;
        if (step.complete) {
          if (progress && md != null && !/^## Status: complete/m.test(md)) {
            await fs.appendFile(progress, "\n## Status: complete\n");
          }
          return {};
        }
        if (repeats > MAX_REPEATS || rounds >= MAX_ROUNDS) {
          console.warn(`[auto] chat=${chatId.slice(0, 8)} stopped after ${rounds} rounds (${repeats > MAX_REPEATS ? "no progress" : "round limit"})`);
          return {};
        }
        rounds++;
        if (step.agent === "tick-reviewer") reviewing = step.work;
        return { decision: "block", reason: instruction(home, rounds, file, dir, step.agent, step.work) };
      }],
    }],
  };
}

// "What next" suggestions, ported from LabWeaver v2's next-step plugin. At the
// end of a task the model calls suggest_next_steps with a few short
// follow-ups; the call reaches the frontend as an ordinary tool call, where
// useChatHints turns its `options` into chips above the chat box. A top-level
// turn that used tools without suggesting gets one nudge before it stops.
// Auto mode (the tick harness) owns turn endings, so the nudge stands down there.

import { promises as fs } from "node:fs";
import { createSdkMcpServer, tool, type Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// The frontend matches this name (stores/chat.ts NEXT_STEP_TOOL).
export const NEXT_STEP_TOOL = "suggest_next_steps";
const MAX_OPTIONS = 4;

export const NEXT_STEP_GUIDANCE =
  `When you finish a task for the user, call ${NEXT_STEP_TOOL} once with 2-${MAX_OPTIONS} short, concrete ` +
  "follow-ups the user is likely to want next: imperative, under 10 words each, specific to this work. " +
  "Skip it for small talk, or when you are asking the user a question. Do not repeat the suggestions in your reply.";

const NUDGE = `Before you stop: call ${NEXT_STEP_TOOL} with the user's likely next steps. Do not restate your answer.`;

export function nextStepServer() {
  return createSdkMcpServer({
    name: "next_step",
    tools: [
      tool(
        NEXT_STEP_TOOL,
        `Offer the user ${MAX_OPTIONS} or fewer clickable next steps after finishing a task. They are shown as ` +
          "options under the chat box; the user picks one or ignores them.",
        {
          options: z
            .array(z.string())
            .min(1)
            .describe(`2-${MAX_OPTIONS} next steps, each an imperative line under 10 words.`),
        },
        async ({ options }) => {
          const shown = options.map((o) => o.trim()).filter(Boolean).slice(0, MAX_OPTIONS).length;
          return {
            content: [{
              type: "text" as const,
              text: `Shown ${shown} next-step option(s) to the user. End your turn now; write nothing more.`,
            }],
          };
        },
        { alwaysLoad: true },
      ),
    ],
  });
}

/** Hooks for one turn: note tool use, and nudge once if the turn ends
 *  having used tools but suggested nothing. `harnessFlag` is the file whose
 *  presence means auto mode is on. */
export function nextStepHooks(harnessFlag: string): NonNullable<Options["hooks"]> {
  let usedTools = false;
  let suggested = false;
  return {
    PostToolUse: [{
      hooks: [async (input) => {
        usedTools = true;
        if ("tool_name" in input && input.tool_name.endsWith(NEXT_STEP_TOOL)) suggested = true;
        return {};
      }],
    }],
    Stop: [{
      hooks: [async (input) => {
        if (!("stop_hook_active" in input) || input.stop_hook_active) return {};
        if (!usedTools || suggested) return {};
        if (await fs.stat(harnessFlag).then(() => true, () => false)) return {};
        return { decision: "block", reason: NUDGE };
      }],
    }],
  };
}

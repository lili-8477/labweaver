import { describe, expect, it } from "vitest";
import { nextStepHooks } from "../src/next-step.js";

type Hook = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

function turn() {
  const hooks = nextStepHooks();
  const postTool = hooks.PostToolUse![0]!.hooks[0] as unknown as Hook;
  const stop = hooks.Stop![0]!.hooks[0] as unknown as Hook;
  return {
    tool: (tool_name: string) => postTool({ hook_event_name: "PostToolUse", tool_name }),
    stop: (stop_hook_active = false) => stop({ hook_event_name: "Stop", stop_hook_active }),
  };
}

describe("nextStepHooks", () => {
  it("nudges a turn that used tools without suggesting, once", async () => {
    const t = turn();
    await t.tool("Bash");
    expect((await t.stop()).decision).toBe("block");
    expect(await t.stop(true)).toEqual({});
  });

  it("lets a turn stop when it suggested, or used no tools", async () => {
    const t = turn();
    await t.tool("Bash");
    await t.tool("mcp__next_step__suggest_next_steps");
    expect(await t.stop()).toEqual({});
    expect(await turn().stop()).toEqual({});
  });
});

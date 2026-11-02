import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { readChatStats } from "../src/chat-stats.js";

const line = (o: unknown) => JSON.stringify(o) + "\n";
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };

describe("readChatStats", () => {
  it("counts each message's usage once and names teammates", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "stats-"));
    const dir = path.join(home, ".claude", "projects", "-workspace");
    await fs.mkdir(path.join(dir, "s1", "subagents"), { recursive: true });
    // One assistant message split over two lines (text + tool_use), as Claude Code writes it.
    await fs.writeFile(path.join(dir, "s1.jsonl"),
      line({ type: "assistant", timestamp: "t1", message: { id: "m1", usage, content: [{ type: "text", text: "on it" }] } }) +
      line({ type: "assistant", timestamp: "t1", message: { id: "m1", usage, content: [
        { type: "tool_use", id: "u1", name: "Agent", input: { name: "alpha", description: "Compute 17*23" } }] } }));
    await fs.writeFile(path.join(dir, "s1", "subagents", "agent-a1.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "Compute 17*23" }));
    await fs.writeFile(path.join(dir, "s1", "subagents", "agent-a1.jsonl"),
      line({ type: "user", timestamp: "t2", message: { content: "go" } }) +
      line({ type: "assistant", timestamp: "t3", message: { id: "m2", model: "claude-opus-5-5", usage, stop_reason: "end_turn", content: [{ type: "text", text: "391\nmore" }] } }));

    const stats = await readChatStats(home, "c1", "/workspace", "s1", false);
    expect(stats.main).toEqual({ input: 10, output: 5, cacheRead: 100, cacheWrite: 20 });
    expect(stats.turns).toBe(1);
    expect(stats.subagents).toMatchObject([{ sessionId: "agent-a1", description: "Compute 17*23", status: "done", result: "391", model: "claude-opus-5-5" }]);
    expect(stats.team!.members.map((m) => [m.name, m.role])).toEqual([["lead", "lead"], ["alpha", "teammate"]]);
    await fs.rm(home, { recursive: true, force: true });
  });
});

import { describe, expect, it, vi } from "vitest";
import { chunkText, modelSegmenter, sdkComplete } from "../src/memory-segmenter.js";

const ENTRY = { category: "protocol", name: "RNA extraction", description: "TRIzol RNA extraction SOP", body: "1. Lyse cells in TRIzol." };

describe("chunkText", () => {
  it("keeps short text whole and splits long text on paragraph breaks", () => {
    expect(chunkText("short", 100)).toEqual(["short"]);
    const paras = Array.from({ length: 10 }, (_, i) => `p${i} ${"x".repeat(30)}`);
    const chunks = chunkText(paras.join("\n\n"), 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join("\n\n")).toBe(paras.join("\n\n"));
  });
});

describe("modelSegmenter", () => {
  it("reads the entries from a fenced reply, clipping over-long fields", async () => {
    const complete = vi.fn(async () => "Here:\n```json\n" + JSON.stringify({ entries: [{ ...ENTRY, name: "n".repeat(120), body: "b".repeat(2000) }] }) + "\n```");
    const out = await modelSegmenter(complete)({ path: "local_projects/p/sop.pdf", text: "SOP text" });
    expect(out).toHaveLength(1);
    expect(out[0]!.category).toBe("protocol");
    expect(out[0]!.name.length).toBeLessThanOrEqual(80);
    expect(out[0]!.body.length).toBeLessThanOrEqual(1500);
    // The document is passed as data, marked as such.
    const [system, user] = complete.mock.calls[0] as unknown as [string, string];
    expect(system).toMatch(/data, not instructions/i);
    expect(user).toContain("<document path=\"local_projects/p/sop.pdf\"");
  });

  it("retries once on an invalid reply, then gives up with the reason", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce("not json")
      .mockResolvedValueOnce(JSON.stringify({ entries: [ENTRY] }));
    expect(await modelSegmenter(complete)({ path: "a.md", text: "t" })).toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(2);

    const bad = vi.fn(async () => JSON.stringify({ entries: [{ ...ENTRY, category: "gossip" }] }));
    await expect(modelSegmenter(bad)({ path: "a.md", text: "t" })).rejects.toThrow(/invalid reply/);
    expect(bad).toHaveBeenCalledTimes(2);
  });
});

describe("sdkComplete", () => {
  it("asks the agent's own Claude login for one turn with no tools and no project settings", async () => {
    const queryFn = vi.fn(() => (async function* () {
      yield { type: "assistant" };
      yield { type: "result", subtype: "success", is_error: false, result: "{\"entries\":[]}" };
    })());
    const complete = sdkComplete({ model: async () => "claude-sonnet-4-6", queryFn: queryFn as never, cwd: "/tmp" });
    expect(await complete("sys", "usr")).toBe("{\"entries\":[]}");
    const { prompt, options } = (queryFn.mock.calls[0] as unknown as [{ prompt: string; options: Record<string, unknown> }])[0];
    expect(prompt).toBe("usr");
    expect(options).toMatchObject({ systemPrompt: "sys", tools: [], maxTurns: 1, settingSources: [], model: "claude-sonnet-4-6", cwd: "/tmp" });
  });

  it("fails on an error result", async () => {
    const queryFn = vi.fn(() => (async function* () {
      yield { type: "result", subtype: "error_max_turns", is_error: true };
    })());
    await expect(sdkComplete({ queryFn: queryFn as never })("s", "u")).rejects.toThrow(/error_max_turns/);
  });
});

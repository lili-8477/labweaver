import { describe, expect, it } from "vitest";
import { outputsText } from "../src/notebook-tools.js";
import { toOutputs } from "../src/notebook-rpc.js";

describe("outputsText", () => {
  it("keeps text, names rich outputs and strips ANSI from errors", () => {
    const text = outputsText([
      { output_type: "stream", name: "stdout", text: "2638 cells\n" },
      { output_type: "execute_result", data: { "text/plain": ["[1] 13714", " 2700"] } },
      { output_type: "display_data", data: { "text/plain": "plot", "image/png": "iVBOR..." } },
      { output_type: "error", ename: "Error", evalue: "object 'x' not found", traceback: ["\x1b[31mError\x1b[0m in eval"] },
    ]);
    expect(text).toBe(
      "2638 cells\n\n[1] 13714 2700\nplot\n[image/png output, shown in the notebook]\nError: object 'x' not found\nError in eval",
    );
  });

  it("says so when there is no output, and cuts long output in the middle", () => {
    expect(outputsText([])).toBe("(no output)");
    const long = outputsText([{ output_type: "stream", name: "stdout", text: "a".repeat(30_000) + "END" }]);
    expect(long.length).toBeLessThan(20_100);
    expect(long).toMatch(/characters cut/);
    expect(long.endsWith("END")).toBe(true);
  });
});

describe("toOutputs", () => {
  const ev = (msg_type: string, content: Record<string, unknown>) => ({ msg_type, content, cell_id: "c", parent_msg_id: null });

  it("merges consecutive stream chunks and drops status messages", () => {
    expect(toOutputs([
      ev("status", { execution_state: "busy" }),
      ev("stream", { name: "stdout", text: "a" }),
      ev("stream", { name: "stdout", text: "b" }),
      ev("stream", { name: "stderr", text: "w" }),
      ev("execute_result", { data: { "text/plain": "1" }, execution_count: 3 }),
    ])).toEqual([
      { output_type: "stream", name: "stdout", text: "ab" },
      { output_type: "stream", name: "stderr", text: "w" },
      { output_type: "execute_result", data: { "text/plain": "1" }, metadata: {}, execution_count: 3 },
    ]);
  });
});

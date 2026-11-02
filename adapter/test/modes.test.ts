import { describe, expect, it } from "vitest";
import { modePrompt } from "../src/modes.js";

describe("modePrompt", () => {
  it("routes typed messages to the mode's command and leaves slash commands alone", () => {
    expect(modePrompt("chat", "analyse GSE123")).toBe("analyse GSE123");
    expect(modePrompt("auto", "analyse GSE123")).toBe("/tick analyse GSE123");
    expect(modePrompt("team", "analyse GSE123")).toBe("/team analyse GSE123");
    expect(modePrompt("team", "/memory")).toBe("/memory");
  });
});

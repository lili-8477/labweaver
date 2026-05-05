import { describe, it, expect } from "vitest";
import {
  PROMPT_VERSION,
  buildDistillationPrompt,
  DistillationResult,
} from "../src/distiller-prompts.js";

describe("distiller-prompts", () => {
  it("PROMPT_VERSION is a positive integer", () => {
    expect(Number.isInteger(PROMPT_VERSION)).toBe(true);
    expect(PROMPT_VERSION).toBeGreaterThan(0);
  });

  it("buildDistillationPrompt embeds the transcript and version", () => {
    const out = buildDistillationPrompt({ transcript: "TRANSCRIPT_MARKER" });
    expect(out.system).toContain("distill");
    expect(out.system).toContain("strict JSON");
    expect(out.user).toContain("TRANSCRIPT_MARKER");
  });

  it("schema accepts a minimal valid result (empty observations)", () => {
    const valid = {
      summary: { name: "n", description: "d", body: "b" },
      observations: [],
    };
    expect(() => DistillationResult.parse(valid)).not.toThrow();
  });

  it("schema accepts a result with one observation of each known type", () => {
    const valid = {
      summary: { name: "n", description: "d", body: "b" },
      observations: [
        { type: "decision",        name: "a", description: "x", body: "y", facets: {} },
        { type: "finding",         name: "a", description: "x", body: "y", facets: { gene: ["TP53"] } },
        { type: "file-touched",    name: "a", description: "x", body: "y", facets: { file: ["foo.py"] } },
        { type: "command-result",  name: "a", description: "x", body: "y", facets: { tool: ["scanpy"] } },
        { type: "user-preference", name: "a", description: "x", body: "y", facets: {} },
      ],
    };
    expect(() => DistillationResult.parse(valid)).not.toThrow();
  });

  it("schema rejects unknown observation type", () => {
    expect(() =>
      DistillationResult.parse({
        summary: { name: "n", description: "d", body: "b" },
        observations: [
          { type: "rumor", name: "a", description: "x", body: "y", facets: {} },
        ],
      }),
    ).toThrow();
  });

  it("schema enforces ≤8 observations", () => {
    const obs = Array.from({ length: 9 }, () => ({
      type: "decision" as const,
      name: "a",
      description: "x",
      body: "y",
      facets: {},
    }));
    expect(() =>
      DistillationResult.parse({
        summary: { name: "n", description: "d", body: "b" },
        observations: obs,
      }),
    ).toThrow();
  });
});

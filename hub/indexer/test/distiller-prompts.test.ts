import { describe, it, expect } from "vitest";
import { PROMPT_VERSION, DistillationResult } from "../src/distiller-prompts.js";

const run = { subject: "PBMC3k QC", statement: "filtered to 2638 cells" };

describe("distillation payload v2", () => {
  it("PROMPT_VERSION is 2", () => {
    expect(PROMPT_VERSION).toBe(2);
  });

  it("a run alone is valid and gets defaults", () => {
    const r = DistillationResult.parse({ run });
    expect(r.claims).toEqual([]);
    expect(r.experiences).toEqual([]);
    expect(r.run).toMatchObject({ conditions: {}, inputs: [], parameters: {}, outputs: [], evidence: [] });
  });

  it("requires a run", () => {
    expect(() => DistillationResult.parse({ claims: [] })).toThrow();
  });

  it("accepts known condition keys and rejects unknown ones", () => {
    expect(() => DistillationResult.parse({ run: { ...run, conditions: { cell_line: ["A549"], reagent_lot: ["L-1"] } } })).not.toThrow();
    expect(() => DistillationResult.parse({ run: { ...run, conditions: { mood: ["good"] } } })).toThrow();
  });

  it("evidence must be a URI with a scheme", () => {
    expect(() => DistillationResult.parse({ run: { ...run, evidence: [{ uri: "file:///w/a.csv" }] } })).not.toThrow();
    expect(() => DistillationResult.parse({ run: { ...run, evidence: [{ uri: "/w/a.csv" }] } })).toThrow();
  });

  it("an experience must name a boundary condition or a failure mode", () => {
    const e = { task: "t", solution: "s", domain: "lab", applicability: ["10x v3 data"] };
    expect(() => DistillationResult.parse({ run, experiences: [e] })).toThrow(/boundary condition or failure mode/);
    expect(() => DistillationResult.parse({ run, experiences: [{ ...e, failure_modes: ["fails on v2"] }] })).not.toThrow();
    expect(() => DistillationResult.parse({ run, experiences: [{ ...e, applicability: [], failure_modes: ["x"] }] })).toThrow();
  });

  it("experience.source must point at the run or an existing claim", () => {
    const e = { task: "t", solution: "s", domain: "lab", applicability: ["a"], failure_modes: ["f"] };
    const claim = { claim_kind: "result", subject: "s", statement: "x" };
    expect(() => DistillationResult.parse({ run, claims: [claim], experiences: [{ ...e, source: 0 }] })).not.toThrow();
    expect(() => DistillationResult.parse({ run, claims: [claim], experiences: [{ ...e, source: 1 }] })).toThrow();
  });

  it("caps claims at 5 and experiences at 3", () => {
    const claim = { claim_kind: "result", subject: "s", statement: "x" };
    expect(() => DistillationResult.parse({ run, claims: Array(6).fill(claim) })).toThrow();
    const e = { task: "t", solution: "s", domain: "lab", applicability: ["a"], failure_modes: ["f"] };
    expect(() => DistillationResult.parse({ run, experiences: Array(4).fill(e) })).toThrow();
  });
});

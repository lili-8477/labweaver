import { describe, it, expect } from "vitest";
import {
  compareVersions, conditionKey, differingConditions, hasNewerVersion, normalizeFacets,
} from "../src/facets.js";
import { decideReconcile, renderClaimBody, type Candidate } from "../src/claims.js";
import { exactTokens } from "../src/memory-repo.js";
import { graphRerank } from "../src/context-bundle.js";
import { extractEvidence } from "../src/evidence-capture.js";
import { modalityOf, strictest } from "../src/lineage-repo.js";

describe("facets", () => {
  it("normalizes values: lower-case, trimmed, sorted, deduped; genes keep case", () => {
    expect(normalizeFacets({ cell_line: [" A549 ", "a549", "HeLa"], gene: ["TP53"], dose: [""] }))
      .toEqual({ cell_line: ["a549", "hela"], gene: ["TP53"] });
  });

  it("condition key ignores version keys and analysis keys, and the order of facets", () => {
    const a = conditionKey("TP53 knockdown", { cell_line: ["a549"], assay: ["wb"], protocol_version: ["v1"], pipeline: ["x"] });
    const b = conditionKey("tp53 knockdown ", { assay: ["wb"], cell_line: ["a549"], protocol_version: ["v2"] });
    const c = conditionKey("TP53 knockdown", { cell_line: ["hela"], assay: ["wb"] });
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });

  it("differing conditions ignore keys present on one side only", () => {
    expect(differingConditions({ cell_line: ["a549"], dose: ["1um"] }, { cell_line: ["hela"], assay: ["wb"] }))
      .toEqual(["cell_line"]);
  });

  it("compares versions numerically", () => {
    expect(compareVersions("v1.10", "v1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.4", "v1.4")).toBe(0);
    expect(compareVersions("2024-01", "2023-12")).toBeGreaterThan(0);
  });

  it("hasNewerVersion needs one newer shared version key and no older one", () => {
    expect(hasNewerVersion({ pipeline_version: ["v1.4"] }, { pipeline_version: ["v1.2"] })).toBe(true);
    expect(hasNewerVersion({ pipeline_version: ["v1.4"], code_version: ["1"] }, { pipeline_version: ["v1.2"], code_version: ["2"] })).toBe(false);
    expect(hasNewerVersion({ pipeline_version: ["v1.4"] }, {})).toBe(false);
  });
});

describe("decideReconcile", () => {
  const key = conditionKey("s", { cell_line: ["a549"] });
  const t0 = new Date("2026-01-01"), t1 = new Date("2026-02-01");
  const cand = (over: Partial<Candidate>): Candidate => ({
    memory_id: "old", username: "alice", condition_key: key, facets: { cell_line: ["a549"] },
    observed_at: t0, sim: null, ...over,
  });
  const n = (facets: Record<string, string[]>, at = t1, username = "alice") =>
    ({ username, condition_key: key, facets: { cell_line: ["a549"], ...facets }, observed_at: at });

  it("supersedes only same conditions + same author + newer version + later observation", () => {
    const old = cand({ facets: { cell_line: ["a549"], pipeline_version: ["v1.2"] } });
    expect(decideReconcile(n({ pipeline_version: ["v1.4"] }), [old], 0.9).supersedes).toEqual(["old"]);
    expect(decideReconcile(n({ pipeline_version: ["v1.4"] }, t1, "bob"), [old], 0.9).supersedes).toEqual([]);
    expect(decideReconcile(n({ pipeline_version: ["v1.4"] }, new Date("2025-01-01")), [old], 0.9).supersedes).toEqual([]);
    expect(decideReconcile(n({ pipeline_version: ["v1.2"] }), [old], 0.9).supersedes).toEqual([]);
  });

  it("never supersedes across conditions: it qualifies with the differing keys", () => {
    const other = cand({ condition_key: conditionKey("s", { cell_line: ["hela"] }), facets: { cell_line: ["hela"], pipeline_version: ["v1.0"] } });
    const d = decideReconcile(n({ pipeline_version: ["v9"] }), [other], 0.9);
    expect(d.supersedes).toEqual([]);
    expect(d.qualifies).toEqual([{ memory_id: "old", differs_on: ["cell_line"] }]);
  });

  it("a near-identical same-condition claim is a duplicate; nothing else happens", () => {
    const d = decideReconcile(n({}), [cand({ sim: 0.95 }), cand({ memory_id: "x", condition_key: null, sim: 0.85 })], 0.9);
    expect(d).toEqual({ duplicate_of: "old", supersedes: [], qualifies: [], related: [] });
  });

  it("same conditions with a different statement is related, for the agent to label", () => {
    expect(decideReconcile(n({}), [cand({ sim: 0.5 })], 0.9).related).toEqual([{ memory_id: "old", sim: 0.5 }]);
  });
});

describe("exactTokens", () => {
  it("keeps ID-like tokens: digits or all-caps symbols", () => {
    expect(exactTokens("TP53 knockdown in A549, lot L-2291 (pipeline v1.4) for GAPDH and the cells"))
      .toEqual(["tp53", "a549", "l-2291", "v1.4", "gapdh"]);
  });
});

describe("graphRerank", () => {
  it("boosts items supported by other pool items, degree-normalized and capped", () => {
    const items = [{ memory_id: "a", score: 0.5 }, { memory_id: "b", score: 0.45 }, { memory_id: "c", score: 0.4 }];
    const edges = new Map([
      ["c", [{ rel: "SUPPORTS" as const, dir: "in" as const, other_id: "a", status: "accepted" }]],
      ["b", [{ rel: "CONTRADICTS" as const, dir: "in" as const, other_id: "a", status: "accepted" }]],
    ]);
    const out = graphRerank(items, edges);
    expect(out.map((i) => i.memory_id)).toEqual(["a", "c", "b"]);
    expect(out[1]!.score).toBeCloseTo(0.4 + 0.15 * 0.9 * 0.5);
  });

  it("ignores proposed edges and neighbours outside the pool", () => {
    const items = [{ memory_id: "a", score: 0.5 }, { memory_id: "b", score: 0.4 }];
    const edges = new Map([["b", [
      { rel: "SUPPORTS" as const, dir: "in" as const, other_id: "a", status: "proposed" },
      { rel: "SUPPORTS" as const, dir: "in" as const, other_id: "zzz", status: "accepted" },
    ]]]);
    expect(graphRerank(items, edges)).toEqual(items);
  });
});

describe("evidence capture", () => {
  const line = (o: unknown) => JSON.stringify(o);
  const SID = "00000000-0000-4000-8000-000000000001";
  const UID = "00000000-0000-4000-8000-000000000002";

  it("captures written files and sbatch job IDs, skips the rest", () => {
    const buf = [
      line({ uuid: UID, sessionId: SID, timestamp: "2026-10-01T00:00:00Z", message: { content: [
        { type: "tool_use", name: "Write", input: { file_path: "/workspace/p/results/a.csv" } },
        { type: "tool_use", name: "Read", input: { file_path: "/workspace/p/in.csv" } },
        { type: "tool_use", name: "Edit", input: { file_path: "relative.txt" } },
      ] } }),
      line({ uuid: UID, sessionId: SID, timestamp: "2026-10-01T00:00:01Z", message: { content: [
        { type: "tool_result", content: [{ type: "text", text: "Submitted batch job 4242\nSubmitted batch job 4243" }] },
      ] } }),
      "not json",
    ].join("\n");
    expect(extractEvidence(buf).map((e) => e.uri)).toEqual([
      "file:///workspace/p/results/a.csv", "chpc://job/4242", "chpc://job/4243",
    ]);
    expect(extractEvidence(buf)[0]!.locator).toEqual({ session_id: SID, entry_uuid: UID, tool: "Write" });
  });

  it("derives modality from the URI", () => {
    expect(modalityOf("file:///a/b.ipynb")).toBe("notebook");
    expect(modalityOf("file:///a/b.h5ad")).toBe("table");
    expect(modalityOf("chpc://job/1")).toBe("instrument_run");
    expect(modalityOf("file:///a/b.py")).toBe("file");
  });

  it("strictest access class wins", () => {
    expect(strictest([])).toBe("internal");
    expect(strictest(["public", "irb", "restricted"])).toBe("irb");
  });
});

describe("renderClaimBody", () => {
  it("puts the statement first and the numbers after", () => {
    expect(renderClaimBody({
      statement: "9 clusters", conditions: { dataset: ["pbmc3k"] }, parameters: { res: 0.8 },
      qc: { status: "pass", metrics: { n_cells: 2638 } },
    })).toBe("9 clusters\nConditions: dataset=pbmc3k\nParameters: res=0.8\nQC: pass (n_cells=2638)");
  });
});

import { describe, expect, it, vi } from "vitest";
import type { MemoryBuilder } from "../src/memory-builder.js";
import { memoryBuildHandlers, memoryBuildToolsServer } from "../src/memory-build-tools.js";

const JOB = {
  job_id: "job-1", origin: "local_projects/ngs", status: "done", files_seen: 4, files_parsed: 3,
  files_skipped: 1, entries_created: 7, duplicates: 2, error: null,
  report: { skipped: [{ path: "local_projects/ngs/a.bam", reason: "not a document or table" }] },
};

describe("memory builder tools", () => {
  const builder = { start: vi.fn(async () => "job-1"), jobs: vi.fn(async () => [JOB]) } as unknown as MemoryBuilder;
  const tools = memoryBuildHandlers(builder);

  it("memory_build starts a job", async () => {
    const r = await tools.memory_build({ path: "/workspace/local_projects/ngs", scope: "project" });
    expect(builder.start).toHaveBeenCalledWith({ path: "/workspace/local_projects/ngs", scope: "project" });
    expect(r.content[0]!.text).toMatch(/job-1/);
    expect(r.isError).toBe(false);
  });

  it("memory_build reports a refusal as a tool error", async () => {
    vi.mocked(builder.start).mockRejectedValueOnce(new Error("shared/x is not inside a project"));
    const r = await tools.memory_build({ path: "shared/x", scope: "project" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/not inside a project/);
  });

  it("memory_build_status reports counts and skips", async () => {
    const text = (await tools.memory_build_status({})).content[0]!.text;
    expect(text).toMatch(/done/);
    expect(text).toMatch(/7 new/);
    expect(text).toMatch(/a\.bam: not a document or table/);
    expect((await tools.memory_build_status({ job_id: "other" })).content[0]!.text).toBe("No job other.");
  });

  it("is served as the memory_builder SDK server", () => {
    expect(memoryBuildToolsServer(builder)).toMatchObject({ type: "sdk", name: "memory_builder" });
  });
});

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBuilder, type BuilderDeps } from "../src/memory-builder.js";

const SHA = "ab".repeat(32);
const ROW = (name: string) => ({
  type: "entry", category: "data_record", name, description: `order ${name}`, body: `order_id: ${name}`,
  facets: { order_id: [name] }, origin: "local_projects/ngs/orders.csv", origin_sha256: SHA,
});

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "builder-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

/** A stand-in for memory-builder.py: prints `lines` for parse, `scan` for scan. */
async function fakeHelper(lines: object[], opts: { exit?: number; scan?: object } = {}): Promise<string[]> {
  const file = path.join(dir, "helper.mjs");
  await fs.writeFile(file, `
    const [cmd] = process.argv.slice(2);
    if (cmd === "scan") console.log(${JSON.stringify(JSON.stringify(opts.scan ?? {}))});
    else for (const l of ${JSON.stringify(lines)}) console.log(JSON.stringify(l));
    process.exit(${opts.exit ?? 0});
  `);
  return [process.execPath, file];
}

function deps(helper: string[], segment: BuilderDeps["segment"] = async () => [], seen: string[] = []) {
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  const memory = {
    request: vi.fn(async (op: string, params: Record<string, unknown>) => {
      calls.push({ op, params });
      if (op === "memory_build_job_create") return { job_id: "job-1" };
      if (op === "memory_import_seen") return { seen: (params.origin_sha256s as string[]).filter((h) => seen.includes(h)) };
      if (op === "memory_import") {
        const n = (params.entries as unknown[]).length;
        return { created: n - 1, duplicates: 1, memory_ids: [] };
      }
      return { ok: true };
    }),
  };
  const d: BuilderDeps = { helper, workspaceRoot: "/workspace", memory: memory as unknown as BuilderDeps["memory"], segment };
  return { d, calls };
}

describe("MemoryBuilder", () => {
  it("imports table rows and segmented documents, then reports the job done", async () => {
    const helper = await fakeHelper([
      ROW("20643R"), ROW("20701R"),
      { type: "document", path: "local_projects/ngs/sop.pdf", sha256: SHA, text: "Lyse cells.", truncated: false },
      { type: "skipped", path: "local_projects/ngs/raw/a.bam", reason: "not a document or table" },
    ]);
    const segment = vi.fn(async () => [{ category: "protocol" as const, name: "RNA SOP", description: "d", body: "Lyse cells." }]);
    const { d, calls } = deps(helper, segment);
    const builder = new MemoryBuilder(d);

    const job = await builder.start({ path: "local_projects/ngs", scope: "project" });
    expect(job).toBe("job-1");
    await builder.idle();

    expect(calls[0]).toEqual({ op: "memory_build_job_create", params: {
      project_dir: "-workspace-local_projects-ngs", origin_kind: "folder", origin: "local_projects/ngs",
    } });
    const imported = calls.filter((c) => c.op === "memory_import").flatMap((c) => c.params.entries as Array<Record<string, unknown>>);
    expect(imported.map((e) => e.name)).toEqual(["20643R", "20701R", "RNA SOP"]);
    expect(imported[2]).toMatchObject({ origin_kind: "folder", origin: "local_projects/ngs/sop.pdf", origin_sha256: SHA });
    expect(imported[0]).not.toHaveProperty("type");
    expect(calls.find((c) => c.op === "memory_import")!.params).toMatchObject({ project_dir: "-workspace-local_projects-ngs", builder_version: 1 });
    expect(segment).toHaveBeenCalledWith({ path: "local_projects/ngs/sop.pdf", text: "Lyse cells." });

    const last = calls.filter((c) => c.op === "memory_build_job_update").at(-1)!.params;
    expect(last).toMatchObject({
      job_id: "job-1", status: "done", files_seen: 3, files_parsed: 2, files_skipped: 1,
      report: { skipped: [{ path: "local_projects/ngs/raw/a.bam", reason: "not a document or table" }] },
    });
    expect((last.entries_created as number) + (last.duplicates as number)).toBe(3);
  });

  it("skips a document already imported unchanged, without calling the model", async () => {
    const helper = await fakeHelper([
      { type: "document", path: "local_projects/p/sop.md", sha256: SHA, text: "Lyse cells.", truncated: false },
    ]);
    const segment = vi.fn(async () => []);
    const { d, calls } = deps(helper, segment, [SHA]);
    const builder = new MemoryBuilder(d);
    await builder.start({ path: "local_projects/p", scope: "project" });
    await builder.idle();
    expect(segment).not.toHaveBeenCalled();
    expect(calls.find((c) => c.op === "memory_import_seen")!.params).toEqual({
      project_dir: "-workspace-local_projects-p", origin_sha256s: [SHA],
    });
    const last = calls.filter((c) => c.op === "memory_build_job_update").at(-1)!.params;
    expect(last).toMatchObject({ status: "done", files_parsed: 1, files_skipped: 0, report: { unchanged: ["local_projects/p/sop.md"] } });
  });

  it("keeps going when the model fails on one document, recording it as skipped", async () => {
    const helper = await fakeHelper([
      { type: "document", path: "local_projects/p/a.md", sha256: SHA, text: "A", truncated: false },
      ROW("20643R"),
    ]);
    const { d, calls } = deps(helper, async () => { throw new Error("invalid reply from the model: x"); });
    const builder = new MemoryBuilder(d);
    await builder.start({ path: "local_projects/p/a.md", scope: "user" });
    await builder.idle();
    expect(calls[0]!.params).toMatchObject({ project_dir: null, origin_kind: "file" });
    const last = calls.filter((c) => c.op === "memory_build_job_update").at(-1)!.params;
    expect(last).toMatchObject({ status: "done", files_parsed: 1, files_skipped: 1 });
    expect((last.report as { skipped: Array<{ reason: string }> }).skipped[0]!.reason).toMatch(/model/);
  });

  it("fails the job when the helper fails", async () => {
    const helper = await fakeHelper([{ error: "local_projects/x does not exist" }], { exit: 2 });
    const { d, calls } = deps(helper);
    const builder = new MemoryBuilder(d);
    await builder.start({ path: "local_projects/x", scope: "user" });
    await builder.idle();
    const last = calls.filter((c) => c.op === "memory_build_job_update").at(-1)!.params;
    expect(last).toMatchObject({ status: "failed", error: expect.stringMatching(/does not exist/) });
  });

  it("refuses a project build for a path outside any project", async () => {
    const { d } = deps(await fakeHelper([]));
    await expect(new MemoryBuilder(d).start({ path: "shared/docs", scope: "project" })).rejects.toThrow(/project/);
  });

  it("previews with the helper's scan", async () => {
    const scan = { files: [{ path: "local_projects/p/a.csv", size: 3, action: "parse", kind: "table" }], estimate: { table_rows: 2, documents: 0 } };
    const { d } = deps(await fakeHelper([], { scan }));
    expect(await new MemoryBuilder(d).preview("local_projects/p")).toEqual(scan);
  });
});

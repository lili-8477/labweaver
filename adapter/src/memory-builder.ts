// The memory builder's job runner (docs/superpowers/specs/2026-11-09-memory-builder-plugin-design.md).
// It runs a build in this container, where the files, the parsers and the
// member's model key are: memory-builder.py parses a file or folder into
// table entries and document texts, the segmenter turns each document into
// entries, and the entries go to the memory-api's memory_import in batches.
// The job's progress is reported to memory_build_jobs as it goes.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import type { BuildJob, ImportEntry, MemoryOp, MemoryResult } from "../../hub/indexer/src/memory-contract.js";
import { BUILDER_PROMPT_VERSION, type Segmenter } from "./memory-segmenter.js";

export interface ScanResult {
  files: Array<{ path: string; size: number; action: "parse" | "skip"; kind: "table" | "document" | null; reason?: string }>;
  estimate: { table_rows: number; documents: number };
}

const BATCH = 100;
const MAX_REPORTED_SKIPS = 200;

type HelperItem =
  | ({ type: "entry" } & Omit<ImportEntry, "origin_kind">)
  | { type: "document"; path: string; sha256: string; text: string; truncated: boolean }
  | { type: "skipped"; path: string; reason: string }
  | { error: string; type?: undefined };

export interface BuilderDeps {
  /** Command that runs memory-builder.py, e.g. ["python3", "/opt/adapter/memory-builder.py"]. */
  helper:        string[];
  workspaceRoot: string;
  memory:        { request<O extends MemoryOp>(op: O, params: Record<string, unknown>): Promise<MemoryResult<O>> };
  segment:       Segmenter;
}

export class MemoryBuilder {
  private readonly running = new Set<Promise<void>>();

  constructor(private readonly deps: BuilderDeps) {}

  /** What a build of `rel` would read: the files, and roughly how many entries. */
  async preview(rel: string): Promise<ScanResult> {
    const { lines, code } = await this.helper("scan", this.relPath(rel), () => undefined);
    const out = JSON.parse(lines.at(-1) ?? "{}") as ScanResult & { error?: string };
    if (code !== 0 || out.error) throw new Error(out.error ?? `memory-builder.py exited with ${code}`);
    return out;
  }

  /** Start building memory from `rel` (a file or folder); returns the job id at once. */
  async start(a: { path: string; scope: "project" | "user" }): Promise<string> {
    const rel = this.relPath(a.path);
    let project_dir: string | null = null;
    if (a.scope === "project") {
      const project = /^local_projects\/([^/._][^/]*)/.exec(rel)?.[0];
      if (!project) throw new Error(`${rel} is not inside a project; build it at user scope instead`);
      project_dir = path.join(this.deps.workspaceRoot, project).replace(/\//g, "-");
    }
    const st = await fs.stat(path.join(this.deps.workspaceRoot, rel)).catch(() => null);
    const origin_kind = st ? (st.isDirectory() ? "folder" : "file") : path.extname(rel) ? "file" : "folder";
    const { job_id } = await this.deps.memory.request("memory_build_job_create", { project_dir, origin_kind, origin: rel });
    const run = this.run(job_id, rel, project_dir, origin_kind).finally(() => this.running.delete(run));
    this.running.add(run);
    return job_id;
  }

  /** This member's recent build jobs, newest first. */
  jobs(limit = 20): Promise<BuildJob[]> {
    return this.deps.memory.request("memory_build_jobs", { limit });
  }

  /** Resolves once no build is running (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
  }

  private relPath(p: string): string {
    const rel = path.isAbsolute(p) ? path.relative(this.deps.workspaceRoot, p) : path.normalize(p);
    if (rel.startsWith("..")) throw new Error(`${p} is outside the workspace`);
    return rel.replace(/\/+$/, "");
  }

  private async run(job_id: string, rel: string, project_dir: string | null, origin_kind: "file" | "folder"): Promise<void> {
    const update = (fields: Record<string, unknown>) =>
      this.deps.memory.request("memory_build_job_update", { job_id, ...fields }).catch((e) =>
        console.warn(`[memory-builder] job ${job_id} update failed: ${(e as Error).message}`));
    const parsed = new Set<string>();
    const skipped: Array<{ path: string; reason: string }> = [];
    // Documents imported before and unchanged since: a model would split them
    // differently each time, so they are not segmented again.
    const unchanged: string[] = [];
    let entries_created = 0;
    let duplicates = 0;
    let pending: ImportEntry[] = [];
    const counts = () => ({
      files_seen: parsed.size + skipped.length, files_parsed: parsed.size, files_skipped: skipped.length,
      entries_created, duplicates,
    });
    const flush = async () => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      const r = await this.deps.memory.request("memory_import", { project_dir, builder_version: BUILDER_PROMPT_VERSION, entries: batch });
      entries_created += r.created;
      duplicates += r.duplicates;
      await update(counts());
    };
    const report = () => ({
      skipped: skipped.slice(0, MAX_REPORTED_SKIPS), skipped_total: skipped.length,
      unchanged: unchanged.slice(0, MAX_REPORTED_SKIPS),
    });

    try {
      await update({ status: "running" });
      let failure: string | null = null;
      // Items are handled one at a time, in order: a document waits for its model call.
      const { code } = await this.helper("parse", rel, async (item) => {
        if (item.type === undefined) { failure = item.error; return; }
        if (item.type === "skipped") { skipped.push({ path: item.path, reason: item.reason }); return; }
        if (item.type === "entry") {
          const { type: _, ...entry } = item;
          parsed.add(entry.origin);
          pending.push({ ...entry, origin_kind });
        } else {
          const { seen } = await this.deps.memory.request("memory_import_seen", { project_dir, origin_sha256s: [item.sha256] });
          if (seen.length) {
            parsed.add(item.path);
            unchanged.push(item.path);
            return;
          }
          try {
            const found = await this.deps.segment({ path: item.path, text: item.text });
            parsed.add(item.path);
            pending.push(...found.map((e) => ({ ...e, origin_kind, origin: item.path, origin_sha256: item.sha256 })));
          } catch (e) {
            skipped.push({ path: item.path, reason: `model step failed: ${(e as Error).message}`.slice(0, 500) });
          }
          await update(counts());
        }
        if (pending.length >= BATCH) await flush();
      });
      if (failure || code !== 0) throw new Error(failure ?? `memory-builder.py exited with ${code}`);
      await flush();
      await update({ status: "done", ...counts(), report: report() });
    } catch (e) {
      await update({ status: "failed", ...counts(), report: report(), error: (e as Error).message.slice(0, 2000) });
    }
  }

  /** Run memory-builder.py, handing each output line to `onItem` in order. */
  private helper(
    cmd: "scan" | "parse", rel: string, onItem: (item: HelperItem) => void | Promise<void>,
  ): Promise<{ lines: string[]; code: number }> {
    const [bin, ...args] = this.deps.helper;
    const proc = spawn(bin!, [...args, cmd, this.deps.workspaceRoot, rel], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr = (stderr + d).slice(-2000); });
    const exited = new Promise<number>((resolve, reject) => {
      proc.on("error", reject);
      proc.on("close", (code) => resolve(code ?? 1));
    });
    return (async () => {
      const lines: string[] = [];
      for await (const line of createInterface({ input: proc.stdout })) {
        if (!line.trim()) continue;
        lines.push(line);
        if (cmd === "parse") await onItem(JSON.parse(line) as HelperItem);
      }
      const code = await exited;
      if (code !== 0 && stderr) console.warn(`[memory-builder] ${cmd} ${rel}: ${stderr.trim()}`);
      return { lines, code };
    })();
  }
}

// The agent's memory builder tools ("add this folder to memory"): an
// in-process SDK server mounted on every chat turn, because the build runs in
// this adapter, with the member's files and the agent's login (memory-builder.ts).

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { MemoryBuilder } from "./memory-builder.js";

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

const BUILD_SCHEMA = {
  path: z.string().describe("File or folder, absolute (/workspace/local_projects/...) or workspace-relative"),
  scope: z.enum(["project", "user"]).describe("project: the project the path is in; user: the member's own memory"),
};
const LINK_SCHEMA = {
  url: z.string().describe("The page's link (http or https)"),
  request: z.string().describe("What to extract from the page, e.g. 'sequencing prices and turnaround times'"),
  scope: z.enum(["project", "user"]).describe("project: a project's memory (give project); user: the member's own memory"),
  project: z.string().optional().describe("For project scope: the project folder, e.g. local_projects/ngs"),
};
const STATUS_SCHEMA = { job_id: z.string().optional().describe("One job; omit for the recent ones") };

export function memoryBuildHandlers(builder: MemoryBuilder) {
  return {
    async memory_build({ path, scope }: { path: string; scope: "project" | "user" }) {
      try {
        const job = await builder.start({ path, scope });
        return text(`Started memory build job ${job} for ${path} (${scope} scope). Check progress with memory_build_status.`);
      } catch (e) {
        return text(`Could not start the build: ${(e as Error).message}`, true);
      }
    },

    async memory_build_from_link(args: { url: string; request: string; scope: "project" | "user"; project?: string }) {
      try {
        const job = await builder.startWebsite(args);
        return text(`Started extracting from ${args.url} (job ${job}). Check progress with memory_build_status.`);
      } catch (e) {
        return text(`Could not start: ${(e as Error).message}`, true);
      }
    },

    async memory_build_status({ job_id }: { job_id?: string }) {
      const jobs = (await builder.jobs(10)).filter((j) => !job_id || j.job_id === job_id);
      if (!jobs.length) return text(job_id ? `No job ${job_id}.` : "No memory build jobs yet.");
      return text(jobs.map((j) => {
        const skipped = ((j.report.skipped ?? []) as Array<{ path: string; reason: string }>)
          .slice(0, 10).map((s) => `  - ${s.path}: ${s.reason}`);
        const unchanged = ((j.report.unchanged ?? []) as string[]).length;
        return [
          `${j.job_id} ${j.origin}: ${j.status}. Files ${j.files_parsed}/${j.files_seen} read, ${j.files_skipped} skipped` +
            `${unchanged ? `, ${unchanged} unchanged since their last import` : ""}; ` +
            `${j.entries_created} new memories, ${j.duplicates} already known.${j.error ? ` Error: ${j.error}` : ""}`,
          ...skipped,
        ].join("\n");
      }).join("\n\n"));
    },
  };
}

export function memoryBuildToolsServer(builder: MemoryBuilder) {
  const h = memoryBuildHandlers(builder);
  return createSdkMcpServer({
    name: "memory_builder",
    tools: [
      tool(
        "memory_build",
        "Add a workspace file or folder to memory: protocols, inventories, sequencing orders and data records, " +
          "pipelines and scripts are parsed into searchable memories with provenance. Tables become one memory per " +
          "row; documents are split into entries by the model. Runs in the background; check it with " +
          "memory_build_status. Rebuilding the same source adds nothing new. Raw data (FASTQ, BAM, h5ad, images) is skipped.",
        BUILD_SCHEMA,
        (args) => h.memory_build(args),
      ),
      tool(
        "memory_build_from_link",
        "Extract what the member asked for from a web page (a core facility's services and prices, a vendor's " +
          "protocol, a wiki page) into memory, with the link and the request as provenance. Give the request in the " +
          "member's words. Only public http(s) pages; HTML, PDF, CSV and Excel links work. The page itself is not " +
          "kept. Runs in the background; check it with memory_build_status.",
        LINK_SCHEMA,
        (args) => h.memory_build_from_link(args),
      ),
      tool("memory_build_status", "Progress and results of recent memory build jobs, newest first.", STATUS_SCHEMA,
        (args) => h.memory_build_status(args)),
    ],
  });
}

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
      tool("memory_build_status", "Progress and results of recent memory build jobs, newest first.", STATUS_SCHEMA,
        (args) => h.memory_build_status(args)),
    ],
  });
}

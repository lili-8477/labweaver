// In-process MCP tools that run code in a notebook's live kernel: the same
// kernel the Notebook panel uses, so variables computed there are reused and
// the panel shows the run as it happens. Saves the agent re-executing a whole
// notebook in a fresh process to check a small edit.

import * as path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { NotebookManager } from "./notebook-rpc.js";

const MAX_CHARS = 20_000;
const ANSI = /\x1b\[[0-9;]*m/g;

/** nbformat outputs as text for the model. Rich outputs (plots, HTML)
 *  become a placeholder: the user sees them in the notebook. */
export function outputsText(outputs: Array<Record<string, unknown>>): string {
  const parts = outputs.map((o) => {
    if (o.output_type === "stream") return String(o.text ?? "");
    if (o.output_type === "error") {
      const tb = Array.isArray(o.traceback) ? o.traceback.join("\n") : "";
      return `${o.ename}: ${o.evalue}\n${tb}`.replace(ANSI, "");
    }
    const data = (o.data ?? {}) as Record<string, unknown>;
    const plain = data["text/plain"];
    const text = Array.isArray(plain) ? plain.join("") : plain ? String(plain) : "";
    const rich = Object.keys(data).filter((k) => k !== "text/plain");
    return [text, ...rich.map((k) => `[${k} output, shown in the notebook]`)].filter(Boolean).join("\n");
  });
  const all = parts.join("\n").trim();
  if (all.length <= MAX_CHARS) return all || "(no output)";
  const half = MAX_CHARS / 2;
  return `${all.slice(0, half)}\n…[${all.length - MAX_CHARS} characters cut]…\n${all.slice(-half)}`;
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

export function notebookToolsServer(notebooks: NotebookManager, workspaceRoot: string, cwd: string) {
  // The agent passes paths relative to its cwd or absolute; the manager keys
  // kernels by workspace path, the same key the panel uses.
  const rel = (p: string) => path.relative(workspaceRoot, path.resolve(cwd, p));

  return createSdkMcpServer({
    name: "notebook",
    tools: [
      tool(
        "run_cells",
        "Run cells of a .ipynb notebook, in order, in its live kernel (the one the user's Notebook panel uses). " +
          "Variables from earlier runs are still there, so after editing a cell run just that cell and the ones " +
          "that depend on it instead of re-running the whole notebook. Outputs are saved into the notebook and " +
          "stream live into the panel. Stops at the first error. Cell ids are the `id` fields in the .ipynb.",
        {
          notebook_path: z.string().describe("Path to the .ipynb, absolute or relative to the working directory"),
          cell_ids: z.array(z.string()).min(1).describe("Ids of the cells to run, in order"),
        },
        async ({ notebook_path, cell_ids }) => {
          const nb = rel(notebook_path);
          const report: string[] = [];
          for (const id of cell_ids) {
            const r = (await notebooks.executeCell(nb, id)) as {
              success: boolean;
              execution_count?: number | null;
              outputs?: Array<Record<string, unknown>>;
              error?: string | null;
            };
            report.push(`## cell ${id} [${r.execution_count ?? " "}]\n${outputsText(r.outputs ?? [])}`);
            if (!r.success) {
              report.push(`Stopped: cell ${id} failed${r.error ? ` (${r.error})` : ""}.`);
              return text(report.join("\n\n"), true);
            }
          }
          return text(report.join("\n\n"));
        },
        { alwaysLoad: true },
      ),
      tool(
        "run_code",
        "Run a scratch snippet in a notebook's live kernel without adding it to the notebook, e.g. to inspect " +
          "a variable (`dim(pbmc)`, `df.head()`) or try a change before writing it into a cell. Uses the " +
          "notebook's language (R or Python).",
        {
          notebook_path: z.string().describe("Path to the .ipynb, absolute or relative to the working directory"),
          code: z.string().describe("Code in the notebook's language"),
        },
        async ({ notebook_path, code }) => {
          const r = await notebooks.runCode(rel(notebook_path), code);
          const body = outputsText(r.outputs);
          return text(r.success ? body : `${body}\n\nFailed${r.error ? `: ${r.error}` : ""}.`, !r.success);
        },
        { alwaysLoad: true },
      ),
    ],
  });
}

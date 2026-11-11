// Deterministic evidence capture from JSONL transcripts (spec §5.1). No LLM:
// files the agent wrote and CHPC jobs it submitted become evidence_assets
// rows, so a later distill that cites them finds where they came from.
// Best-effort: anything it cannot parse is skipped.
import type { Pool } from "pg";
import { logger } from "./config.js";
import { upsertEvidence } from "./lineage-repo.js";

export interface CapturedEvidence {
  uri:         string;
  locator:     { session_id: string; entry_uuid: string; tool: string };
  observed_at: string;
}

const WRITE_TOOL = /write|edit/i;
const PATH_FIELDS = ["file_path", "notebook_path", "path"];
const SBATCH = /Submitted batch job (\d+)/g;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === "object" && typeof b.text === "string" ? b.text : "")).join("\n");
  }
  return "";
}

export function extractEvidence(buf: string): CapturedEvidence[] {
  const out: CapturedEvidence[] = [];
  for (const line of buf.split("\n")) {
    if (line.trim() === "") continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const content = obj?.message?.content;
    if (!Array.isArray(content) || typeof obj.uuid !== "string" || typeof obj.sessionId !== "string") continue;
    const base = { session_id: obj.sessionId as string, entry_uuid: obj.uuid as string };
    const observed_at = typeof obj.timestamp === "string" ? obj.timestamp : new Date().toISOString();
    for (const b of content) {
      if (b?.type === "tool_use" && typeof b.name === "string" && WRITE_TOOL.test(b.name)) {
        const p = PATH_FIELDS.map((f) => b.input?.[f]).find((v) => typeof v === "string" && v.startsWith("/"));
        if (p) out.push({ uri: `file://${p}`, locator: { ...base, tool: b.name }, observed_at });
      } else if (b?.type === "tool_result") {
        for (const m of textOf(b.content).matchAll(SBATCH)) {
          out.push({ uri: `chpc://job/${m[1]}`, locator: { ...base, tool: "sbatch" }, observed_at });
        }
      }
    }
  }
  return out;
}

// Never throws: a capture failure must not stop ingestion.
export async function captureEvidence(pool: Pool, buf: string, username: string): Promise<void> {
  try {
    for (const e of extractEvidence(buf)) {
      await upsertEvidence(pool, { ...e, actor: username });
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), username }, "evidence capture failed");
  }
}

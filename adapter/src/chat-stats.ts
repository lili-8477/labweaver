// Token totals, subagent runs and the agent team for one chat, read from
// Claude Code's transcripts (get_chat_stats RPC, the Agents panel). Same shape
// as LabWeaver v2's chat-stats.
//
// The chat's session transcript is <projects>/<cwd>/<session>.jsonl; each
// subagent or teammate run writes <session>/subagents/agent-<id>.jsonl with a
// .meta.json beside it ({agentType, description}). Claude Code writes one
// line per content block, each repeating its message's usage, so usage is
// counted once per message id.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { sessionPathCandidates } from "./history.js";
import { readTeamTasks, type TeamTask } from "./team-board.js";

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SubagentRun {
  sessionId: string;
  description: string | null;
  /** "stopped": unfinished and the chat's turn is no longer running. */
  status: "running" | "done" | "failed" | "stopped";
  model: string | null;
  startedAt: string;
  endedAt: string;
  tokens: TokenTotals;
  toolCalls: number;
  /** First line of the run's last reply. */
  result: string | null;
}

export interface TeamMember {
  id: string;
  name: string;
  role: "lead" | "teammate";
  status: "running" | "inactive" | "provisioning" | "failed";
  description?: string;
  model?: string;
}

export interface ChatStats {
  main: TokenTotals;
  /** Model calls in the chat's own session. */
  turns: number;
  lastTurn: TokenTotals | null;
  subagents: SubagentRun[];
  /** Null until the lead names a teammate or creates a task. */
  team: { members: TeamMember[]; tasks: TeamTask[]; updatedAt: number } | null;
}

// Transcript lines are loosely typed JSON.
type Entry = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const zero = (): TokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function parse(raw: string): Entry[] {
  const out: Entry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as Entry); } catch { /* a line being written */ }
  }
  return out;
}

/** Sum usage once per assistant message; returns the totals, call count and last call. */
function usage(entries: Entry[]): { total: TokenTotals; calls: number; last: TokenTotals | null } {
  const total = zero();
  const seen = new Set<string>();
  let last: TokenTotals | null = null;
  for (const e of entries) {
    const u = e.type === "assistant" ? e.message?.usage : undefined;
    const id = e.message?.id as string | undefined;
    if (!u || (id && seen.has(id))) continue;
    if (id) seen.add(id);
    last = {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheWrite: num(u.cache_creation_input_tokens),
    };
    total.input += last.input;
    total.output += last.output;
    total.cacheRead += last.cacheRead;
    total.cacheWrite += last.cacheWrite;
  }
  return { total, calls: seen.size, last };
}

const blocks = (e: Entry): Entry[] => (Array.isArray(e.message?.content) ? e.message.content : []);

function summarizeRun(id: string, entries: Entry[], description: string | null, running: boolean): SubagentRun {
  let toolCalls = 0;
  let model: string | null = null;
  let result: string | null = null;
  for (const e of entries) {
    if (e.type === "assistant") model ??= e.message?.model ?? null;
    for (const b of blocks(e)) {
      if (b.type === "tool_use") toolCalls++;
      if (b.type === "text" && e.type === "assistant" && String(b.text).trim()) result = String(b.text).trim().split("\n")[0]!;
    }
  }
  const lastEntry = entries.at(-1);
  const finished = lastEntry?.type === "assistant" && lastEntry.message?.stop_reason === "end_turn";
  return {
    sessionId: id,
    description,
    status: finished ? "done" : running ? "running" : "stopped",
    model,
    startedAt: entries[0]?.timestamp ?? "",
    endedAt: lastEntry?.timestamp ?? "",
    tokens: usage(entries).total,
    toolCalls,
    result,
  };
}

export async function readChatStats(
  home: string,
  chatId: string,
  cwd: string,
  sessionId: string | null,
  running: boolean,
): Promise<ChatStats> {
  const tasks = await readTeamTasks(home, chatId);
  const empty: ChatStats = { main: zero(), turns: 0, lastTurn: null, subagents: [], team: null };
  if (!sessionId) return tasks ? { ...empty, team: { members: [], ...tasks } } : empty;

  let mainPath: string | null = null;
  let entries: Entry[] = [];
  for (const p of sessionPathCandidates(home, cwd, sessionId)) {
    const raw = await fs.readFile(p, "utf8").catch(() => null);
    if (raw != null) { mainPath = p; entries = parse(raw); break; }
  }
  const { total: main, calls: turns, last: lastTurn } = usage(entries);

  // Named Agent calls are teammates (agent teams); match each to its run by description.
  const named = new Map<string, string>(); // description -> teammate name
  for (const e of entries) {
    for (const b of blocks(e)) {
      if (b.type === "tool_use" && (b.name === "Agent" || b.name === "Task") && b.input?.name) {
        named.set(String(b.input.description ?? ""), String(b.input.name));
      }
    }
  }

  const subagents: SubagentRun[] = [];
  const members: TeamMember[] = [];
  const dir = mainPath ? path.join(path.dirname(mainPath), sessionId, "subagents") : null;
  for (const name of dir ? await fs.readdir(dir).catch(() => [] as string[]) : []) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -6);
    const meta = JSON.parse(await fs.readFile(path.join(dir!, `${id}.meta.json`), "utf8").catch(() => "{}")) as
      { description?: string; agentType?: string };
    const runEntries = parse(await fs.readFile(path.join(dir!, name), "utf8").catch(() => ""));
    if (!runEntries.length) continue;
    const run = summarizeRun(id, runEntries, meta.description ?? meta.agentType ?? null, running);
    subagents.push(run);
    const teammate = meta.description != null ? named.get(meta.description) : undefined;
    if (teammate) {
      members.push({
        id, name: teammate, role: "teammate",
        status: run.status === "running" ? "running" : "inactive",
        description: meta.description, model: run.model ?? undefined,
      });
    }
  }
  subagents.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  const team = members.length || tasks
    ? {
        members: [{ id: sessionId, name: "lead", role: "lead" as const, status: running ? "running" as const : "inactive" as const }, ...members],
        tasks: tasks?.tasks ?? [],
        updatedAt: tasks?.updatedAt ?? Date.now(),
      }
    : null;
  return { main, turns, lastTurn, subagents, team };
}

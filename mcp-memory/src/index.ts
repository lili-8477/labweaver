#!/usr/bin/env node
/**
 * bioflow-memory-mcp — stdio MCP server giving agents the memory-api.
 *
 * Every tool is one operation of the memory contract
 * (hub/indexer/src/memory-contract.ts): its input schema becomes the tool's
 * JSON Schema, and callMemoryApi makes the request. This file adds only what
 * is agent-specific: tool names and descriptions, the argument spellings the
 * prompts use (memory_get's `id`, memory_dir's `dir`), and trimming results.
 *
 * - `username` is fixed per process from the env (one container = one user);
 *   the contract fills it in, so an agent can't read or write as another user.
 * - Org-scope writes are refused before any request (callerRefusal).
 * - Bad arguments and API/network errors become `isError: true` results the
 *   agent can read and act on, never transport errors.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import {
  callerRefusal, callMemoryApi, MEMORY_OPS, MemoryApiError, toolJsonSchema, type MemoryOp,
} from "../../hub/indexer/src/memory-contract.js";

// ─── tools ─────────────────────────────────────────────────────────────

interface Tool {
  name:        string;
  description: string;
  /** What the agent sends. */
  input:       z.ZodType;
  /** The operation an (already validated) call maps to. */
  op:          (args: Record<string, unknown>) => MemoryOp;
  /** Agent arguments → operation params; identity is added by the contract. */
  params?:     (args: Record<string, unknown>) => Record<string, unknown>;
  /** Trim the API's result for the agent. */
  shape?:      (result: unknown) => unknown;
}

const ops = MEMORY_OPS;

const TOOLS: Tool[] = [
  {
    name: "memory_search",
    description: "Search agent memories by hybrid (vector + FTS) ranking. Scoped to the current user; pass project_dir to narrow to one project. Results are snippets: open the ones you rely on with memory_get. Opening reinforces a memory, so what proves useful ranks higher next time.",
    input: ops.memory_search.input,
    op: () => "memory_search",
  },
  {
    name: "memory_get",
    description: "Fetch a single memory by id to use it in your work. Each fetch reinforces the memory, so call it for memories you actually rely on. Returns null/404-error if not found.",
    input: z.object({ id: z.string().min(1) }),
    op: () => "memory_get",
    // Every agent read counts as a use: an Auto-mode review verdict later
    // credits it (the outcome loop).
    params: (a) => ({ memory_id: a.id, use: true }),
  },
  {
    name: "memory_timeline",
    description: "List memories in reverse-chronological order for the current user, optionally narrowed by project_dir/since/until.",
    input: ops.memory_timeline.input,
    op: () => "memory_timeline",
  },
  {
    name: "memory_dir",
    description: "Browse memory directories. Without dir: every directory visible to you with its one-line summary (L0) and entry count. With dir: that directory's overview (L1) — its top entries' names and one-line descriptions; read an entry's full body with memory_get. Directories: user/{preferences,experience,notes}, project/{entities,trajectories,decisions}, org/{entities,experience,references}.",
    input: ops.memory_dir.input.omit({ dir_key: true }).extend({
      dir: ops.memory_dir.input.shape.dir_key.optional().describe("dir_key, e.g. project/decisions. Omit to list directories."),
    }),
    op: (a) => (a.dir === undefined ? "memory_dirs" : "memory_dir"),
    params: ({ dir, ...rest }) => (dir === undefined ? rest : { ...rest, dir_key: dir }),
  },
  {
    name: "memory_tree",
    description: "Overview of how your memory is growing: every directory with its entry count, plus topics — memories sharing a pipeline/tool/dataset facet — with how often they were used and succeeded in tasks. Topics are ranked by skill readiness (0..1); `ready: true` means the topic has enough memories and proven successful uses that it is worth distilling into a skill. Use it to suggest building a skill, then read the topic's memory_ids with memory_get.",
    input: z.object({}),
    op: () => "memory_tree",
    // The UI's tree also carries every memory leaf; the agent needs the
    // directory counts and the ranked topics.
    shape: (r) => {
      const tree = r as { dirs: unknown[]; memories: unknown[]; topics: unknown[]; thresholds: unknown };
      return { memories_total: tree.memories.length, dirs: tree.dirs, topics: tree.topics, thresholds: tree.thresholds };
    },
  },
  {
    name: "memory_write",
    description: "Author a new memory. scope='user' for personal memories, scope='project' (with project_dir) for project-scoped. scope='org' is admin-only and rejected here. If near-duplicates already exist in the target directory nothing is written and the result carries `similar` matches: merge into one with memory_merge, or re-send with force_new if it is genuinely distinct.",
    // The agent's view leaves org out; callerRefusal backs that up.
    input: ops.memory_write.input.extend({ scope: z.enum(["user", "project"]) }),
    op: () => "memory_write",
  },
  {
    name: "memory_feedback",
    description: "Report how a task went that used memories. Call once at the end of a task in which memories (from the memory index, recall, memory_search or memory_get) actually informed your work, with those ids. Ranking learns from these outcomes; merely retrieving a memory does not count.",
    input: ops.memory_feedback.input,
    op: () => "memory_feedback",
  },
  {
    name: "memory_merge",
    description: "Fold new information into an existing memory you own (the merge half of merge-on-write). Use after memory_write or memory_distill_session returns `similar` matches: rewrite the closest match's name/description/body so it covers both old and new content, without dropping facts from either. Works on distilled memories too.",
    input: ops.memory_update.input.pick({ memory_id: true, name: true, description: true, body: true }),
    op: () => "memory_update",
    params: (a) => ({ ...a, merge: true }),
  },
  {
    name: "memory_forget",
    description: "Soft-delete a memory by id. The agent's username (from env) must own the memory; cross-user deletes are rejected at the API layer.",
    input: ops.memory_forget.input,
    op: () => "memory_forget",
  },
  {
    name: "memory_distill_session",
    description: "Pin the current conversation to long-term scientific memory. Call ONCE per /memory invocation. Send exactly one `run` (what this session did: subject, statement, conditions, inputs, parameters, outputs, QC, evidence), 0..5 `claims` (observations, results, interpretations, decisions; claim_kind 'feedback' for user preferences), and 0..3 `experiences` (reusable lessons; each must name when it applies and at least one boundary condition or failure mode). Claims are immutable. The server never overwrites an older claim: same-condition re-runs with a newer version supersede it, different conditions qualify it. The result lists `related` claims to label with memory_link and `similar` experiences to fold in with memory_merge.",
    input: ops.memory_distill.input,
    op: () => "memory_distill",
  },
  {
    name: "memory_context",
    description: "Get a cited context bundle for a task: relevant prior results and run records, reusable experience, current pipeline/protocol versions, lineage (superseded, qualified, contradicted), evidence links and warnings. Prefer it over memory_search before scientific work. Pass `conditions` to exclude memories from other conditions (e.g. another cell line); memories that do not state a condition are kept and flagged unless strict.",
    input: ops.memory_bundle.input,
    op: () => "memory_bundle",
  },
  {
    name: "memory_link",
    description: "Write a typed edge `src rel dst` between two memories. Use SUPPORTS or CONTRADICTS to label the `related` claims memory_distill_session returns, QUALIFIES when conditions explain a difference, SUPERSEDES when a newer claim replaces yours. RETRACTS, VALIDATED_BY and FAILED_TO_REPLICATE only when the user explicitly says so. status 'rejected' undoes an edge (a rejected SUPERSEDES or RETRACTS restores the old claim).",
    input: ops.memory_link.input,
    op: () => "memory_link",
  },
];

/** What list_tools returns. */
export const toolDefinitions = TOOLS.map((t) => ({
  name:        t.name,
  description: t.description,
  inputSchema: toolJsonSchema(t.input),
}));

// ─── calling a tool ────────────────────────────────────────────────────

export interface ToolDeps {
  fetch:    typeof fetch;
  baseUrl:  string; // e.g. http://claude-bioflow-indexer:8400
  username: string;
  /** The container's SERVICE_ID, sent as a Bearer token so the hub knows the caller. */
  token?:   string;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const text = (t: string, isError = false): ToolResult =>
  ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

/** Run one tool call. Never throws: every failure is an isError result. */
export async function callTool(name: string, args: unknown, deps: ToolDeps): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return text(`unknown tool: ${name}`, true);
  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) return text(`${name}: invalid arguments\n${z.prettifyError(parsed.error)}`, true);
  const valid = parsed.data as Record<string, unknown>;
  const op = tool.op(valid);
  const params = tool.params ? tool.params(valid) : valid;
  const refusal = callerRefusal(op, params);
  if (refusal) return text(`${name} rejected: ${refusal}`, true);
  try {
    const result = await callMemoryApi(op, params, { baseUrl: deps.baseUrl, user: deps.username, token: deps.token, fetch: deps.fetch });
    return text(JSON.stringify(tool.shape ? tool.shape(result) : result));
  } catch (err) {
    if (err instanceof MemoryApiError) return text(`${name} failed: HTTP ${err.status} — ${err.body}`, true);
    return text(`${name} network error: ${(err as Error).message}`, true);
  }
}

// ─── stdio entrypoint ──────────────────────────────────────────────────
// Only run main() when invoked as a script. Test imports just want the
// tool functions and must not start a stdio server (which would hang
// vitest waiting for stdin).

async function main(): Promise<void> {
  const username = process.env.USERNAME ?? "";
  const baseUrl  = process.env.MEMORY_API_URL ?? "http://claude-bioflow-indexer:8400";
  if (!username) {
    console.error("[bioflow-memory-mcp] USERNAME env var required");
    process.exit(1);
  }

  // SERVICE_ID is inherited from the adapter, which spawns the agent (adapter/src/index.ts).
  const deps: ToolDeps = { fetch, baseUrl, username, token: process.env.SERVICE_ID || undefined };
  const server = new Server(
    { name: "bioflow-memory-mcp", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await callTool(req.params.name, req.params.arguments, deps);
    // SDK 1.x widened CallToolResult to include a "task" variant (long-running
    // tools); we only emit synchronous {content,isError} results, so cast.
    return result as unknown as { content: ToolResult["content"]; isError?: boolean };
  });
  await server.connect(new StdioServerTransport());
}

// Run main() when this file is the program entrypoint. Using import.meta.url
// vs process.argv[1] is the canonical ESM check and works whether the bundle
// runs as dist/index.js or via tsx during dev.
const invokedDirect =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/bioflow-memory-mcp") === true;
if (invokedDirect) {
  main().catch((err) => {
    console.error("[bioflow-memory-mcp] fatal:", err);
    process.exit(1);
  });
}

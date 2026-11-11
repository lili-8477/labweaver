// Team mode's task board, an in-process MCP server, as LabWeaver v2's
// team-board plugin. Claude Code's agent teams give the lead named teammates
// and messaging but no shared task list in this setup, so the lead plans on
// this board; the Agents panel shows it (get_chat_stats). One board per chat,
// kept in ~/.claude/team/<chat id>.json.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TeamTask {
  id: string;
  subject: string;
  description?: string;
  status: TaskStatus;
  ownerName?: string;
  blockedBy: string[];
  /** Pending, and everything it is blocked by is completed. */
  ready: boolean;
}

interface BoardFile {
  tasks: Omit<TeamTask, "ready">[];
  updatedAt: number;
}

const boardPath = (home: string, chatId: string) => path.join(home, ".claude", "team", `${chatId}.json`);

async function load(file: string): Promise<BoardFile> {
  const raw = await fs.readFile(file, "utf8").catch(() => null);
  return raw ? (JSON.parse(raw) as BoardFile) : { tasks: [], updatedAt: 0 };
}

function withReady(board: BoardFile): TeamTask[] {
  const done = new Set(board.tasks.filter((t) => t.status === "completed").map((t) => t.id));
  return board.tasks.map((t) => ({ ...t, ready: t.status === "pending" && t.blockedBy.every((id) => done.has(id)) }));
}

/** The chat's board, or null before the lead has created a task. */
export async function readTeamTasks(home: string, chatId: string): Promise<{ tasks: TeamTask[]; updatedAt: number } | null> {
  const board = await load(boardPath(home, chatId));
  return board.tasks.length ? { tasks: withReady(board), updatedAt: board.updatedAt } : null;
}

function render(tasks: TeamTask[]): string {
  if (!tasks.length) return "The board is empty.";
  return tasks.map((t) => {
    const deps = t.blockedBy.length ? ` blocked by ${t.blockedBy.join(", ")}` : "";
    const owner = t.ownerName ? ` @${t.ownerName}` : "";
    return `${t.id} [${t.status}${t.ready ? ", ready" : ""}]${owner} ${t.subject}${deps}`;
  }).join("\n");
}

export function teamBoardServer(home: string, chatId: string) {
  const file = boardPath(home, chatId);
  // Teammates call these concurrently; one write at a time keeps ids unique.
  let queue: Promise<unknown> = Promise.resolve();
  const update = <T>(fn: (b: BoardFile) => T): Promise<T> => {
    const run = queue.then(async () => {
      const board = await load(file);
      const out = fn(board);
      board.updatedAt = Date.now();
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(`${file}.tmp`, JSON.stringify(board));
      await fs.rename(`${file}.tmp`, file);
      return out;
    });
    queue = run.catch(() => undefined);
    return run;
  };
  const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

  return createSdkMcpServer({
    name: "team",
    tools: [
      tool(
        "team_task_create",
        "Add a task to the team's board. Use blocked_by for order (ids of tasks that must complete first) and " +
          "owner for the teammate who will do it. The user watches this board in the Agents panel.",
        {
          subject: z.string().describe("What the task delivers, imperative, under 12 words"),
          description: z.string().optional().describe("Details, including the files it will write"),
          owner: z.string().optional().describe("Teammate name"),
          blocked_by: z.array(z.string()).optional().describe("Ids of tasks that must complete first"),
        },
        async ({ subject, description, owner, blocked_by }) => {
          const id = await update((b) => {
            const id = `t${b.tasks.length + 1}`;
            b.tasks.push({ id, subject, description, status: "pending", ownerName: owner, blockedBy: blocked_by ?? [] });
            return id;
          });
          return text(`Created ${id}.`);
        },
        { alwaysLoad: true },
      ),
      tool(
        "team_task_update",
        "Update a task on the team's board: claim it (owner), start it (in_progress) or finish it (completed).",
        {
          id: z.string(),
          status: z.enum(["pending", "in_progress", "completed"]).optional(),
          owner: z.string().optional(),
        },
        async ({ id, status, owner }) => {
          const found = await update((b) => {
            const t = b.tasks.find((x) => x.id === id);
            if (t && status) t.status = status;
            if (t && owner) t.ownerName = owner;
            return !!t;
          });
          return found ? text(`Updated ${id}.`) : text(`No task ${id}.`, true);
        },
        { alwaysLoad: true },
      ),
      tool(
        "team_task_list",
        "List the team's board: each task's id, status, owner and dependencies.",
        {},
        async () => text(render(withReady(await load(file)))),
        { alwaysLoad: true },
      ),
    ],
  });
}

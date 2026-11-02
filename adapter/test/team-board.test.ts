import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { readTeamTasks, teamBoardServer } from "../src/team-board.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

describe("team board", () => {
  it("tracks tasks, owners and readiness", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "team-"));
    const server = teamBoardServer(home, "c1") as unknown as { instance: { _registeredTools: Record<string, { handler?: Handler; callback?: Handler }> } };
    const tools = server.instance._registeredTools;
    const call = (name: string, args: Record<string, unknown>) => (tools[name]!.handler ?? tools[name]!.callback)!(args);

    expect(await readTeamTasks(home, "c1")).toBeNull();
    await Promise.all([
      call("team_task_create", { subject: "Run QC", owner: "analyst" }),
      call("team_task_create", { subject: "Review QC", blocked_by: ["t1"] }),
    ]);
    let board = await readTeamTasks(home, "c1");
    expect(board!.tasks.map((t) => [t.id, t.ready])).toEqual([["t1", true], ["t2", false]]);

    await call("team_task_update", { id: "t1", status: "completed" });
    board = await readTeamTasks(home, "c1");
    expect(board!.tasks[1]!.ready).toBe(true);
    expect((await call("team_task_list", {})).content[0]!.text).toContain("t2 [pending, ready]");
    await fs.rm(home, { recursive: true, force: true });
  });
});

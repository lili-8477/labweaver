// Tests for project RPCs and per-chat cwd: list_projects / create_project,
// create_chat + set_chat_project_dir binding, and the cwd runChat and
// get_chat_messages use. ChatsRepo is an in-memory stub; runTurn is mocked.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRow } from "../src/chats-repo.js";
import { RpcRouter, type RpcDeps } from "../src/rpc.js";

const { runTurn } = vi.hoisted(() => ({ runTurn: vi.fn() }));
vi.mock("../src/claude.js", () => ({ runTurn }));

let ws: string;
let home: string;
let rows: Map<string, ChatRow>;

function chatRow(id: string, over: Partial<ChatRow> = {}): ChatRow {
  return {
    chat_id: id, username: "alice", session_id: null, name: "x", active_agent: null,
    project_dir: null, cwd: null, created_at: "", last_used_at: "", deleted_at: null,
    ...over,
  };
}

const chats = {
  create: vi.fn(async (id: string, name: string, projectDir: string | null = null) => {
    rows.set(id, chatRow(id, { name, project_dir: projectDir }));
  }),
  read: vi.fn(async (id: string) => rows.get(id) ?? null),
  setProjectDir: vi.fn(async (id: string, dir: string | null) => {
    const r = rows.get(id);
    if (r) r.project_dir = dir;
  }),
  setSessionUuid: vi.fn(async () => undefined),
  touch: vi.fn(async () => undefined),
  deleteByProject: vi.fn(async (dir: string) => {
    const ids = [...rows.values()].filter((r) => r.project_dir === dir).map((r) => r.chat_id);
    for (const id of ids) rows.delete(id);
    return ids;
  }),
};

function makeRouter() {
  const deps: RpcDeps = {
    serviceId: "test-service-id",
    workspaceRoot: ws,
    chats: chats as unknown as RpcDeps["chats"],
    home,
    defaultProjectCwd: ws,
    publishStream: () => undefined,
    publishRaw: () => undefined,
    streamSubject: (id) => `pantheon.stream.${id}`,
    kernelBridgePath: "/dev/null",
    kernelIdleCullMs: 0,
    kernelCullCheckIntervalMs: 60_000,
    memory: null,
    share: null,
  };
  return new RpcRouter(deps);
}

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "bioflow-ws-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "bioflow-home-"));
  rows = new Map();
  vi.clearAllMocks();
  runTurn.mockImplementation(async (args: { onSessionId: (s: string) => void }) => {
    args.onSessionId("33333333-3333-3333-3333-333333333333");
  });
});
afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

const chatMsg = (id: string) => ({ chat_id: id, message: [{ role: "user", content: "hi" }] });

describe("list_projects / create_project", () => {
  it("lists local_projects folders, skipping dot/underscore dirs and files", async () => {
    const root = path.join(ws, "local_projects");
    for (const d of ["pbmc", ".chat-attachments", "_starter_pipelines"]) {
      await fs.mkdir(path.join(root, d), { recursive: true });
    }
    await fs.writeFile(path.join(root, "notes.txt"), "");
    const res = await makeRouter().dispatch("list_projects", {}) as { projects: Array<{ dir: string; name: string }> };
    expect(res.projects.map((p) => [p.dir, p.name])).toEqual([["local_projects/pbmc", "pbmc"]]);
  });

  it("lists nothing when local_projects does not exist", async () => {
    const res = await makeRouter().dispatch("list_projects", {}) as { projects: unknown[] };
    expect(res.projects).toEqual([]);
  });

  it("creates a slugified folder, suffixing on collision", async () => {
    const router = makeRouter();
    const a = await router.dispatch("create_project", { name: "PBMC QC Run!" }) as { project: { dir: string } };
    const b = await router.dispatch("create_project", { name: "pbmc qc run" }) as { project: { dir: string } };
    expect(a.project.dir).toBe("local_projects/pbmc-qc-run");
    expect(b.project.dir).toBe("local_projects/pbmc-qc-run-2");
    await expect(fs.stat(path.join(ws, b.project.dir))).resolves.toBeTruthy();
  });

  it("rejects a name with no letters or digits", async () => {
    await expect(makeRouter().dispatch("create_project", { name: "../!!" })).rejects.toThrow(/letters or digits/);
  });
});

describe("chat ↔ project binding", () => {
  it("create_chat binds a validated project_dir", async () => {
    const res = await makeRouter().dispatch("create_chat", { project_dir: "local_projects/foo/" }) as { chat_id: string };
    expect(chats.create).toHaveBeenCalledWith(res.chat_id, "New chat", "local_projects/foo");
  });

  it("create_chat rejects an unsafe project_dir", async () => {
    await expect(makeRouter().dispatch("create_chat", { project_dir: "../etc" })).rejects.toThrow(/safe workspace-relative/);
    expect(chats.create).not.toHaveBeenCalled();
  });

  it("set_chat_project_dir works before the first turn and errors after", async () => {
    rows.set("c1", chatRow("c1"));
    rows.set("c2", chatRow("c2", { session_id: "s2" }));
    const router = makeRouter();
    await router.dispatch("set_chat_project_dir", { chat_id: "c1", project_dir: "local_projects/foo" });
    expect(rows.get("c1")!.project_dir).toBe("local_projects/foo");
    await expect(
      router.dispatch("set_chat_project_dir", { chat_id: "c2", project_dir: "local_projects/foo" }),
    ).rejects.toThrow(/already has a session/);
    expect(rows.get("c2")!.project_dir).toBeNull();
  });
});

describe("chat cwd", () => {
  it("starts a project chat's session in its project dir and stores that cwd", async () => {
    rows.set("c1", chatRow("c1", { project_dir: "local_projects/foo" }));
    await makeRouter().dispatch("chat", chatMsg("c1"));
    const cwd = path.join(ws, "local_projects/foo");
    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({
      cwd, projectConfigRoot: ws, resumeSessionId: undefined,
    }));
    await expect(fs.stat(cwd)).resolves.toBeTruthy();
    expect(chats.setSessionUuid).toHaveBeenCalledWith("c1", "33333333-3333-3333-3333-333333333333", cwd);
  });

  it("resumes in the stored cwd, and legacy chats (no cwd) in the default", async () => {
    const stored = path.join(ws, "local_projects/old");
    rows.set("c1", chatRow("c1", { session_id: "s1", cwd: stored, project_dir: "local_projects/new" }));
    rows.set("c2", chatRow("c2", { session_id: "s2", project_dir: "local_projects/foo" }));
    const router = makeRouter();
    await router.dispatch("chat", chatMsg("c1"));
    await router.dispatch("chat", chatMsg("c2"));
    expect(runTurn.mock.calls.map(([a]) => [a.cwd, a.resumeSessionId])).toEqual([
      [stored, "s1"],
      [ws, "s2"],
    ]);
  });

  it("get_chat_messages reads the transcript under the stored cwd", async () => {
    const cwd = "/workspace/local_projects/foo_bar";
    rows.set("c1", chatRow("c1", { session_id: "s1", cwd }));
    const dir = path.join(home, ".claude", "projects", "-workspace-local-projects-foo-bar");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "s1.jsonl"), JSON.stringify({ type: "user", message: { content: "hello" } }) + "\n");
    const res = await makeRouter().dispatch("get_chat_messages", { chat_id: "c1" }) as { messages: unknown[] };
    expect(res.messages).toEqual([{ role: "user", content: "hello" }]);
  });
});

describe("rename_project / delete_project", () => {
  const dir = "local_projects/pbmc";
  beforeEach(async () => {
    await fs.mkdir(path.join(ws, dir), { recursive: true });
    await fs.writeFile(path.join(ws, dir, "data.csv"), "a,b\n");
  });

  it("rename sets the display name and keeps the folder", async () => {
    const r = makeRouter();
    await r.dispatch("rename_project", { project_dir: dir, name: "  PBMC QC  " });
    const res = (await r.dispatch("list_projects", {})) as { projects: { dir: string; name: string }[] };
    expect(res.projects).toEqual([expect.objectContaining({ dir, name: "PBMC QC" })]);
  });

  it("rejects paths outside local_projects and missing projects", async () => {
    const r = makeRouter();
    await expect(r.dispatch("rename_project", { project_dir: "local_projects/../etc", name: "x" })).rejects.toThrow(/not a project/);
    await expect(r.dispatch("delete_project", { project_dir: "local_projects/.trash" })).rejects.toThrow(/not a project/);
    await expect(r.dispatch("delete_project", { project_dir: "local_projects/nope" })).rejects.toThrow(/not found/);
  });

  it("delete moves the folder to .trash and deletes only that project's chats", async () => {
    rows.set("a", chatRow("a", { project_dir: dir }));
    rows.set("b", chatRow("b", { project_dir: null }));
    const r = makeRouter();
    const res = (await r.dispatch("delete_project", { project_dir: dir })) as { trashed_to: string; deleted_chats: number };
    expect(res.deleted_chats).toBe(1);
    expect([...rows.keys()]).toEqual(["b"]);
    await expect(fs.stat(path.join(ws, dir))).rejects.toThrow();
    expect(res.trashed_to).toMatch(/^local_projects\/\.trash\/pbmc-/);
    expect(await fs.readFile(path.join(ws, res.trashed_to, "data.csv"), "utf8")).toBe("a,b\n");
    const list = (await r.dispatch("list_projects", {})) as { projects: unknown[] };
    expect(list.projects).toEqual([]);
  });
});

describe("list_project_notebooks", () => {
  it("lists projects with notebooks, skipping hidden folders and checkpoints", async () => {
    const put = async (rel: string) => {
      await fs.mkdir(path.dirname(path.join(ws, rel)), { recursive: true });
      await fs.writeFile(path.join(ws, rel), "{}");
    };
    await put("local_projects/pbmc/analysis.ipynb");
    await put("local_projects/pbmc/scripts/qc.ipynb");
    await put("local_projects/pbmc/.ipynb_checkpoints/qc-checkpoint.ipynb");
    await put("local_projects/pbmc/_attachments/old.ipynb");
    await put("local_projects/empty/data.csv");
    const r = makeRouter();
    const res = (await r.dispatch("list_project_notebooks", {})) as {
      projects: { dir: string; notebooks: { path: string }[] }[];
    };
    expect(res.projects.map((p) => p.dir)).toEqual(["local_projects/pbmc"]);
    expect(res.projects[0]!.notebooks.map((n) => n.path).sort()).toEqual([
      "local_projects/pbmc/analysis.ipynb",
      "local_projects/pbmc/scripts/qc.ipynb",
    ]);
  });
});

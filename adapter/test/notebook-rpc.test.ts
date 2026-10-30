import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotebookManager } from "../src/notebook-rpc.js";
import type { KernelBridge } from "../src/kernel.js";

describe("NotebookManager", () => {
  let root: string;
  let nm: NotebookManager;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "bioflow-nb-"));
    nm = new NotebookManager(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("read_notebook normalizes source array into a single string", async () => {
    const raw = {
      cells: [
        { cell_type: "code", source: ["print(", "'hi')"], id: "abc", outputs: [], execution_count: 3, metadata: {} },
        { cell_type: "markdown", source: "# Title", id: "def", metadata: {} },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    };
    await fs.writeFile(path.join(root, "n.ipynb"), JSON.stringify(raw), "utf8");
    const res = (await nm.readNotebook("n.ipynb")) as {
      success: boolean;
      cell_count: number;
      notebook: { cells: Array<{ source: string; cell_type: string; id: string }> };
    };
    expect(res.success).toBe(true);
    expect(res.cell_count).toBe(2);
    expect(res.notebook.cells[0]!.source).toBe("print('hi')");
    expect(res.notebook.cells[1]!.cell_type).toBe("markdown");
  });

  it("create_notebook writes a blank Python notebook", async () => {
    const res = (await nm.createNotebook("new.ipynb", "python")) as {
      success: boolean;
      notebook: { metadata: { kernelspec: { name: string } }; cells: unknown[] };
    };
    expect(res.success).toBe(true);
    expect(res.notebook.cells).toEqual([]);
    expect(res.notebook.metadata.kernelspec.name).toBe("python3");
    const back = await fs.readFile(path.join(root, "new.ipynb"), "utf8");
    expect(JSON.parse(back).nbformat).toBe(4);
  });

  it("add_cell + update_cell + delete_cell + move_cell round-trip", async () => {
    await nm.createNotebook("x.ipynb", "python");
    const a = (await nm.addCell("x.ipynb", "code", "1+1", undefined)) as { cell_id: string };
    const b = (await nm.addCell("x.ipynb", "code", "2+2", a.cell_id)) as { cell_id: string };
    await nm.updateCell("x.ipynb", a.cell_id, "print(1+1)");
    await nm.moveCell("x.ipynb", b.cell_id, undefined); // move b to top
    const after = (await nm.readNotebook("x.ipynb")) as {
      notebook: { cells: Array<{ id: string; source: string }> };
    };
    expect(after.notebook.cells.map((c) => c.id)).toEqual([b.cell_id, a.cell_id]);
    expect(after.notebook.cells[1]!.source).toBe("print(1+1)");
    await nm.deleteCell("x.ipynb", a.cell_id);
    const after2 = (await nm.readNotebook("x.ipynb")) as {
      notebook: { cells: Array<{ id: string }> };
    };
    expect(after2.notebook.cells.map((c) => c.id)).toEqual([b.cell_id]);
  });

  it("manage_kernel returns a dead kernel stub for status", async () => {
    const res = (await nm.manageKernel("x.ipynb", "status")) as {
      success: boolean;
      status: string;
    };
    expect(res.success).toBe(true);
    expect(res.status).toBe("dead");
  });

  it("execute_cell returns a structured 'no kernel' error when no kernel configured", async () => {
    await nm.createNotebook("x.ipynb", "python");
    const a = (await nm.addCell("x.ipynb", "code", "1+1", undefined)) as { cell_id: string };
    const res = (await nm.executeCell("x.ipynb", a.cell_id)) as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/kernel bridge not configured/i);
  });

  it("rejects paths that escape the workspace root", async () => {
    await expect(nm.readNotebook("../etc/passwd")).rejects.toThrow();
  });

  it("overlapping edits to one notebook all land", async () => {
    await nm.createNotebook("c.ipynb", "python");
    const a = (await nm.addCell("c.ipynb", "code", "a", undefined)) as { cell_id: string };
    await Promise.all([
      nm.updateCell("c.ipynb", a.cell_id, "a2"),
      nm.addCell("c.ipynb", "code", "b", a.cell_id),
      nm.addCell("c.ipynb", "code", "c", undefined),
    ]);
    const res = (await nm.readNotebook("c.ipynb")) as { notebook: { cells: Array<{ source: string }> } };
    expect(res.notebook.cells.map((c) => c.source)).toEqual(["a2", "b", "c"]);
  });

  it("update_cell replies without the notebook body", async () => {
    await nm.createNotebook("u.ipynb", "python");
    const a = (await nm.addCell("u.ipynb", "code", "x", undefined)) as { cell_id: string };
    const res = (await nm.updateCell("u.ipynb", a.cell_id, "y")) as Record<string, unknown>;
    expect(res.success).toBe(true);
    expect(res).not.toHaveProperty("notebook");
  });

  it("a finished run keeps edits made while it was running", async () => {
    let finish!: () => void;
    const kernel = {
      sessionId: "k1",
      execute: vi.fn(() => new Promise((resolve) => {
        finish = () => resolve({ status: "ok", execution_count: 7 });
      })),
    } as unknown as KernelBridge;
    const knm = new NotebookManager(root, () => kernel);
    await knm.createNotebook("r.ipynb", "python");
    const a = (await knm.addCell("r.ipynb", "code", "slow()", undefined)) as { cell_id: string };
    const run = knm.executeCell("r.ipynb", a.cell_id);
    await vi.waitFor(() => expect(kernel.execute).toHaveBeenCalled());
    await knm.addCell("r.ipynb", "code", "added during run", a.cell_id);
    await knm.updateCell("r.ipynb", a.cell_id, "slow(edited)");
    finish();
    await run;
    const res = (await knm.readNotebook("r.ipynb")) as {
      notebook: { cells: Array<{ source: string; execution_count: number | null }> };
    };
    expect(res.notebook.cells.map((c) => c.source)).toEqual(["slow(edited)", "added during run"]);
    expect(res.notebook.cells[0]!.execution_count).toBe(7);
  });

  describe("variables", () => {
    function fakeKernel(stdout: string) {
      const executeAndCollect = vi.fn(async () => ({ reply: { status: "ok" }, stdout }));
      const kernel = { restart: vi.fn(), executeAndCollect } as unknown as KernelBridge;
      return { kernel, executeAndCollect };
    }

    it("runs R introspection in an R notebook's own kernel", async () => {
      const { kernel, executeAndCollect } = fakeKernel('{"x":{"type":"integer","repr":"int 1","shape":null}}');
      const rnm = new NotebookManager(root, () => kernel);
      await rnm.createNotebook("r.ipynb", "r");
      await rnm.manageKernel("r.ipynb", "restart");
      const res = (await rnm.manageKernel("r.ipynb", "variables")) as { variables: Record<string, unknown> };
      // Passing "python3" here would make the bridge replace the R kernel.
      const [, code, spec] = executeAndCollect.mock.calls[0] as unknown as [string, string, string];
      expect(spec).toBe("ir");
      expect(code).toContain("globalenv()");
      expect(res.variables).toEqual({ x: { type: "integer", repr: "int 1", shape: null } });
    });

    it("runs Python introspection in a Python notebook", async () => {
      const { kernel, executeAndCollect } = fakeKernel("{}");
      const pnm = new NotebookManager(root, () => kernel);
      await pnm.createNotebook("p.ipynb", "python");
      await pnm.manageKernel("p.ipynb", "restart");
      await pnm.manageKernel("p.ipynb", "variables");
      const [, code, spec] = executeAndCollect.mock.calls[0] as unknown as [string, string, string];
      expect(spec).toBe("python3");
      expect(code).toContain("globals()");
    });
  });
});

import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTx } from "../src/tx.js";

function fakePool(failOn?: string) {
  const log: string[] = [];
  let released = 0;
  const client = {
    query: async (sql: string) => {
      log.push(sql);
      if (sql === failOn) throw new Error(`fail ${sql}`);
      return { rows: [], rowCount: 0 };
    },
    release: () => { released++; },
  };
  return { pool: { connect: async () => client } as unknown as Pool, log, released: () => released };
}

describe("withTx", () => {
  it("commits and returns the result", async () => {
    const f = fakePool();
    expect(await withTx(f.pool, async (c) => { await c.query("WORK"); return 7; })).toBe(7);
    expect(f.log).toEqual(["BEGIN", "WORK", "COMMIT"]);
    expect(f.released()).toBe(1);
  });

  it("rolls back when commitIf refuses the result", async () => {
    const f = fakePool();
    const r = await withTx(f.pool, async () => ({ ok: false }), (x) => x.ok);
    expect(r).toEqual({ ok: false });
    expect(f.log).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("rolls back and rethrows the original error, even if rollback fails", async () => {
    const f = fakePool("ROLLBACK");
    await expect(withTx(f.pool, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(f.log).toEqual(["BEGIN", "ROLLBACK"]);
    expect(f.released()).toBe(1);
  });
});

import { describe, it, expect } from "vitest";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import Fastify from "fastify";
import { parseCallerMap, claimedUser, checkCaller, checkCallers } from "../src/caller-check.js";

const ALICE = "a".repeat(64);
const BOB   = "b".repeat(64);

describe("parseCallerMap", () => {
  it("reads service-map.conf entries and skips anything else", () => {
    const map = parseCallerMap(
      `# GENERATED\nmap $lw_key $ws_user {\n    default "";\n    "${ALICE}" "alice";\n\n    "${BOB}" "bob";\nbroken line\n}\n`,
    );
    expect([...map]).toEqual([[ALICE, "alice"], [BOB, "bob"]]);
  });
});

describe("claimedUser", () => {
  it("prefers actor, then requester, then username, body before query", () => {
    expect(claimedUser({ body: { actor: "m", username: "u" }, query: {} })).toBe("m");
    expect(claimedUser({ body: { requester: "r" }, query: {} })).toBe("r");
    expect(claimedUser({ body: undefined, query: { username: "u" } })).toBe("u");
    expect(claimedUser({ body: undefined, query: {} })).toBeNull();
  });
});

describe("checkCaller", () => {
  const callers = new Map([[ALICE, "alice"]]);
  it("names the caller and flags each problem", () => {
    expect(checkCaller(callers, `Bearer ${ALICE}`, "alice")).toEqual({ caller: "alice", problem: null });
    expect(checkCaller(callers, `Bearer ${ALICE}`, null)).toEqual({ caller: "alice", problem: null });
    expect(checkCaller(callers, `Bearer ${ALICE}`, "bob")).toEqual({ caller: "alice", problem: "wrong_user" });
    expect(checkCaller(callers, `Bearer ${BOB}`, "bob")).toEqual({ caller: null, problem: "unknown_key" });
    expect(checkCaller(callers, undefined, "alice")).toEqual({ caller: null, problem: "no_key" });
    expect(checkCaller(callers, ALICE, "alice")).toEqual({ caller: null, problem: "no_key" });
  });
});

describe("checkCallers", () => {
  async function setup(mapText: string | null = `"${ALICE}" "alice";\n`) {
    const dir = mkdtempSync(path.join(tmpdir(), "caller-"));
    const mapFile = path.join(dir, "service-map.conf");
    if (mapText !== null) writeFileSync(mapFile, mapText);
    const warnings: object[] = [];
    const app = Fastify();
    // Routes first, hook after: the order index.ts uses for the memory routes.
    app.post("/memory/write", async () => ({ ok: true }));
    app.get("/healthz", async () => ({ ok: true }));
    app.post("/api/glasses/upload", async () => ({ ok: true }));
    checkCallers(app, { mapFile, warn: (obj: object) => warnings.push(obj) });
    await app.register(async (child) => { child.get("/share/list", async () => ({ ok: true })); });
    return { app, mapFile, warnings };
  }
  const asAlice = { authorization: `Bearer ${ALICE}` };
  const asBob   = { authorization: `Bearer ${BOB}` };

  it("lets the key's own user through and refuses everyone else", async () => {
    const { app, warnings } = await setup();
    const replies = [
      await app.inject({ method: "POST", url: "/memory/write", headers: asAlice, payload: { username: "alice" } }),
      await app.inject({ method: "GET",  url: "/share/list?actor=alice", headers: asAlice }),
      await app.inject({ method: "POST", url: "/memory/write", headers: asAlice, payload: { username: "bob" } }),
      await app.inject({ method: "POST", url: "/memory/write", headers: asAlice, payload: { username: "bob" } }),
      await app.inject({ method: "GET",  url: "/share/list?actor=alice" }),
      await app.inject({ method: "GET",  url: "/share/list?actor=bob", headers: asBob }),
    ];
    expect(replies.map((r) => r.statusCode)).toEqual([200, 200, 403, 403, 401, 401]);
    expect(replies[2]!.json()).toEqual({ error: "caller refused: wrong_user" });
    // Logged once per distinct refusal.
    expect(warnings.map((w) => (w as { problem: string }).problem)).toEqual(["wrong_user", "no_key", "unknown_key"]);
  });

  it("leaves health checks and glasses routes alone", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET",  url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/glasses/upload" })).statusCode).toBe(200);
  });

  it("picks up users added to the map file", async () => {
    const { app, mapFile } = await setup();
    expect((await app.inject({ method: "GET", url: "/share/list?actor=bob", headers: asBob })).statusCode).toBe(401);
    writeFileSync(mapFile, `"${ALICE}" "alice";\n"${BOB}" "bob";\n`);
    const later = new Date(Date.now() + 5_000);
    utimesSync(mapFile, later, later);
    expect((await app.inject({ method: "GET", url: "/share/list?actor=bob", headers: asBob })).statusCode).toBe(200);
  });

  it("refuses everyone, and says why once, when the map file is unreadable", async () => {
    const { app, warnings } = await setup(null);
    expect((await app.inject({ method: "GET", url: "/share/list?actor=alice", headers: asAlice })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/share/list?actor=alice", headers: asAlice })).statusCode).toBe(401);
    expect(warnings.filter((w) => "file" in w)).toHaveLength(1);
  });
});

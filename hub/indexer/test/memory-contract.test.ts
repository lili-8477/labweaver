import { describe, expect, it } from "vitest";
import { apiSchema, callerRefusal, callMemoryApi, MemoryApiError } from "../src/memory-contract.js";

/** A fetch that records the request and answers with `reply`. */
function recorder(reply: { status?: number; body: unknown }) {
  const calls: Array<{ url: URL; method: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    calls.push({
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const base = { baseUrl: "http://indexer:8400", user: "alice" };

describe("callMemoryApi", () => {
  it("sends POST params as a JSON body with the caller's identity, which params can't override", async () => {
    const { calls, fetchImpl } = recorder({ body: [] });
    await callMemoryApi("memory_search", { query: "qc", username: "mallory" }, { ...base, fetch: fetchImpl });
    expect(calls[0]).toMatchObject({ method: "POST", body: { query: "qc", username: "alice" } });
    expect(calls[0]!.url.pathname).toBe("/memory/search");
  });

  it("fills path segments from params and sends the rest of a GET as a querystring", async () => {
    const { calls, fetchImpl } = recorder({ body: { rows: [] } });
    await callMemoryApi("memory_audit", { memory_id: "m/1", limit: 5 }, { ...base, fetch: fetchImpl });
    expect(calls[0]!.url.pathname).toBe("/memory/m%2F1/audit");
    expect([...calls[0]!.url.searchParams]).toEqual([["limit", "5"], ["actor", "alice"]]);

    await callMemoryApi("memory_list", { type: ["claim", "experience"], include_deleted: true, dir: undefined }, { ...base, fetch: fetchImpl });
    expect(calls[1]!.url.searchParams.getAll("type")).toEqual(["claim", "experience"]);
    expect(calls[1]!.url.searchParams.get("include_deleted")).toBe("true");
    expect(calls[1]!.url.searchParams.has("dir")).toBe(false);
  });

  it("sends the token as a Bearer header on GET and POST, and no header without one", async () => {
    const { calls, fetchImpl } = recorder({ body: { rows: [] } });
    await callMemoryApi("memory_search", { query: "qc" }, { ...base, token: "sid", fetch: fetchImpl });
    await callMemoryApi("memory_audit", { memory_id: "m" }, { ...base, token: "sid", fetch: fetchImpl });
    await callMemoryApi("memory_audit", { memory_id: "m" }, { ...base, fetch: fetchImpl });
    expect(calls.map((c) => c.headers.authorization)).toEqual(["Bearer sid", "Bearer sid", undefined]);
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
  });

  it("throws the API's error text with the status", async () => {
    const { fetchImpl } = recorder({ status: 403, body: { error: "not the owner" } });
    const err = await callMemoryApi("memory_restore", { memory_id: "x" }, { ...base, fetch: fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(MemoryApiError);
    expect(err).toMatchObject({ message: "not the owner", status: 403 });
  });
});

describe("apiSchema", () => {
  it("requires the identity field and parses querystring values", () => {
    expect(apiSchema("memory_list").safeParse({ limit: "10" }).success).toBe(false);
    const q = apiSchema("memory_list").parse({ username: "alice", limit: "10", type: "claim", include_deleted: "false" });
    expect(q).toMatchObject({ username: "alice", limit: 10, type: ["claim"], include_deleted: false });
    expect(apiSchema("memory_list").parse({ username: "alice" }).include_deleted).toBe(false);
  });
});

describe("callerRefusal", () => {
  it("refuses org-scope writes from user-side callers only", () => {
    expect(callerRefusal("memory_write", { scope: "org" })).toMatch(/admin-only/);
    expect(callerRefusal("memory_write", { scope: "user" })).toBeNull();
    expect(callerRefusal("memory_search", { scope: "org" })).toBeNull();
  });
});

// The chat UI's memory_* RPCs, end to end through RpcRouter with a fake
// memory-api: which calls are forwarded, as whom, and what comes back.

import { describe, expect, it } from "vitest";
import { MemoryForwarder } from "../src/memory-rpc.js";
import { RpcRouter, type RpcDeps } from "../src/rpc.js";

function setup(reply: unknown = { ok: true }) {
  const requests: Array<{ url: URL; method: string; body: unknown }> = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    requests.push({
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as typeof fetch;
  const deps: RpcDeps = {
    serviceId: "svc",
    workspaceRoot: "/tmp/ws",
    chats: {} as RpcDeps["chats"],
    home: "/tmp/home",
    defaultProjectCwd: "/tmp/ws",
    publishStream: () => undefined,
    publishRaw: () => undefined,
    streamSubject: (id) => `pantheon.stream.${id}`,
    kernelBridgePath: "/dev/null",
    kernelIdleCullMs: 0,
    kernelCullCheckIntervalMs: 60_000,
    memory: new MemoryForwarder({ baseUrl: "http://indexer:8400", user: "alice", fetch: fetchImpl }),
    share: null,
  };
  return { router: new RpcRouter(deps), requests };
}

describe("memory_* RPCs", () => {
  it("forward to the memory-api as this container's user and return the API's result", async () => {
    const hits = [{ memory_id: "m1", name: "QC thresholds" }];
    const { router, requests } = setup(hits);
    expect(await router.dispatch("memory_search", { query: "qc", username: "mallory" })).toEqual(hits);
    expect(requests[0]).toMatchObject({ method: "POST", body: { query: "qc", username: "alice" } });
  });

  it("list only lab memories, whatever the UI asks for", async () => {
    const { router, requests } = setup([]);
    await router.dispatch("memory_search", { query: "qc", domain: "technical" });
    await router.dispatch("memory_list", {});
    await router.dispatch("memory_tree", {});
    await router.dispatch("memory_dirs", {});
    await router.dispatch("memory_graph", {});
    await router.dispatch("memory_get", { memory_id: "m1" });
    expect(requests[0]!.body).toMatchObject({ domain: "lab" });
    for (const r of requests.slice(1, 5)) expect(r.url.searchParams.get("domain")).toBe("lab");
    expect(requests[5]!.url.searchParams.has("domain")).toBe(false);
  });

  it("put the actor on owner-checked edits", async () => {
    const { router, requests } = setup();
    await router.dispatch("memory_update", { memory_id: "m1", name: "n", description: "d", body: "b", dir: "user/notes" });
    expect(requests[0]!.url.pathname).toBe("/memory/m1");
    expect(requests[0]).toMatchObject({ method: "PUT", body: { actor: "alice", name: "n", dir: "user/notes" } });
  });

  it("never forward what the UI doesn't use: writes, distills, admin passes", async () => {
    const { router, requests } = setup();
    for (const method of ["memory_write", "memory_distill", "memory_consolidate"]) {
      await expect(router.dispatch(method, { scope: "org" })).rejects.toThrow(/unknown method/);
    }
    expect(requests).toEqual([]);
  });
});

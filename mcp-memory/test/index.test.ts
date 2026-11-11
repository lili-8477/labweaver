import { describe, expect, it } from "vitest";
import { callTool, toolDefinitions, type ToolDeps } from "../src/index.js";

// Tools run against a stub fetch that records each request and answers with
// the scripted Response (or throws, for network errors). The SDK plumbing in
// main() is config; callTool is the logic.

type Sent = { url: URL; method: string; authorization?: string; body: unknown };

function deps(response: Response | Error = Response.json({ ok: true })): ToolDeps & { sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchStub = (async (url: string | URL, init?: RequestInit) => {
    sent.push({
      url: new URL(String(url)),
      method: init?.method ?? "GET",
      authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (response instanceof Error) throw response;
    return response.clone();
  }) as typeof fetch;
  return { fetch: fetchStub, baseUrl: "http://stub:8400", username: "alice", sent };
}

const payload = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

describe("toolDefinitions", () => {
  it("exposes the twelve memory tools with object schemas from the contract", () => {
    expect(toolDefinitions.map((t) => t.name).sort()).toEqual([
      "memory_context", "memory_dir", "memory_distill_session", "memory_feedback", "memory_forget",
      "memory_get", "memory_link", "memory_merge", "memory_search", "memory_timeline", "memory_tree", "memory_write",
    ]);
    for (const t of toolDefinitions) expect(t.inputSchema.type).toBe("object");
  });

  it("keeps the agent's view of writes to user and project scope", () => {
    const write = toolDefinitions.find((t) => t.name === "memory_write")!.inputSchema as { properties: Record<string, { enum?: string[] }> };
    expect(write.properties.scope!.enum).toEqual(["user", "project"]);
  });

  it("presents querystring integers and dates plainly", () => {
    const tl = toolDefinitions.find((t) => t.name === "memory_timeline")!.inputSchema as { properties: Record<string, object> };
    expect(tl.properties.limit).toEqual({ type: "integer", minimum: 1, maximum: 500 });
    expect(tl.properties.since).toEqual({ type: "string", format: "date-time" });
  });
});

describe("callTool", () => {
  it("sends the env user, never one the agent supplies", async () => {
    const d = deps(Response.json([]));
    await callTool("memory_search", { query: "qc", username: "mallory", conditions: { cell_line: ["HeLa"] } }, d);
    expect(d.sent[0]).toMatchObject({ method: "POST", body: { query: "qc", username: "alice", conditions: { cell_line: ["HeLa"] } } });
  });

  it("maps the prompts' argument spellings onto the operation", async () => {
    const d = deps(Response.json({}));
    await callTool("memory_get", { id: "a b/c" }, d);
    expect(d.sent[0]!.url.pathname).toBe("/memory/a%20b%2Fc");
    expect(d.sent[0]!.url.searchParams.get("username")).toBe("alice");
    expect(d.sent[0]!.url.searchParams.get("use")).toBe("true");

    await callTool("memory_dir", { project_dir: "-w" }, d);
    expect(d.sent[1]!.url.pathname).toBe("/memory/dirs");
    await callTool("memory_dir", { dir: "project/decisions", limit: 5 }, d);
    expect(d.sent[2]!.url.pathname).toBe("/memory/dirs/project%2Fdecisions");
    expect(d.sent[2]!.url.searchParams.get("limit")).toBe("5");
    expect(d.sent[2]!.url.searchParams.get("username")).toBe("alice");
  });

  it("merges by PUTting the new text as the env user with merge=true", async () => {
    const d = deps();
    await callTool("memory_merge", { memory_id: "m1", name: "n", description: "d", body: "b" }, d);
    expect(d.sent[0]).toMatchObject({ method: "PUT", body: { actor: "alice", name: "n", body: "b", merge: true } });
    expect(d.sent[0]!.url.pathname).toBe("/memory/m1");
  });

  it("refuses org writes and invalid arguments without a request", async () => {
    const d = deps();
    const org = await callTool("memory_write", { scope: "org", type: "user", name: "n", description: "", body: "" }, d);
    expect(org.isError).toBe(true);
    const noRun = await callTool("memory_distill_session", { claims: [] }, d);
    expect(noRun).toMatchObject({ isError: true });
    expect(noRun.content[0]!.text).toMatch(/invalid arguments[\s\S]*run/);
    expect((await callTool("memory_forget", {}, d)).isError).toBe(true);
    expect(d.sent).toEqual([]);
  });

  it("turns API and network failures into tool errors", async () => {
    const api = await callTool("memory_get", { id: "x" }, deps(Response.json({ error: "memory not found" }, { status: 404 })));
    expect(api).toMatchObject({ isError: true });
    expect(api.content[0]!.text).toMatch(/memory_get failed: HTTP 404 — .*memory not found/);
    const net = await callTool("memory_link", { src_id: crypto.randomUUID(), dst_id: crypto.randomUUID(), rel: "SUPPORTS" }, deps(new Error("ECONNREFUSED")));
    expect(net.content[0]!.text).toBe("memory_link network error: ECONNREFUSED");
  });

  it("gives the agent the tree's counts and topics without the memory leaves", async () => {
    const tree = { dirs: [{ dir_key: "user/notes" }], memories: [{}, {}], topics: [{ topic: "tool:x" }], thresholds: { memories: 3, successes: 2 } };
    const r = await callTool("memory_tree", {}, deps(Response.json(tree)));
    expect(payload(r)).toEqual({ memories_total: 2, dirs: tree.dirs, topics: tree.topics, thresholds: tree.thresholds });
  });

  it("forwards the scientific tools to their routes", async () => {
    const d = deps();
    await callTool("memory_context", { query: "qc for HeLa" }, d);
    await callTool("memory_distill_session", { run: { subject: "s", statement: "t" } }, d);
    expect(d.sent.map((s) => s.url.pathname)).toEqual(["/memory/bundle", "/memory/distill"]);
    expect(d.sent[1]!.body).toMatchObject({ username: "alice", run: { subject: "s" }, claims: [], experiences: [] });
  });
});

describe("caller token", () => {
  it("sends the container's SERVICE_ID as a Bearer header when it has one", async () => {
    const d = deps(Response.json([]));
    await callTool("memory_search", { query: "qc" }, { ...d, token: "sid-alice" });
    await callTool("memory_search", { query: "qc" }, d);
    expect(d.sent.map((r) => r.authorization)).toEqual(["Bearer sid-alice", undefined]);
  });
});

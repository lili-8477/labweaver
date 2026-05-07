// Tests for the six share_* RPC dispatch branches in RpcRouter.
// Uses vi.fn() stubs for ShareRpcClient — no real HTTP or PG needed.

import { describe, it, expect, vi } from "vitest";
import { RpcRouter } from "../src/rpc.js";
import type { RpcDeps } from "../src/rpc.js";
import type { ShareRpcClient } from "../src/share-rpc.js";

// Minimal deps that satisfy RpcDeps without touching PG, NATS, or the kernel.
// We cast ChatsRepo as unknown because the router never calls chats methods in
// these tests — only the share branches execute.
function makeRouter(share: ShareRpcClient | null): RpcRouter {
  const deps: RpcDeps = {
    serviceId: "test-service-id",
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
    memory: null,
    share,
  };
  return new RpcRouter(deps);
}

// Build a stub ShareRpcClient whose methods all return canned values.
function makeShareClient(overrides: Partial<{
  submit: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  decide: ReturnType<typeof vi.fn>;
  withdraw: ReturnType<typeof vi.fn>;
  capabilities: ReturnType<typeof vi.fn>;
}> = {}): ShareRpcClient {
  return {
    submit: overrides.submit ?? vi.fn().mockResolvedValue({ share_id: "sh-1" }),
    list: overrides.list ?? vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    get: overrides.get ?? vi.fn().mockResolvedValue({ id: "sh-1", status: "pending" }),
    decide: overrides.decide ?? vi.fn().mockResolvedValue({ status: "approved" }),
    withdraw: overrides.withdraw ?? vi.fn().mockResolvedValue({ ok: true, status: "withdrawn" }),
    capabilities: overrides.capabilities ?? vi.fn().mockResolvedValue({
      is_manager: false,
      manager_username: null,
      pending_inbox_count: 0,
      actor_username: "alice",
    }),
  } as unknown as ShareRpcClient;
}

describe("RpcRouter share_* dispatch", () => {
  describe("share_submit", () => {
    it("calls client.submit and returns {success, share_id}", async () => {
      const submitFn = vi.fn().mockResolvedValue({ share_id: "sh-new-42" });
      const client = makeShareClient({ submit: submitFn });
      const router = makeRouter(client);

      const res = await router.dispatch("share_submit", {
        kind: "memory",
        ref: "mem-123",
        note: "please review",
      }) as Record<string, unknown>;

      expect(submitFn).toHaveBeenCalledOnce();
      expect(submitFn).toHaveBeenCalledWith({
        kind: "memory",
        ref: "mem-123",
        note: "please review",
      });
      expect(res.success).toBe(true);
      expect(res.share_id).toBe("sh-new-42");
    });
  });

  describe("share_list", () => {
    it("calls client.list and spreads {items, next_cursor} alongside success", async () => {
      const items = [{ id: "sh-1", status: "pending" }, { id: "sh-2", status: "approved" }];
      const listFn = vi.fn().mockResolvedValue({ items, next_cursor: "tok-abc" });
      const client = makeShareClient({ list: listFn });
      const router = makeRouter(client);

      const res = await router.dispatch("share_list", {
        role: "outbox",
        status: "pending",
        limit: 20,
      }) as Record<string, unknown>;

      expect(listFn).toHaveBeenCalledOnce();
      expect(listFn).toHaveBeenCalledWith({
        role: "outbox",
        status: "pending",
        limit: 20,
      });
      expect(res.success).toBe(true);
      expect(res.items).toEqual(items);
      expect(res.next_cursor).toBe("tok-abc");
    });
  });

  describe("share_get", () => {
    it("calls client.get(share_id) and wraps as {success, share}", async () => {
      const detail = { id: "sh-99", kind: "memory", ref: "mem-7", status: "pending" };
      const getFn = vi.fn().mockResolvedValue(detail);
      const client = makeShareClient({ get: getFn });
      const router = makeRouter(client);

      const res = await router.dispatch("share_get", { share_id: "sh-99" }) as Record<string, unknown>;

      expect(getFn).toHaveBeenCalledOnce();
      expect(getFn).toHaveBeenCalledWith("sh-99");
      expect(res.success).toBe(true);
      expect(res.share).toEqual(detail);
    });
  });

  describe("share_decide", () => {
    it("calls client.decide(share_id, {decision, comment}) and returns {success, status}", async () => {
      const decideFn = vi.fn().mockResolvedValue({ status: "approved", promotion_result: { memory_id: "m-new" } });
      const client = makeShareClient({ decide: decideFn });
      const router = makeRouter(client);

      const res = await router.dispatch("share_decide", {
        share_id: "sh-55",
        decision: "approve",
        comment: "looks good",
      }) as Record<string, unknown>;

      expect(decideFn).toHaveBeenCalledOnce();
      expect(decideFn).toHaveBeenCalledWith("sh-55", {
        decision: "approve",
        comment: "looks good",
      });
      expect(res.success).toBe(true);
      expect(res.status).toBe("approved");
      expect((res.promotion_result as Record<string, unknown>).memory_id).toBe("m-new");
    });
  });

  describe("share_withdraw", () => {
    it("calls client.withdraw(share_id) and returns {success, ok, status}", async () => {
      const withdrawFn = vi.fn().mockResolvedValue({ ok: true, status: "withdrawn" });
      const client = makeShareClient({ withdraw: withdrawFn });
      const router = makeRouter(client);

      const res = await router.dispatch("share_withdraw", { share_id: "sh-77" }) as Record<string, unknown>;

      expect(withdrawFn).toHaveBeenCalledOnce();
      expect(withdrawFn).toHaveBeenCalledWith("sh-77");
      expect(res.success).toBe(true);
      expect(res.ok).toBe(true);
      expect(res.status).toBe("withdrawn");
    });
  });

  describe("share_capabilities", () => {
    it("calls client.capabilities() and spreads result alongside success", async () => {
      const caps = {
        is_manager: true,
        manager_username: "alice",
        pending_inbox_count: 3,
        actor_username: "alice",
      };
      const capsFn = vi.fn().mockResolvedValue(caps);
      const client = makeShareClient({ capabilities: capsFn });
      const router = makeRouter(client);

      const res = await router.dispatch("share_capabilities", {}) as Record<string, unknown>;

      expect(capsFn).toHaveBeenCalledOnce();
      expect(res.success).toBe(true);
      expect(res.is_manager).toBe(true);
      expect(res.manager_username).toBe("alice");
      expect(res.pending_inbox_count).toBe(3);
      expect(res.actor_username).toBe("alice");
    });
  });

  describe("null share client", () => {
    it("throws 'share api not configured' for every branch when share is null", async () => {
      const router = makeRouter(null);

      const methods = [
        ["share_submit", { kind: "memory", ref: "mem-1" }],
        ["share_list", { role: "outbox" }],
        ["share_get", { share_id: "sh-1" }],
        ["share_decide", { share_id: "sh-1", decision: "approve" }],
        ["share_withdraw", { share_id: "sh-1" }],
        ["share_capabilities", {}],
      ] as const;

      for (const [method, params] of methods) {
        await expect(
          router.dispatch(method, params as Record<string, unknown>),
        ).rejects.toThrow("share api not configured");
      }
    });
  });
});

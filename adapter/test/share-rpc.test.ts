import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { ShareRpcClient } from "../src/share-rpc.js";

interface ServerState {
  lastReq?: { method: string; url: string; body?: Record<string, unknown> };
  nextResponse?: { status: number; body: unknown };
  responseDelay?: number;
}

let server: Server;
let baseUrl: string;
let state: ServerState = {};

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const method = req.method || "GET";
      const url = req.url || "/";

      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });

      req.on("end", () => {
        try {
          state.lastReq = {
            method,
            url,
            body: body ? (JSON.parse(body) as Record<string, unknown>) : undefined,
          };

          const delayMs = state.responseDelay || 0;
          setTimeout(() => {
            const { status = 200, body: respBody = {} } = state.nextResponse || {};
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(respBody));
          }, delayMs);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal" }));
        }
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr !== "string") {
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      }
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

describe("ShareRpcClient", () => {
  describe("submit", () => {
    it("POST /share/submit with requester from constructor + caller fields", async () => {
      state = { nextResponse: { status: 201, body: { id: "share-001", status: "pending" } } };

      const client = new ShareRpcClient(baseUrl, "alice");
      const result = await client.submit({ kind: "memory", ref: "mem-123", note: "please share" });

      expect(state.lastReq!.method).toBe("POST");
      expect(state.lastReq!.url).toBe("/share/submit");
      expect(state.lastReq!.body).toEqual({
        requester: "alice",
        kind: "memory",
        ref: "mem-123",
        note: "please share",
      });
      expect(result).toEqual({ id: "share-001", status: "pending" });
    });

    it("submit without optional note field", async () => {
      state = { nextResponse: { status: 201, body: { id: "share-002" } } };

      const client = new ShareRpcClient(baseUrl, "bob");
      await client.submit({ kind: "skill", ref: "skill-abc" });

      expect(state.lastReq!.body).toEqual({
        requester: "bob",
        kind: "skill",
        ref: "skill-abc",
      });
    });
  });

  describe("list", () => {
    it("GET /share/list?actor=...&role=...", async () => {
      state = { nextResponse: { status: 200, body: { items: [], cursor: null } } };

      const client = new ShareRpcClient(baseUrl, "alice");
      const result = await client.list({ role: "inbox" });

      expect(state.lastReq!.method).toBe("GET");
      expect(state.lastReq!.url).toContain("/share/list");
      expect(state.lastReq!.url).toContain("actor=alice");
      expect(state.lastReq!.url).toContain("role=inbox");
      expect(result).toEqual({ items: [], cursor: null });
    });

    it("list with optional status, limit, cursor", async () => {
      state = { nextResponse: { status: 200, body: { items: [] } } };

      const client = new ShareRpcClient(baseUrl, "alice");
      await client.list({ role: "outbox", status: "pending", limit: 20, cursor: "tok-xyz" });

      const url = state.lastReq!.url;
      expect(url).toContain("role=outbox");
      expect(url).toContain("status=pending");
      expect(url).toContain("limit=20");
      expect(url).toContain("cursor=tok-xyz");
    });

    it("list omits undefined optional params", async () => {
      state = { nextResponse: { status: 200, body: {} } };

      const client = new ShareRpcClient(baseUrl, "alice");
      await client.list({ role: "all" });

      const url = state.lastReq!.url;
      expect(url).not.toContain("status=");
      expect(url).not.toContain("limit=");
      expect(url).not.toContain("cursor=");
    });
  });

  describe("get", () => {
    it("GET /share/:id?actor=...", async () => {
      state = { nextResponse: { status: 200, body: { id: "share-001", status: "pending" } } };

      const client = new ShareRpcClient(baseUrl, "alice");
      const result = await client.get("share-001");

      expect(state.lastReq!.method).toBe("GET");
      expect(state.lastReq!.url).toContain("/share/share-001");
      expect(state.lastReq!.url).toContain("actor=alice");
      expect(result).toEqual({ id: "share-001", status: "pending" });
    });

    it("get encodes id containing '/' correctly", async () => {
      state = { nextResponse: { status: 200, body: {} } };

      const client = new ShareRpcClient(baseUrl, "alice");
      await client.get("org/share/42");

      expect(state.lastReq!.url).toContain("/share/org%2Fshare%2F42");
    });
  });

  describe("decide", () => {
    it("POST /share/:id/decide with actor + decision + comment", async () => {
      state = { nextResponse: { status: 200, body: { ok: true } } };

      const client = new ShareRpcClient(baseUrl, "alice");
      const result = await client.decide("share-001", { decision: "approve", comment: "looks good" });

      expect(state.lastReq!.method).toBe("POST");
      expect(state.lastReq!.url).toBe("/share/share-001/decide");
      expect(state.lastReq!.body).toEqual({
        actor: "alice",
        decision: "approve",
        comment: "looks good",
      });
      expect(result).toEqual({ ok: true });
    });

    it("decide without optional comment", async () => {
      state = { nextResponse: { status: 200, body: { ok: true } } };

      const client = new ShareRpcClient(baseUrl, "bob");
      await client.decide("share-002", { decision: "reject" });

      expect(state.lastReq!.body).toEqual({
        actor: "bob",
        decision: "reject",
      });
    });

    it("decide encodes id with special characters", async () => {
      state = { nextResponse: { status: 200, body: {} } };

      const client = new ShareRpcClient(baseUrl, "alice");
      await client.decide("share/001", { decision: "approve" });

      expect(state.lastReq!.url).toBe("/share/share%2F001/decide");
    });
  });

  describe("withdraw", () => {
    it("POST /share/:id/withdraw with actor", async () => {
      state = { nextResponse: { status: 200, body: { ok: true } } };

      const client = new ShareRpcClient(baseUrl, "alice");
      const result = await client.withdraw("share-001");

      expect(state.lastReq!.method).toBe("POST");
      expect(state.lastReq!.url).toBe("/share/share-001/withdraw");
      expect(state.lastReq!.body).toEqual({ actor: "alice" });
      expect(result).toEqual({ ok: true });
    });

    it("withdraw encodes id with special characters", async () => {
      state = { nextResponse: { status: 200, body: {} } };

      const client = new ShareRpcClient(baseUrl, "alice");
      await client.withdraw("share/001");

      expect(state.lastReq!.url).toBe("/share/share%2F001/withdraw");
    });
  });

  describe("capabilities", () => {
    it("GET /share/capabilities?actor=...", async () => {
      state = {
        nextResponse: {
          status: 200,
          body: { can_submit: true, can_approve: false },
        },
      };

      const client = new ShareRpcClient(baseUrl, "alice");
      const result = await client.capabilities();

      expect(state.lastReq!.method).toBe("GET");
      expect(state.lastReq!.url).toContain("/share/capabilities");
      expect(state.lastReq!.url).toContain("actor=alice");
      expect(result).toEqual({ can_submit: true, can_approve: false });
    });
  });

  describe("error handling", () => {
    it("400 from API surfaces as thrown Error with the API's error message", async () => {
      state = {
        nextResponse: {
          status: 400,
          body: { error: "validation failed", issues: ["ref is required"] },
        },
      };

      const client = new ShareRpcClient(baseUrl, "alice");
      await expect(
        client.submit({ kind: "memory", ref: "" }),
      ).rejects.toThrow("validation failed");
    });

    it("throws Error with statusText if response has no error field", async () => {
      state = { nextResponse: { status: 500, body: { message: "boom" } } };

      const client = new ShareRpcClient(baseUrl, "alice");
      await expect(client.capabilities()).rejects.toThrow("Internal Server Error");
    });

    it("throws formatted error if response body is not JSON", async () => {
      server.removeAllListeners("request");
      server.on("request", (req: IncomingMessage, res: ServerResponse) => {
        if (req.url?.startsWith("/share/capabilities")) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal Server Error");
        }
      });

      const client = new ShareRpcClient(baseUrl, "alice");
      await expect(client.capabilities()).rejects.toThrow(
        /share-api GET \/share\/capabilities → HTTP 500/,
      );

      restoreHandler();
    });

    it("network error (socket close) causes client to throw", async () => {
      server.removeAllListeners("request");
      server.on("request", (req: IncomingMessage, res: ServerResponse) => {
        // Forcibly destroy the socket without sending a response
        res.socket?.destroy();
      });

      const client = new ShareRpcClient(baseUrl, "alice");
      await expect(client.capabilities()).rejects.toThrow();

      restoreHandler();
    });
  });

  describe("timeout handling", () => {
    it("AbortController timeout causes client to throw", async () => {
      state = { responseDelay: 200, nextResponse: { status: 200, body: {} } };

      // Override timeoutMs via a small value so the test doesn't actually wait 5s
      const client = new ShareRpcClient(baseUrl, "alice");
      // @ts-expect-error — intentionally overriding private field for test
      client.timeoutMs = 50;

      await expect(client.capabilities()).rejects.toThrow(
        /share-api request timed out after 50ms/,
      );
    });

    it("POST request also respects timeout", async () => {
      state = { responseDelay: 200, nextResponse: { status: 200, body: {} } };

      const client = new ShareRpcClient(baseUrl, "alice");
      // @ts-expect-error — intentionally overriding private field for test
      client.timeoutMs = 50;

      await expect(
        client.submit({ kind: "memory", ref: "mem-1" }),
      ).rejects.toThrow(/share-api request timed out after 50ms/);
    });
  });

  describe("construction", () => {
    it("does not make I/O at construction time", () => {
      state = {};
      const client = new ShareRpcClient(baseUrl, "alice");

      expect(state.lastReq).toBeUndefined();
      expect(client).toBeDefined();
    });
  });
});

function restoreHandler() {
  server.removeAllListeners("request");
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method || "GET";
    const url = req.url || "/";

    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });

    req.on("end", () => {
      try {
        state.lastReq = {
          method,
          url,
          body: body ? (JSON.parse(body) as Record<string, unknown>) : undefined,
        };

        const delayMs = state.responseDelay || 0;
        setTimeout(() => {
          const { status = 200, body: respBody = {} } = state.nextResponse || {};
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(respBody));
        }, delayMs);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      }
    });
  });
}

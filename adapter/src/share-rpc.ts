// HTTP client for the share-api backend. Pure transport: one method per
// share-api route, the username is supplied at construction time. No business
// logic. Handles HTTP errors as thrown Error with the API's `error` string
// when present (so dispatchInner can surface them through NATS as RPC errors).

export class ShareRpcClient {
  private readonly timeoutMs = 5000;

  constructor(
    private baseUrl: string,
    private username: string,
  ) {}

  // POST /share/submit  body: { requester, kind, ref, note? }
  async submit(p: {
    kind: "memory" | "skill" | "folder";
    ref: string;
    note?: string;
  }): Promise<unknown> {
    return this.post("/share/submit", { requester: this.username, ...p });
  }

  // GET /share/list  query: actor, role, status?, limit?, cursor?
  async list(qs: {
    role: "outbox" | "inbox" | "all";
    status?: "pending" | "approved" | "rejected" | "withdrawn";
    limit?: number;
    cursor?: string;
  }): Promise<unknown> {
    return this.fetchJson("/share/list", { actor: this.username, ...qs });
  }

  // GET /share/:id  query: actor
  async get(id: string): Promise<unknown> {
    return this.fetchJson(`/share/${encodeURIComponent(id)}`, { actor: this.username });
  }

  // POST /share/:id/decide  body: { actor, decision, comment? }
  async decide(
    id: string,
    p: { decision: "approve" | "reject"; comment?: string },
  ): Promise<unknown> {
    return this.post(`/share/${encodeURIComponent(id)}/decide`, { actor: this.username, ...p });
  }

  // POST /share/:id/withdraw  body: { actor }
  async withdraw(id: string): Promise<unknown> {
    return this.post(`/share/${encodeURIComponent(id)}/withdraw`, { actor: this.username });
  }

  // GET /share/capabilities  query: actor
  async capabilities(): Promise<unknown> {
    return this.fetchJson("/share/capabilities", { actor: this.username });
  }

  private async fetchJson(
    path: string,
    qs?: Record<string, unknown>,
  ): Promise<unknown> {
    const url = this.buildUrl(path, qs);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });

      if (!res.ok) {
        await this.throwError(res, "GET", path);
      }

      return await res.json();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`share-api request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const url = this.baseUrl + path;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        await this.throwError(res, "POST", path);
      }

      return await res.json();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`share-api request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildUrl(path: string, qs?: Record<string, unknown>): string {
    const url = new URL(path, this.baseUrl);

    if (qs) {
      for (const [key, value] of Object.entries(qs)) {
        if (value === undefined) continue;

        if (Array.isArray(value)) {
          for (const item of value) {
            url.searchParams.append(key, String(item));
          }
        } else if (value !== null) {
          url.searchParams.append(key, String(value));
        }
      }
    }

    return url.toString();
  }

  private async throwError(res: Response, method: string, path: string): Promise<never> {
    let errorMessage: string;

    try {
      const json = (await res.json()) as Record<string, unknown>;
      errorMessage = typeof json.error === "string" ? json.error : res.statusText;
    } catch {
      errorMessage = `share-api ${method} ${path} → HTTP ${res.status}`;
    }

    throw new Error(errorMessage);
  }
}

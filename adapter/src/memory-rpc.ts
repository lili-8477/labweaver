// The chat UI's memory_* RPCs: forwarded to the memory-api through the
// memory contract (hub/indexer/src/memory-contract.ts), which knows each
// operation's route and identity field. This process fills the identity with
// its own user, so the browser can never act as someone else, and refuses
// what no user-side caller may do (org-scope writes). Its listings show the
// lab domain only (UI_DOMAIN). Results come back as
// the API sends them, typed by the contract.

import {
  callerRefusal, callMemoryApi, UI_DOMAIN, UI_DOMAIN_OPS, UI_OPS, type MemoryResult, type UiOp,
} from "../../hub/indexer/src/memory-contract.js";

export class MemoryForwarder {
  constructor(private readonly opts: { baseUrl: string; user: string; token?: string; fetch?: typeof fetch }) {}

  /** Whether `method` is a memory operation the UI may call. */
  static handles(method: string): method is UiOp {
    return (UI_OPS as readonly string[]).includes(method);
  }

  async call<O extends UiOp>(op: O, params: Record<string, unknown>): Promise<MemoryResult<O>> {
    const refusal = callerRefusal(op, params);
    if (refusal) throw new Error(`${op}: ${refusal}`);
    // The UI's users are life scientists: its listings show lab memories only.
    const pinned = (UI_DOMAIN_OPS as readonly string[]).includes(op) ? { ...params, domain: UI_DOMAIN } : params;
    return callMemoryApi(op, pinned, this.opts);
  }

  /** Credit a task outcome to the memories this user's agent used since `since` (the outcome loop). */
  async outcome(outcome: "success" | "failure", since: string): Promise<void> {
    await callMemoryApi("memory_outcome", { outcome, since }, this.opts);
  }
}

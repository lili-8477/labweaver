// Node-side wrapper around image/kernel-bridge.py.
//
// Spawns one Python child per adapter process (lazy, on first execute).
// Forwards execute/interrupt/restart as JSON lines on stdin; reads JSON lines
// on stdout and routes them to:
//   - IOPub messages → NATS stream `notebook_iopub_<sessionId>`
//   - execute_reply → resolves the pending execute() promise
//   - status changes → tracked in `status`, also streamed to the same subject

import { ChildProcess, spawn as realSpawn } from "node:child_process";
import { createInterface } from "node:readline";

export type SpawnFn = (cmd: string, args: string[], opts: object) => ChildProcess;

export type KernelStatus = "starting" | "idle" | "busy" | "dead" | "unknown";

export interface IOPubEvent {
  msg_type: string;
  content: Record<string, unknown>;
  cell_id: string | null;
  parent_msg_id: string | null;
}

export interface ExecuteReply {
  status: "ok" | "error" | string;
  execution_count: number | null;
  error: string | null;
}

export interface KernelSnapshot {
  sessionId: string;
  status: KernelStatus;
  running: boolean;
  pid: number | null;
  /** Epoch ms when the current kernel process was spawned, or null if never started. */
  startedAt: number | null;
  /** Epoch ms of the last observed activity (execute request or iopub message). */
  lastActivityAt: number | null;
  /** Milliseconds since last activity. 0 while an execute is in flight (kernel is active). */
  idleMs: number;
  /** Number of execute requests currently awaiting a reply. */
  inFlight: number;
}

export interface KernelDeps {
  /** Path to the Python helper script inside the container. */
  bridgePath: string;
  /** Stable session ID used for the IOPub stream subject. */
  sessionId: string;
  /** Called for every IOPub message — adapter republishes to NATS. */
  onIopub: (sessionId: string, ev: IOPubEvent) => void;
  /**
   * Idle cull threshold in ms. If >0, the bridge auto-shuts-down a kernel
   * that has been idle (no activity AND no in-flight cell) for this long.
   * Next executeCell re-spawns lazily. 0 disables culling.
   */
  cullIdleMs?: number;
  /** How often to check for idle cull, in ms. Defaults to 60000. */
  cullCheckIntervalMs?: number;
  /** Optional notifier when the kernel is culled. For logging/UI hooks. */
  onCulled?: (sessionId: string, reason: { idleMs: number; thresholdMs: number }) => void;
  /** Override spawn for tests. Defaults to node:child_process.spawn. */
  spawnFn?: SpawnFn;
}

/**
 * Pure cull decision — exported for testability. Returns true iff the kernel
 * is currently running, has no in-flight executes, and has been idle at
 * least `thresholdMs`. A thresholdMs <= 0 disables culling.
 */
export function shouldCull(snap: KernelSnapshot, thresholdMs: number): boolean {
  if (thresholdMs <= 0) return false;
  if (!snap.running) return false;
  if (snap.inFlight > 0) return false;
  return snap.idleMs >= thresholdMs;
}

export class KernelBridge {
  private proc: ChildProcess | null = null;
  private pendingReplies = new Map<
    string,
    { resolve: (r: ExecuteReply) => void; reject: (e: Error) => void }
  >();
  private lastExecuteCellId: string | null = null;
  private status_: KernelStatus = "unknown";
  private startedAt: number | null = null;
  private lastActivityAt: number | null = null;
  private inFlight = 0;
  private cullTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Per-cell-id stdout collectors. When `executeAndCollect` runs an
   * introspection snippet, it registers a buffer here so the iopub
   * handler appends stream-stdout text for that cell id. Used to
   * capture structured output (e.g. JSON from a list-vars snippet)
   * without parsing the full iopub stream.
   */
  private outputCollectors = new Map<string, string[]>();

  constructor(private deps: KernelDeps) {}

  get status(): KernelStatus {
    return this.status_;
  }

  get sessionId(): string {
    return this.deps.sessionId;
  }

  /**
   * Observability snapshot. `idleMs` reports 0 while any execute is in flight
   * so a running cell cannot be classified as idle by callers (e.g. a future
   * culler comparing idleMs against a threshold).
   */
  getSnapshot(): KernelSnapshot {
    const running = !!this.proc && !this.proc.killed && this.status_ !== "dead";
    const now = Date.now();
    const idleMs =
      this.inFlight > 0
        ? 0
        : this.lastActivityAt == null
          ? 0
          : Math.max(0, now - this.lastActivityAt);
    return {
      sessionId: this.deps.sessionId,
      status: this.status_,
      running,
      pid: this.proc?.pid ?? null,
      startedAt: this.startedAt,
      lastActivityAt: this.lastActivityAt,
      idleMs,
      inFlight: this.inFlight,
    };
  }

  private touch(): void {
    this.lastActivityAt = Date.now();
  }

  private ensureStarted(): void {
    if (this.proc && !this.proc.killed) return;
    console.log(`[kernel] spawning ${this.deps.bridgePath}`);
    const spawnFn = this.deps.spawnFn ?? realSpawn;
    this.proc = spawnFn("python3", ["-u", this.deps.bridgePath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    this.status_ = "starting";
    this.startedAt = Date.now();
    this.lastActivityAt = this.startedAt;
    // Do not reset inFlight here: exit / restart / shutdown reset it to 0 on
    // their own paths, and execute() increments inFlight *before* calling
    // write() → ensureStarted() on the first execute, so resetting here would
    // clobber a freshly-incremented counter.

    const stdout = this.proc.stdout!;
    const rl = createInterface({ input: stdout });
    rl.on("line", (line) => this.handleEvent(line));

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      console.error(`[kernel stderr]`, chunk.toString("utf8").trimEnd());
    });

    this.proc.on("exit", (code, sig) => {
      console.warn(`[kernel] bridge exited code=${code} sig=${sig}`);
      this.status_ = "dead";
      for (const pending of this.pendingReplies.values()) {
        pending.reject(new Error("kernel bridge died"));
      }
      this.pendingReplies.clear();
      this.inFlight = 0;
      this.proc = null;
      this.stopCullTimer();
    });

    this.startCullTimer();
  }

  private startCullTimer(): void {
    const idleMs = this.deps.cullIdleMs ?? 0;
    if (idleMs <= 0) return;
    if (this.cullTimer) return;
    const checkMs = Math.max(1000, this.deps.cullCheckIntervalMs ?? 60_000);
    this.cullTimer = setInterval(() => this.tickCull(), checkMs);
    // Don't block node's event loop from exiting while the timer is alive.
    this.cullTimer.unref?.();
  }

  private stopCullTimer(): void {
    if (this.cullTimer) {
      clearInterval(this.cullTimer);
      this.cullTimer = null;
    }
  }

  private tickCull(): void {
    const thresholdMs = this.deps.cullIdleMs ?? 0;
    const snap = this.getSnapshot();
    if (!shouldCull(snap, thresholdMs)) return;
    console.log(
      `[kernel] culling idle kernel session=${snap.sessionId} ` +
        `idleMs=${snap.idleMs} thresholdMs=${thresholdMs} pid=${snap.pid}`,
    );
    try {
      this.deps.onCulled?.(snap.sessionId, { idleMs: snap.idleMs, thresholdMs });
    } catch (e) {
      console.warn(`[kernel] onCulled callback threw:`, e);
    }
    this.shutdown();
  }

  private handleEvent(line: string): void {
    if (!line.trim()) return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      console.warn(`[kernel] unparseable line: ${line.slice(0, 200)}`);
      return;
    }
    const op = ev.op as string;
    if (op === "iopub") {
      const iopub: IOPubEvent = {
        msg_type: String(ev.msg_type ?? ""),
        content: (ev.content as Record<string, unknown>) ?? {},
        cell_id: (ev.cell_id as string | null) ?? null,
        parent_msg_id: (ev.parent_msg_id as string | null) ?? null,
      };
      this.touch();
      if (iopub.msg_type === "status") {
        const state = iopub.content.execution_state as string | undefined;
        if (state === "busy" || state === "idle") this.status_ = state;
      }
      // Per-cell stdout collector (for executeAndCollect callers)
      if (iopub.msg_type === "stream" && iopub.cell_id) {
        const c = iopub.content as { name?: string; text?: string };
        if (c.name === "stdout") {
          const buf = this.outputCollectors.get(iopub.cell_id);
          if (buf) buf.push(String(c.text ?? ""));
        }
      }
      this.deps.onIopub(this.deps.sessionId, iopub);
      return;
    }
    if (op === "execute_reply") {
      const cellId = String(ev.cell_id ?? "");
      const pending = this.pendingReplies.get(cellId);
      if (pending) {
        this.pendingReplies.delete(cellId);
        if (this.inFlight > 0) this.inFlight -= 1;
        this.touch();
        pending.resolve({
          status: (ev.status as string) ?? "ok",
          execution_count: (ev.execution_count as number | null) ?? null,
          error: (ev.error as string | null) ?? null,
        });
      }
      return;
    }
    if (op === "status") {
      const state = ev.state as KernelStatus;
      if (state) this.status_ = state;
      return;
    }
    if (op === "restarted") {
      this.status_ = "idle";
      return;
    }
    if (op === "interrupted") {
      return;
    }
    if (op === "error") {
      console.error(`[kernel] bridge error: ${String(ev.error).slice(0, 400)}`);
      return;
    }
  }

  private write(cmd: Record<string, unknown>): void {
    this.ensureStarted();
    this.proc!.stdin!.write(JSON.stringify(cmd) + "\n");
  }

  execute(cellId: string, code: string, kernelspec = "python3"): Promise<ExecuteReply> {
    this.lastExecuteCellId = cellId;
    return new Promise((resolve, reject) => {
      // Reject any prior pending reply for the same cell — shouldn't happen
      // in practice because the frontend tracks executingCells, but be safe.
      this.pendingReplies.set(cellId, { resolve, reject });
      this.inFlight += 1;
      this.touch();
      this.write({ op: "execute", cell_id: cellId, code, kernelspec });
    });
  }

  /**
   * Run `code` in the kernel and return BOTH the execute reply and the
   * collected stdout stream for that run. Used for introspection (e.g.
   * listing variables) where the caller wants structured output rather
   * than the full iopub stream.
   */
  async executeAndCollect(
    cellId: string,
    code: string,
    kernelspec = "python3",
  ): Promise<{ reply: ExecuteReply; stdout: string }> {
    const buf: string[] = [];
    this.outputCollectors.set(cellId, buf);
    try {
      const reply = await this.execute(cellId, code, kernelspec);
      return { reply, stdout: buf.join("") };
    } finally {
      this.outputCollectors.delete(cellId);
    }
  }

  interrupt(): void {
    if (!this.proc) return;
    this.write({ op: "interrupt" });
  }

  restart(): void {
    if (!this.proc) {
      this.ensureStarted();
      return;
    }
    // Python bridge clears its pending map on restart, so no execute_reply
    // will ever arrive for in-flight cells — fail their promises now to keep
    // inFlight and pendingReplies consistent.
    for (const pending of this.pendingReplies.values()) {
      pending.reject(new Error("kernel restarted"));
    }
    this.pendingReplies.clear();
    this.inFlight = 0;
    this.touch();
    this.write({ op: "restart" });
  }

  shutdown(): void {
    if (!this.proc) return;
    for (const pending of this.pendingReplies.values()) {
      pending.reject(new Error("kernel shutdown"));
    }
    this.pendingReplies.clear();
    this.inFlight = 0;
    this.stopCullTimer();
    try {
      this.write({ op: "shutdown" });
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (this.proc && !this.proc.killed) this.proc.kill("SIGTERM");
    }, 500);
  }
}

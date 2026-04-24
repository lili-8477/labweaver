// Tests for kernel idle-culling. Covers the pure `shouldCull` decision plus
// a timer-driven test that fakes spawn so we can verify end-to-end: a kernel
// started, left idle past the threshold, gets a "shutdown" command written to
// stdin and is marked not-running afterwards.

import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KernelBridge,
  shouldCull,
  type KernelSnapshot,
} from "../src/kernel.js";

function snap(overrides: Partial<KernelSnapshot> = {}): KernelSnapshot {
  return {
    sessionId: "k_test",
    status: "idle",
    running: true,
    pid: 123,
    startedAt: 0,
    lastActivityAt: 0,
    idleMs: 0,
    inFlight: 0,
    ...overrides,
  };
}

describe("shouldCull", () => {
  it("returns false when thresholdMs is 0 (disabled)", () => {
    expect(shouldCull(snap({ idleMs: 999_999 }), 0)).toBe(false);
    expect(shouldCull(snap({ idleMs: 999_999 }), -1)).toBe(false);
  });

  it("returns false when kernel is not running", () => {
    expect(shouldCull(snap({ running: false, idleMs: 10_000 }), 1_000)).toBe(false);
  });

  it("returns false when a cell is in flight — even if idleMs >= threshold", () => {
    // idleMs would never actually exceed threshold while inFlight>0 because
    // getSnapshot forces idleMs=0 in that case, but defend against callers
    // constructing the snapshot manually.
    expect(shouldCull(snap({ inFlight: 1, idleMs: 999_999 }), 1_000)).toBe(false);
  });

  it("returns false when idleMs is below threshold", () => {
    expect(shouldCull(snap({ idleMs: 500 }), 1_000)).toBe(false);
  });

  it("returns true when idle, running, no in-flight, and past threshold", () => {
    expect(shouldCull(snap({ idleMs: 1_000 }), 1_000)).toBe(true);
    expect(shouldCull(snap({ idleMs: 60_000 }), 1_000)).toBe(true);
  });
});

// ----- Timer-driven cull with a stubbed child process --------------------

/**
 * Build a fake ChildProcess that satisfies the subset of the API KernelBridge
 * actually touches: stdin.write, stdout (readable), stderr (readable), pid,
 * killed, kill(), and 'exit' event.
 */
function fakeSpawn(): {
  proc: ChildProcess;
  stdinWrites: string[];
  emitExit: (code: number | null, sig: NodeJS.Signals | null) => void;
} {
  const stdinWrites: string[] = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinWrites.push(chunk.toString("utf8"));
      cb();
    },
  });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter() as ChildProcess & { killed: boolean; pid: number };
  proc.stdin = stdin as unknown as ChildProcess["stdin"];
  proc.stdout = stdout as unknown as Readable;
  proc.stderr = stderr as unknown as Readable;
  proc.pid = 4242;
  proc.killed = false;
  proc.kill = (_sig?: NodeJS.Signals | number) => {
    proc.killed = true;
    return true;
  };
  return {
    proc,
    stdinWrites,
    emitExit: (code, sig) => proc.emit("exit", code, sig),
  };
}

describe("KernelBridge cull timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shuts the kernel down after idleMs >= cullIdleMs", async () => {
    const fake = fakeSpawn();

    const culled: Array<{ idleMs: number; thresholdMs: number }> = [];
    const bridge = new KernelBridge({
      bridgePath: "/dev/null",
      sessionId: "k_unit",
      onIopub: () => {},
      cullIdleMs: 2_000,
      cullCheckIntervalMs: 500,
      onCulled: (_s, r) => culled.push(r),
      spawnFn: () => fake.proc,
    });

    // Trigger spawn by issuing an execute — but don't let the promise hang
    // forever. We'll manually reject it when we shutdown the kernel below.
    const exec = bridge.execute("cell-1", "print('hi')");
    // Catch the rejection the shutdown will cause (kernel shutdown rejects pending).
    const execResult = exec.catch((e: Error) => e);

    // Simulate kernel going idle: the execute_reply arrives, inFlight -> 0.
    fake.proc.stdout!.push(
      JSON.stringify({ op: "execute_reply", cell_id: "cell-1", status: "ok" }) + "\n",
    );
    await vi.advanceTimersByTimeAsync(0); // let readline flush the line

    // Now the kernel is idle. Advance past threshold.
    let s = bridge.getSnapshot();
    expect(s.inFlight).toBe(0);
    expect(s.running).toBe(true);

    // Advance 2.5s so at least one cull tick sees idleMs >= 2000.
    await vi.advanceTimersByTimeAsync(2_500);

    // Cull should have fired: onCulled invoked, shutdown command written.
    expect(culled.length).toBe(1);
    expect(culled[0]!.thresholdMs).toBe(2_000);
    expect(culled[0]!.idleMs).toBeGreaterThanOrEqual(2_000);

    const shutdownWritten = fake.stdinWrites.some((w) =>
      w.includes('"op":"shutdown"'),
    );
    expect(shutdownWritten).toBe(true);

    // Simulate the Python side exiting in response.
    fake.emitExit(0, null);
    await vi.advanceTimersByTimeAsync(0);

    s = bridge.getSnapshot();
    expect(s.running).toBe(false);

    // Drain the pending promise rejection so the test doesn't leak.
    await execResult;
  });

  it("does NOT cull while a cell is in flight, even past the threshold", async () => {
    const fake = fakeSpawn();

    const culled: unknown[] = [];
    const bridge = new KernelBridge({
      bridgePath: "/dev/null",
      sessionId: "k_busy",
      onIopub: () => {},
      cullIdleMs: 1_000,
      cullCheckIntervalMs: 250,
      onCulled: () => culled.push({}),
      spawnFn: () => fake.proc,
    });

    // Kick off an execute and never reply — simulates a long-running cell.
    const exec = bridge.execute("cell-long", "train()");
    const execResult = exec.catch(() => undefined);

    // Let many cull ticks run while inFlight > 0.
    await vi.advanceTimersByTimeAsync(10_000);

    const s = bridge.getSnapshot();
    expect(s.inFlight).toBe(1);
    expect(s.idleMs).toBe(0); // the in-flight invariant holds
    expect(culled.length).toBe(0);

    // Cleanup: shutdown to release the pending promise.
    bridge.shutdown();
    fake.emitExit(0, null);
    await vi.advanceTimersByTimeAsync(0);
    await execResult;
  });

  it("disables culling when cullIdleMs is 0", async () => {
    const fake = fakeSpawn();

    const bridge = new KernelBridge({
      bridgePath: "/dev/null",
      sessionId: "k_nocull",
      onIopub: () => {},
      cullIdleMs: 0,
      cullCheckIntervalMs: 250,
      spawnFn: () => fake.proc,
    });

    const exec = bridge.execute("c", "1+1");
    const execResult = exec.catch(() => undefined);

    // Reply to clear inFlight.
    fake.proc.stdout!.push(
      JSON.stringify({ op: "execute_reply", cell_id: "c", status: "ok" }) + "\n",
    );
    await vi.advanceTimersByTimeAsync(0);

    // Long idle — still should not cull.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bridge.getSnapshot().running).toBe(true);

    bridge.shutdown();
    fake.emitExit(0, null);
    await vi.advanceTimersByTimeAsync(0);
    await execResult;
  });
});

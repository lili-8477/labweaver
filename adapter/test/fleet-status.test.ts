// Tests for fleet status: cgroup v2 parsing, the reporter → monitor round
// trip with online/offline staleness, and the manager-only RPC gate.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FleetMonitor, PING_SUBJECT, STALE_MS, STATUS_SUBJECT, StatusReporter, readUsage,
  type ContainerStatus,
} from "../src/fleet-status.js";
import { RpcRouter, type RpcDeps } from "../src/rpc.js";

/** An in-memory bus: publish delivers synchronously to subscribers. */
function fakeBus() {
  const subs = new Map<string, ((b: unknown) => void)[]>();
  const sent: { subject: string; body: Record<string, unknown> }[] = [];
  return {
    sent,
    publish: (subject: string, body: Record<string, unknown>) => {
      sent.push({ subject, body });
      for (const cb of subs.get(subject) ?? []) cb(body);
    },
    subscribe: (subject: string, cb: (b: unknown) => void) => {
      subs.set(subject, [...(subs.get(subject) ?? []), cb]);
    },
  };
}

/** A fake cgroup v2 dir with the three files readUsage looks at. */
function cgroup(memoryCurrent: string, memoryMax: string, cpuStat: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cg-"));
  writeFileSync(path.join(dir, "memory.current"), memoryCurrent);
  writeFileSync(path.join(dir, "memory.max"), memoryMax);
  writeFileSync(path.join(dir, "cpu.stat"), cpuStat);
  return dir;
}

const CPU_STAT = "usage_usec 123456\nuser_usec 100000\nsystem_usec 23456\nnr_periods 0\n";

describe("readUsage", () => {
  it("reads cgroup v2 memory and cpu, treating 'max' as no limit", async () => {
    expect(await readUsage(cgroup("1048576\n", "max\n", CPU_STAT))).toEqual({
      memoryBytes: 1048576, memoryLimitBytes: null, cpuUsageUsec: 123456,
    });
  });

  it("reads a numeric memory limit", async () => {
    expect((await readUsage(cgroup("1", "8589934592\n", CPU_STAT))).memoryLimitBytes).toBe(8589934592);
  });

  it("falls back to the process when there is no cgroup", async () => {
    const u = await readUsage("/nonexistent");
    expect(u.memoryBytes).toBeGreaterThan(0);
    expect(u.memoryLimitBytes).toBeNull();
    expect(u.cpuUsageUsec).toBeGreaterThan(0);
  });
});

describe("StatusReporter", () => {
  it("reports CPU % of one core from the delta between snapshots", async () => {
    const dir = cgroup("2048", "max", "usage_usec 0\n");
    const reporter = new StatusReporter({
      ...fakeBus(), username: "u", activity: () => ({ activeTurns: 0, kernels: 0 }), cgroupRoot: dir,
    });
    expect((await reporter.snapshot()).cpuPercent).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(path.join(dir, "cpu.stat"), "usage_usec 1000000\n"); // 1s of CPU
    expect((await reporter.snapshot()).cpuPercent).toBeGreaterThan(100);
  });

  it("sends only status fields — no env, paths or service IDs", async () => {
    const s = await new StatusReporter({
      ...fakeBus(), username: "u", activity: () => ({ activeTurns: 1, kernels: 2 }),
      cgroupRoot: cgroup("1", "max", CPU_STAT),
    }).snapshot();
    expect(Object.keys(s).sort()).toEqual([
      "activeTurns", "cpuPercent", "cpus", "kernels", "memoryBytes", "memoryLimitBytes",
      "reportedAt", "startedAt", "username",
    ]);
  });
});

describe("FleetMonitor", () => {
  it("pings, then lists reporters and silent roster users", async () => {
    const bus = fakeBus();
    const monitor = new FleetMonitor({ ...bus, roster: async () => ["ghost", "user1"], pingWaitMs: 0 });
    monitor.start();
    const reporter = new StatusReporter({
      ...bus, username: "user1",
      activity: () => ({ activeTurns: 2, kernels: 1 }),
      cgroupRoot: cgroup("2048", "4096", CPU_STAT),
    });
    reporter.start();
    reporter.stop();
    await new Promise((r) => setTimeout(r, 10)); // let the first report land

    const list = await monitor.list();
    expect(bus.sent.some((m) => m.subject === PING_SUBJECT)).toBe(true);
    expect(list.map((e) => [e.username, e.online])).toEqual([["ghost", false], ["user1", true]]);
    expect(list[0]!.status).toBeNull();
    expect(list[1]!.status).toMatchObject({
      username: "user1", memoryBytes: 2048, memoryLimitBytes: 4096, activeTurns: 2, kernels: 1,
    });
  });

  it("marks a container offline after three missed reports", async () => {
    const bus = fakeBus();
    const monitor = new FleetMonitor({ ...bus, roster: async () => [], pingWaitMs: 0 });
    monitor.start();
    bus.publish(STATUS_SUBJECT, { username: "u", reportedAt: 1000 } as Partial<ContainerStatus>);
    expect(STALE_MS).toBe(45_000);
    expect((await monitor.list(() => 1000 + STALE_MS - 1))[0]!.online).toBe(true);
    expect((await monitor.list(() => 1000 + STALE_MS))[0]!.online).toBe(false);
  });

  it("ignores malformed reports and survives a failing roster", async () => {
    const bus = fakeBus();
    const monitor = new FleetMonitor({ ...bus, roster: async () => { throw new Error("pg down"); }, pingWaitMs: 0 });
    monitor.record(null);
    monitor.record({ username: 5 });
    monitor.record({ username: "u" });
    expect(await monitor.list()).toEqual([]);
  });
});

describe("fleet RPCs", () => {
  function makeRouter(fleet: FleetMonitor | null): RpcRouter {
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
      memory: null,
      share: null,
      fleet,
    };
    return new RpcRouter(deps);
  }

  it("refuses fleet_status outside the manager container", async () => {
    const router = makeRouter(null);
    expect(await router.dispatch("get_role", {})).toEqual({ success: true, manager: false });
    await expect(router.dispatch("fleet_status", {})).rejects.toThrow(/not authorized/);
  });

  it("answers fleet_status in the manager container", async () => {
    const bus = fakeBus();
    const fleet = new FleetMonitor({ ...bus, roster: async () => ["alice"], pingWaitMs: 0 });
    const router = makeRouter(fleet);
    expect(await router.dispatch("get_role", {})).toEqual({ success: true, manager: true });
    expect(await router.dispatch("fleet_status", {})).toEqual({
      success: true, containers: [{ username: "alice", online: false, status: null }],
    });
  });

  it("reports no activity on a fresh router", () => {
    expect(makeRouter(null).activity()).toEqual({ activeTurns: 0, kernels: 0 });
  });
});

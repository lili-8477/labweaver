// Fleet status: every adapter reports its container's health on NATS, and the
// manager container (LABWEAVER_ROLE=manager) collects the reports for the
// Manager panel. NATS has no subject authorization here, so reports carry no
// secrets — just the username, uptime, resource use and activity counts.
//
// Subjects (NATS_SUBJECT_PREFIX is applied by the bus, like the others):
//   pantheon.fleet.status  — one ContainerStatus per report (every 15s)
//   pantheon.fleet.ping    — asks every adapter to report now
//
// No Docker socket is involved: a container that stops reporting is shown as
// offline once its last report goes stale.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const STATUS_SUBJECT = "pantheon.fleet.status";
export const PING_SUBJECT = "pantheon.fleet.ping";
export const REPORT_EVERY_MS = 15_000;
/** Missed three reports → offline. */
export const STALE_MS = 3 * REPORT_EVERY_MS;
const PING_WAIT_MS = 750;

export interface ContainerStatus {
  username: string;
  startedAt: number;
  reportedAt: number;
  memoryBytes: number;
  memoryLimitBytes: number | null;
  /** Percent of one core since the previous report; null on the first. */
  cpuPercent: number | null;
  cpus: number;
  activeTurns: number;
  kernels: number;
}

export interface FleetEntry {
  username: string;
  online: boolean;
  status: ContainerStatus | null;
}

export interface Activity {
  activeTurns: number;
  kernels: number;
}

export type Publish = (subject: string, body: Record<string, unknown>) => void;
export type Subscribe = (subject: string, onMessage: (body: unknown) => void) => void;

/** Container memory and CPU from cgroup v2, falling back to this process. */
export async function readUsage(cgroupRoot = "/sys/fs/cgroup"): Promise<{
  memoryBytes: number; memoryLimitBytes: number | null; cpuUsageUsec: number;
}> {
  const read = (f: string) => fs.readFile(path.join(cgroupRoot, f), "utf8").then((s) => s.trim(), () => null);
  const [current, max, cpuStat] = await Promise.all([read("memory.current"), read("memory.max"), read("cpu.stat")]);
  const usage = cpuStat?.match(/^usage_usec (\d+)/m);
  const proc = process.cpuUsage();
  return {
    memoryBytes: current ? Number(current) : process.memoryUsage().rss,
    memoryLimitBytes: max && max !== "max" ? Number(max) : null,
    cpuUsageUsec: usage ? Number(usage[1]) : proc.user + proc.system,
  };
}

/** Publishes this container's status on a timer and whenever pinged. */
export class StatusReporter {
  private readonly startedAt = Date.now();
  private last: { usageUsec: number; at: number } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private opts: {
    username: string;
    publish: Publish;
    subscribe: Subscribe;
    activity: () => Activity;
    cgroupRoot?: string;
  }) {}

  start(): void {
    this.opts.subscribe(PING_SUBJECT, () => void this.report());
    this.timer = setInterval(() => void this.report(), REPORT_EVERY_MS);
    this.timer.unref();
    void this.report();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async snapshot(): Promise<ContainerStatus> {
    const usage = await readUsage(this.opts.cgroupRoot);
    const now = Date.now();
    const prev = this.last;
    this.last = { usageUsec: usage.cpuUsageUsec, at: now };
    const cpuPercent = prev && now > prev.at
      ? Math.max(0, ((usage.cpuUsageUsec - prev.usageUsec) / ((now - prev.at) * 1000)) * 100)
      : null;
    return {
      username: this.opts.username,
      startedAt: this.startedAt,
      reportedAt: now,
      memoryBytes: usage.memoryBytes,
      memoryLimitBytes: usage.memoryLimitBytes,
      cpuPercent: cpuPercent === null ? null : Math.round(cpuPercent * 10) / 10,
      cpus: os.cpus().length,
      ...this.opts.activity(),
    };
  }

  private async report(): Promise<void> {
    try {
      this.opts.publish(STATUS_SUBJECT, { ...(await this.snapshot()) });
    } catch (e) {
      console.warn(`[fleet] status report failed: ${(e as Error).message}`);
    }
  }
}

/** Manager side: the latest report per user, plus users known but silent. */
export class FleetMonitor {
  private latest = new Map<string, ContainerStatus>();

  constructor(private opts: {
    publish: Publish;
    subscribe: Subscribe;
    /** Usernames expected to have a container (everyone with chats). */
    roster: () => Promise<string[]>;
    pingWaitMs?: number;
  }) {}

  start(): void {
    this.opts.subscribe(STATUS_SUBJECT, (body) => this.record(body));
  }

  record(body: unknown): void {
    const s = body as Partial<ContainerStatus> | null;
    if (!s || typeof s.username !== "string" || typeof s.reportedAt !== "number") return;
    this.latest.set(s.username, s as ContainerStatus);
  }

  /** Ping every adapter, give them a moment to answer, then list. */
  async list(now: () => number = Date.now): Promise<FleetEntry[]> {
    this.opts.publish(PING_SUBJECT, {});
    await new Promise((r) => setTimeout(r, this.opts.pingWaitMs ?? PING_WAIT_MS));
    const roster = await this.opts.roster().catch(() => [] as string[]);
    const names = new Set([...roster, ...this.latest.keys()]);
    const t = now();
    return [...names].sort().map((username) => {
      const status = this.latest.get(username) ?? null;
      return { username, online: !!status && t - status.reportedAt < STALE_MS, status };
    });
  }
}

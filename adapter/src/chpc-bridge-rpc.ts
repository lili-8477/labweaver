// chpc_bridge_* RPCs — manage the multiplexed SSH master to CHPC.
//
// The agent inside this container reaches CHPC by reusing a master socket
// that lives at ~/.ssh/cm-<user>@<host>:<port>. Opening that master is
// the one step we cannot do from Claude (it needs CHPC password + Duo);
// this service exposes it to the frontend so the user can authenticate
// from the UI instead of dropping to a host TTY.
//
// Subjects:
//   chpc_bridge_status  (RPC, req/reply)
//   chpc_bridge_open    (RPC, returns { accepted }; events stream via publishEvent)
//   chpc_bridge_close   (RPC)
//
// Stream:
//   pantheon.stream.chpc_bridge_events  — OpenEvent frames keyed by requestId.

import { exec, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

// node-pty is loaded lazily so the rest of the adapter still boots when
// the binary module is missing (e.g. fresh container before npm install).
// We only need it when open() is actually called.
type IPty = {
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void;
  write: (data: string) => void;
  kill: (signal?: string) => void;
  pid: number;
};
type PtySpawn = (
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; cols?: number; rows?: number },
) => IPty;

let cachedPtySpawn: PtySpawn | null = null;
async function loadPtySpawn(): Promise<PtySpawn> {
  if (cachedPtySpawn) return cachedPtySpawn;
  const mod = await import("node-pty");
  cachedPtySpawn = (mod as unknown as { spawn: PtySpawn }).spawn;
  return cachedPtySpawn;
}

const execAsync = promisify(exec);

export const HOST_ALIAS = "chpc-login";

export type BridgeStatus =
  | { kind: "up"; pid: number; openedAt: string; user: string }
  | { kind: "down" }
  | { kind: "unprovisioned"; reason: "no-ssh" | "no-config" };

export interface OpenRequest {
  password: string;
  duo: { kind: "push" } | { kind: "passcode"; code: string };
  requestId: string;
}

export type OpenEvent =
  | { requestId: string; phase: "spawned" }
  | { requestId: string; phase: "password-accepted" }
  | { requestId: string; phase: "duo-waiting" }
  | { requestId: string; phase: "up"; pid: number }
  | {
      requestId: string;
      phase: "error";
      code: "bad-password" | "duo-denied" | "duo-timeout" | "network" | "config" | "unknown";
      message: string;
    };

interface ConfigInfo {
  user: string | null;        // User from ~/.ssh/config Host chpc-login
  host: string | null;        // HostName
}

export class ChpcBridge {
  private currentRequestId: string | null = null;
  private openedAt: string | null = null;

  /** publishEvent is wired by index.ts to NATS stream publish. */
  constructor(
    private home: string,
    private publishEvent: (e: OpenEvent) => void,
  ) {}

  async status(): Promise<BridgeStatus> {
    // 1. ssh binary present?
    try {
      await execAsync("command -v ssh");
    } catch {
      return { kind: "unprovisioned", reason: "no-ssh" };
    }
    // 2. ~/.ssh/config has Host chpc-login?
    const cfg = await this.readConfig();
    if (!cfg.host || !cfg.user) {
      return { kind: "unprovisioned", reason: "no-config" };
    }
    // 3. ssh -O check returns 0 and prints "Master running (pid=N)"
    try {
      const { stdout, stderr } = await execAsync(`ssh -O check ${HOST_ALIAS}`, {
        env: { ...process.env, HOME: this.home },
      });
      const out = stdout + stderr;
      const m = out.match(/pid=(\d+)/);
      if (!m || !m[1]) return { kind: "down" };
      return {
        kind: "up",
        pid: Number(m[1]),
        openedAt: this.openedAt ?? new Date().toISOString(),
        user: cfg.user,
      };
    } catch {
      return { kind: "down" };
    }
  }

  async open(req: OpenRequest): Promise<{ accepted: true }> {
    if (this.currentRequestId) {
      throw new Error("open already in progress");
    }
    const cfg = await this.readConfig();
    if (!cfg.host || !cfg.user) {
      throw new Error("ssh config missing — provision ~/.ssh/config first");
    }
    // Already up? Surface immediately as a synthetic "up" frame so the
    // frontend doesn't get stuck waiting for a phase that won't fire.
    const cur = await this.status();
    if (cur.kind === "up") {
      this.publishEvent({ requestId: req.requestId, phase: "up", pid: cur.pid });
      return { accepted: true };
    }

    this.currentRequestId = req.requestId;

    let spawn: PtySpawn;
    try {
      spawn = await loadPtySpawn();
    } catch (e) {
      this.fail(req.requestId, "config", `node-pty not installed: ${(e as Error).message}`);
      return { accepted: true };
    }

    // Spawn ssh -NMf chpc-login under a PTY so password + Duo prompts behave.
    // -f forces backgrounding *after* auth completes, so the pty child exits
    // cleanly when the master is established.
    const pty = spawn("ssh", ["-NMf", HOST_ALIAS], {
      cwd: this.home,
      env: { ...process.env, HOME: this.home, TERM: "dumb" },
      cols: 120,
      rows: 24,
    });

    this.publishEvent({ requestId: req.requestId, phase: "spawned" });

    // State machine over the streamed pty output. We don't keep the whole
    // buffer — just enough to detect prompts. Capture the password and
    // duo response in local closure refs so we can zero them on exit.
    let password: string | null = req.password;
    const duo = req.duo;
    let stage: "await-password" | "await-duo" | "auth-ok" | "done" = "await-password";
    let scratch = "";

    pty.onData((chunk) => {
      scratch += chunk;
      // Cap buffer; never need more than the last ~2KB to match prompts.
      if (scratch.length > 4096) scratch = scratch.slice(-2048);

      if (stage === "await-password" && /password:\s*$/i.test(scratch)) {
        if (password) {
          pty.write(password + "\r");
          password = null;
          stage = "await-duo";
          scratch = "";
          this.publishEvent({ requestId: req.requestId, phase: "password-accepted" });
        }
        return;
      }

      if (stage === "await-duo") {
        // Duo's classic prompt: "Passcode or option (1-N): "
        if (/passcode or option/i.test(scratch) || /enter a passcode/i.test(scratch)) {
          const response = duo.kind === "push" ? "1" : duo.code;
          pty.write(response + "\r");
          stage = "auth-ok";
          scratch = "";
          this.publishEvent({ requestId: req.requestId, phase: "duo-waiting" });
          return;
        }
        // Some configs send password prompt twice on failure.
        if (/password:\s*$/i.test(scratch)) {
          this.fail(req.requestId, "bad-password", "CHPC rejected the password");
          pty.kill();
          stage = "done";
          return;
        }
      }

      if (/permission denied/i.test(scratch)) {
        this.fail(req.requestId, "bad-password", "Permission denied by remote");
        pty.kill();
        stage = "done";
        return;
      }
      if (/connection (refused|reset|timed out)/i.test(scratch) || /could not resolve hostname/i.test(scratch)) {
        this.fail(req.requestId, "network", scratch.trim().slice(-200));
        pty.kill();
        stage = "done";
        return;
      }
    });

    // Safety timeout — Duo push approval can take a while; cap at 90s.
    const timeout = setTimeout(() => {
      if (stage !== "done") {
        this.fail(req.requestId, "duo-timeout", "Timed out waiting for Duo / master to come up");
        pty.kill();
        stage = "done";
      }
    }, 90_000);

    pty.onExit(async ({ exitCode }) => {
      clearTimeout(timeout);
      // Zero the password reference (best-effort; V8 may still hold a copy).
      password = null;
      req.password = "";
      if (stage === "done") {
        this.currentRequestId = null;
        return;
      }
      // Successful exit means ssh forked to background after auth.
      // Confirm via `ssh -O check`.
      try {
        await new Promise((r) => setTimeout(r, 250));
        const st = await this.status();
        if (st.kind === "up") {
          this.openedAt = new Date().toISOString();
          this.publishEvent({ requestId: req.requestId, phase: "up", pid: st.pid });
        } else {
          this.fail(
            req.requestId,
            exitCode === 0 ? "unknown" : "unknown",
            `ssh exited ${exitCode} but master not running`,
          );
        }
      } finally {
        this.currentRequestId = null;
      }
    });

    return { accepted: true };
  }

  async close(): Promise<{ ok: true; wasRunning: boolean }> {
    const before = await this.status();
    if (before.kind !== "up") return { ok: true, wasRunning: false };
    try {
      await execAsync(`ssh -O exit ${HOST_ALIAS}`, {
        env: { ...process.env, HOME: this.home },
      });
    } catch {
      // -O exit prints an error code if the master is already gone; we
      // don't care.
    }
    this.openedAt = null;
    return { ok: true, wasRunning: true };
  }

  private fail(requestId: string, code: Extract<OpenEvent, { phase: "error" }>["code"], message: string): void {
    this.publishEvent({ requestId, phase: "error", code, message });
  }

  private async readConfig(): Promise<ConfigInfo> {
    const cfgPath = path.join(this.home, ".ssh", "config");
    let raw: string;
    try {
      raw = await fs.readFile(cfgPath, "utf8");
    } catch {
      return { user: null, host: null };
    }
    // Tiny parser: find the `Host chpc-login` stanza and pull User/HostName.
    const lines = raw.split(/\r?\n/);
    let inStanza = false;
    let user: string | null = null;
    let host: string | null = null;
    for (const line of lines) {
      const m = /^\s*Host\s+(.+?)\s*$/i.exec(line);
      if (m) {
        const aliases = (m[1] ?? "").split(/\s+/);
        inStanza = aliases.includes(HOST_ALIAS);
        continue;
      }
      if (!inStanza) continue;
      const u = /^\s*User\s+(\S+)/i.exec(line);
      if (u) user = u[1] ?? null;
      const h = /^\s*HostName\s+(\S+)/i.exec(line);
      if (h) host = h[1] ?? null;
    }
    return { user, host };
  }
}

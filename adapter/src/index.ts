#!/usr/bin/env node
// Adapter entrypoint. Per-user devcontainer runs one of these.
//
// Env:
//   NATS_SERVERS      e.g. "nats://pantheon-nats:4222"
//   ID_HASH           short hash (12 hex); service_id = sha256(ID_HASH) full hex
//   NATS_USER         optional auth user (defaults to "agent")
//   NATS_PASS         optional auth token
//   WORKSPACE_ROOT    default "/workspace"
//   DEFAULT_PROJECT   default "/workspace" (cwd for Claude Code turns)
//   HOME              default "/home/node"
//   PG_URL            REQUIRED (Phase 2) — postgres connection string
//   USERNAME          REQUIRED (Phase 2) — tenant key for all chat queries
//   KERNEL_IDLE_CULL_MS           default 0 (disabled); when >0, cull a kernel
//                                 idle for this many ms (no in-flight executes)
//   KERNEL_CULL_CHECK_INTERVAL_MS default 60000; how often to check
//   LABWEAVER_ROLE    "manager" collects every container's status for the
//                     Manager panel (fleet_status RPC); default unset

import { createHash } from "node:crypto";
import { Pool } from "pg";
import { ChatsRepo } from "./chats-repo.js";
import { loadDbConfig } from "./db-config.js";
import { FleetMonitor, StatusReporter, type Publish, type Subscribe } from "./fleet-status.js";
import { MemoryForwarder } from "./memory-rpc.js";
import { NatsBus } from "./nats-bus.js";
import { ShareRpcClient } from "./share-rpc.js";
import { RpcRouter, type RpcDeps } from "./rpc.js";
import { importSidecar } from "./sidecar-import.js";
import { startUploadServer } from "./upload-http.js";

function computeServiceId(idHash: string): string {
  return createHash("sha256").update(idHash).digest("hex");
}

async function main(): Promise<void> {
  const idHash = requireEnv("ID_HASH");
  const serviceId = computeServiceId(idHash);
  // The agent and its hooks and MCP servers inherit this process's env: the
  // memory hooks and mcp-memory send it to the hub as a Bearer token (caller-check.ts).
  process.env.SERVICE_ID = serviceId;
  const servers = process.env.NATS_SERVERS ?? "nats://localhost:4222";
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? "/workspace";
  const defaultProjectCwd = process.env.DEFAULT_PROJECT ?? workspaceRoot;
  const home = process.env.HOME ?? "/home/node";

  const bus = new NatsBus({
    servers,
    serviceId,
    user: process.env.NATS_USER ?? "agent",
    pass: process.env.NATS_PASS,
    subjectPrefix: process.env.NATS_SUBJECT_PREFIX,
  });

  const dbCfg = loadDbConfig();
  if (!dbCfg.enabled) {
    console.error("[adapter] PG_URL is required in Phase 2. Refusing to boot.");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: dbCfg.pgUrl, max: 10 });
  await waitForPg(pool, 60);
  console.log(`[adapter] connected to PG as user=${dbCfg.username}`);

  // Best-effort one-shot import of legacy sidecar files. Runs in the
  // background; a subsequent boot is a no-op once the sentinel is written.
  importSidecar({ pool, username: dbCfg.username, workspaceRoot })
    .then((r) => console.log(`[adapter] sidecar import: imported=${r.imported} skipped=${r.skipped}`))
    .catch((err) => console.warn("[adapter] sidecar import failed:", err));

  const chatsRepo = new ChatsRepo(pool, dbCfg.username);

  const memoryApiUrl = process.env.MEMORY_API_URL;
  const memoryClient = memoryApiUrl
    ? new MemoryForwarder({ baseUrl: memoryApiUrl, user: dbCfg.username, token: serviceId })
    : null;
  if (!memoryClient) {
    console.warn("[adapter] MEMORY_API_URL not set — memory_* RPCs will be unavailable");
  }

  const shareClient = memoryApiUrl
    ? new ShareRpcClient(memoryApiUrl, dbCfg.username, serviceId)
    : null;
  if (!shareClient) {
    console.warn("[adapter] MEMORY_API_URL not set — share_* RPCs will be unavailable");
  }

  await bus.connect();
  console.log(`[adapter] connected to NATS ${servers}, service_id=${serviceId.slice(0, 12)}...`);

  const publish: Publish = (subject, body) => bus.publishRaw(bus.qualify(subject), body);
  const subscribe: Subscribe = (subject, onMessage) => bus.subscribeJson(bus.qualify(subject), onMessage);
  // Everyone with chats is expected to have a container, so a silent one
  // still shows up (as offline) after the manager restarts.
  const fleet = process.env.LABWEAVER_ROLE === "manager"
    ? new FleetMonitor({
        publish,
        subscribe,
        roster: async () =>
          (await pool.query<{ username: string }>("SELECT DISTINCT username FROM chats")).rows.map((r) => r.username),
      })
    : null;
  fleet?.start();
  if (fleet) console.log("[adapter] manager container: collecting fleet status");

  const router = new RpcRouter({
    serviceId,
    workspaceRoot,
    chats: chatsRepo,
    home,
    defaultProjectCwd,
    publishStream: (streamId, ev) => bus.publishStream(streamId, ev),
    publishRaw: (subject, envelope) => bus.publishRaw(subject, envelope),
    streamSubject: (streamId) => bus.subjectFor(streamId),
    kernelBridgePath: process.env.KERNEL_BRIDGE_PATH ?? "/opt/adapter/kernel-bridge.py",
    memoryBuilder: ["python3", process.env.MEMORY_BUILDER_PATH ?? "/opt/adapter/memory-builder.py"],
    kernelIdleCullMs: parsePositiveInt(process.env.KERNEL_IDLE_CULL_MS, 0),
    kernelCullCheckIntervalMs: parsePositiveInt(
      process.env.KERNEL_CULL_CHECK_INTERVAL_MS,
      60_000,
    ),
    memory: memoryClient,
    share: shareClient,
    fleet,
  });

  new StatusReporter({
    username: dbCfg.username,
    publish,
    subscribe,
    activity: () => router.activity(),
  }).start();

  await bus.serve((method, params) => router.dispatch(method, params));
  console.log("[adapter] serving RPCs");

  // HTTP upload server. Listens on UPLOAD_PORT (default 5000) inside the
  // container; nginx proxies authenticated /upload/* requests here. If the
  // port is in use, log and continue — NATS RPC stays available.
  const uploadPort = parsePositiveInt(process.env.UPLOAD_PORT, 5000);
  let uploadServer: ReturnType<typeof startUploadServer> | undefined;
  try {
    uploadServer = startUploadServer({
      workspaceRoot,
      port:         uploadPort,
      username:     dbCfg.username,
      memoryApiUrl,
      serviceId,
    });
  } catch (err) {
    console.warn(`[upload] failed to start on :${uploadPort}:`, err);
  }

  const shutdown = async (sig: string) => {
    console.log(`[adapter] ${sig} received, shutting down`);
    router.abortAll();
    await new Promise((r) => setTimeout(r, 500)); // let aborts flush
    await new Promise<void>((r) => {
      if (!uploadServer) return r();
      uploadServer.close(() => r());
    });
    await bus.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[adapter] missing required env ${name}`);
    process.exit(2);
  }
  return v;
}

function parsePositiveInt(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function waitForPg(pool: Pool, maxSec: number): Promise<void> {
  const deadline = Date.now() + maxSec * 1000;
  let delay = 500;
  while (Date.now() < deadline) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      console.warn(`[adapter] waiting for PG: ${(err as Error).message} (retry in ${delay}ms)`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 10_000);
    }
  }
  throw new Error(`PG unreachable after ${maxSec}s`);
}

main().catch((err) => {
  console.error("[adapter] fatal:", err);
  process.exit(1);
});

import pino from "pino";
import { ACCESS_ORDER, type AccessClass } from "./access-classes.js";

export const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

export interface Config {
  pgUrl: string;
  workspacesRoot: string;
  maxConcurrentFiles: number;
  maxPassBytes: number;
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  migrationLockKey: bigint;
  pgStartupMaxWaitSec: number;
  embedderUrl:          string;
  embedderBatchSize:    number;
  embedderIntervalMs:   number;
  memoryApiPort:        number;
  memoryOrgManagers:    string[];
  memoryMergeSimilarity:        number;
  // Per-user access clearance for memory reads (MEMORY_CLEARANCE, e.g.
  // "alice=irb,bob=restricted"); users not listed read up to 'internal'.
  memoryClearance:              Record<string, AccessClass>;
  shareSnapshotsDir:          string;
  shareMaxFolderBytes:        number;
  shareSnapshotTtlDays:       number;
  shareCleanupIntervalHours:  number;
  shareAutoCloseIdleDays:       number;
  shareAutoCloseIntervalHours:  number;
  recordingsRoot:     string;
  // Where the read-only markdown copy of memory is written (memory-mirror.ts); null turns it off.
  memoryMirrorRoot:     string | null;
  glassesMaxChunkBytes: number;
  glassesMuxIntervalMs: number;
  glassesProxySecret:   string;
  ffmpegBin:            string;
  ffprobeBin:           string;
  // service-map.conf: which service ID is whose (caller-check.ts). Required.
  callerMapFile:        string;
}

function parseIntVar(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${name} must be an integer; got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseBigintVar(env: Record<string, string | undefined>, name: string, fallback: bigint): bigint {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  try {
    return BigInt(raw);
  } catch {
    throw new Error(`${name} must be a valid bigint literal; got ${JSON.stringify(raw)}`);
  }
}

function parseUnitVar(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    throw new Error(`${name} must be a number in (0, 1]; got ${JSON.stringify(raw)}`);
  }
  return n;
}

const isAccessClass = (v: string): v is AccessClass => (ACCESS_ORDER as readonly string[]).includes(v);

function parseClearance(raw: string): Record<string, AccessClass> {
  const out: Record<string, AccessClass> = {};
  for (const pair of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [user, level] = pair.split("=").map((s) => s.trim());
    if (!user || !level || !isAccessClass(level)) {
      throw new Error(`MEMORY_CLEARANCE entries must be user=${ACCESS_ORDER.join("|")}; got ${JSON.stringify(pair)}`);
    }
    out[user] = level;
  }
  return out;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const pgUrl = env.PG_URL;
  if (!pgUrl) throw new Error("PG_URL is required");
  const logLevel = (env.LOG_LEVEL ?? "info") as Config["logLevel"];
  const memoryOrgManagers = (env.MEMORY_ORG_MANAGER ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(s => s.length > 0);
  const shareSnapshotsDir = env.SHARE_SNAPSHOTS_DIR && env.SHARE_SNAPSHOTS_DIR.length > 0
    ? env.SHARE_SNAPSHOTS_DIR
    : `${env.WORKSPACES_ROOT ?? "/workspaces"}/shared/.share-snapshots`;
  const shareMaxFolderBytes       = parseIntVar(env, "SHARE_MAX_FOLDER_BYTES",        100 * 1024 * 1024);
  const shareSnapshotTtlDays      = parseIntVar(env, "SHARE_SNAPSHOT_TTL_DAYS",      30);
  const shareCleanupIntervalHours = parseIntVar(env, "SHARE_CLEANUP_INTERVAL_HOURS", 24);
  const shareAutoCloseIdleDays      = parseIntVar(env, "SHARE_AUTO_CLOSE_IDLE_DAYS",      30);
  const shareAutoCloseIntervalHours = parseIntVar(env, "SHARE_AUTO_CLOSE_INTERVAL_HOURS", 24);
  return {
    pgUrl,
    workspacesRoot: env.WORKSPACES_ROOT ?? "/workspaces",
    maxConcurrentFiles: parseIntVar(env, "MAX_CONCURRENT_FILES", 8),
    maxPassBytes: parseIntVar(env, "MAX_PASS_BYTES", 8 * 1024 * 1024),
    logLevel,
    migrationLockKey: parseBigintVar(env, "MIGRATION_LOCK_KEY", 0x62696f666c77n),
    pgStartupMaxWaitSec: parseIntVar(env, "PG_STARTUP_MAX_WAIT_SEC", 300),
    embedderUrl:          env.EMBEDDER_URL  ?? "http://embedder:8000",
    embedderBatchSize:    parseIntVar(env, "EMBEDDER_BATCH_SIZE",      64),
    embedderIntervalMs:   parseIntVar(env, "EMBEDDER_INTERVAL_MS",   5000),
    memoryApiPort:        parseIntVar(env, "MEMORY_API_PORT",         8400),
    memoryOrgManagers,
    memoryMergeSimilarity:        parseUnitVar(env, "MEMORY_MERGE_SIMILARITY",         0.9),
    memoryClearance:              parseClearance(env.MEMORY_CLEARANCE ?? ""),
    shareSnapshotsDir,
    shareMaxFolderBytes,
    shareSnapshotTtlDays,
    shareCleanupIntervalHours,
    shareAutoCloseIdleDays,
    shareAutoCloseIntervalHours,
    recordingsRoot:       env.RECORDINGS_ROOT ?? "/recordings",
    memoryMirrorRoot:     env.MEMORY_MIRROR_ROOT || null,
    glassesMaxChunkBytes: parseIntVar(env, "GLASSES_MAX_CHUNK_BYTES", 64 * 1024 * 1024),
    glassesMuxIntervalMs: parseIntVar(env, "GLASSES_MUX_INTERVAL_MS", 10_000),
    glassesProxySecret:   env.GLASSES_PROXY_SECRET ?? "",
    ffmpegBin:            env.FFMPEG_BIN  ?? "ffmpeg",
    ffprobeBin:           env.FFPROBE_BIN ?? "ffprobe",
    callerMapFile:        env.CALLER_MAP_FILE ?? "",
  };
}

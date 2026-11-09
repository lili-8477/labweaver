import { Pool } from "pg";
import pino from "pino";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { runMigrations } from "./migrate.js";
import { startWatcher } from "./watcher.js";
import { runEmbedderOnce } from "./embedder-worker.js";
import { embedTexts } from "./embedder-client.js";
import { buildApp } from "./memory-api.js";
import {
  searchMemories,
  getMemory,
  timelineMemories,
  writeUserMemory,
  forgetMemory,
  getContext,
  updateMemory,
  restoreMemory,
  listMemories,
  getAuditTrail,
  getMetrics,
  listDirs,
  getDir,
  memoryTree,
  recordFeedback,
  recordUse,
  usedSince,
} from "./memory-repo.js";
import { memoryGraph } from "./memory-graph.js";
import { writeDistillation } from "./distiller-repo.js";
import { importEntries } from "./memory-import.js";
import { createBuildJob, listBuildJobs, updateBuildJob } from "./memory-build-jobs.js";
import { proposeExperiences } from "./experience-promotion.js";
import { linkMemories } from "./lineage-repo.js";
import { buildBundle } from "./context-bundle.js";
import { consolidate } from "./consolidate.js";
import { checkCallers } from "./caller-check.js";
import { shareRoutesPlugin } from "./share-api.js";
import { glassesRoutesPlugin } from "./glasses-api.js";
import { execRunner, runMuxOnce } from "./glasses-mux.js";
import { cleanupOldSnapshots, autoCloseIdleRequests } from "./share-cleanup.js";
import {
  submitShareRequest,
  listShareRequests,
  getShareRequest,
  decideShareRequest,
  withdrawShareRequest,
  getShareCapabilities,
} from "./share-repo.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = pino({ level: cfg.logLevel });

  await mkdir(cfg.shareSnapshotsDir, { recursive: true });
  logger.info({ dir: cfg.shareSnapshotsDir }, "share snapshots dir ready");
  await mkdir(cfg.recordingsRoot, { recursive: true });

  const pool = new Pool({ connectionString: cfg.pgUrl, max: Math.max(10, cfg.maxConcurrentFiles * 2) });

  await waitForPg(pool, cfg.pgStartupMaxWaitSec, logger);

  await runMigrations({
    pool,
    migrationsDir: path.resolve(HERE, "..", "migrations"),
    lockKey: cfg.migrationLockKey,
  });
  logger.info({ workspacesRoot: cfg.workspacesRoot }, "migrations applied — starting watcher");

  if (!cfg.callerMapFile) throw new Error("CALLER_MAP_FILE is required (hub/service-map.conf, mounted read-only)");

  const handle = startWatcher({
    pool,
    watchRoot: cfg.workspacesRoot,
    maxConcurrentFiles: cfg.maxConcurrentFiles,
    maxPassBytes: cfg.maxPassBytes,
    logger,
  });

  // Auto-distill loop removed: was generating low-signal session_summary +
  // observation rows on every settled session, polluting recall. Replaced by
  // agent-on-demand distill via the /memory slash command → bioflow-memory
  // memory_distill_session MCP tool → POST /memory/distill. Distillation
  // helpers (writeDistillation, distiller.ts, llm-client.ts) are kept in
  // place because tests and the new endpoint still use writeDistillation.

  const startEmbedderLoop = (): void => {
    const tick = async (): Promise<void> => {
      try {
        const summary = await runEmbedderOnce(pool, {
          embedderUrl: cfg.embedderUrl,
          batchSize:   cfg.embedderBatchSize,
        });
        if (summary.embedded > 0 || summary.failed > 0) {
          logger.info({ summary }, "embedder pass");
        }
      } catch (err) {
        logger.error({ err }, "embedder pass crashed");
      } finally {
        setTimeout(tick, cfg.embedderIntervalMs);
      }
    };
    setTimeout(tick, cfg.embedderIntervalMs);
  };

  startEmbedderLoop();

  const startCleanupLoop = (): void => {
    const intervalMs = cfg.shareCleanupIntervalHours * 60 * 60 * 1000;
    const tick = async (): Promise<void> => {
      try {
        const result = await cleanupOldSnapshots({
          pool,
          snapshotsDir: cfg.shareSnapshotsDir,
          ttlDays:      cfg.shareSnapshotTtlDays,
        });
        if (result.scanned > 0) {
          logger.info({ result }, "share snapshot cleanup pass");
        }
      } catch (err) {
        logger.error({ err }, "share snapshot cleanup crashed");
      } finally {
        setTimeout(tick, intervalMs);
      }
    };
    // Boot-time pass after a brief delay so the rest of startup logs are clean.
    setTimeout(tick, 5_000);
  };

  startCleanupLoop();

  const startAutoCloseLoop = (): void => {
    const intervalMs = cfg.shareAutoCloseIntervalHours * 60 * 60 * 1000;
    const tick = async (): Promise<void> => {
      try {
        const result = await autoCloseIdleRequests({
          pool,
          idleDays: cfg.shareAutoCloseIdleDays,
        });
        if (result.closed > 0) {
          logger.info({ result }, "share auto-close pass");
        }
      } catch (err) {
        logger.error({ err }, "share auto-close crashed");
      } finally {
        setTimeout(tick, intervalMs);
      }
    };
    setTimeout(tick, 5_000);   // boot-time pass after a brief delay
  };

  startAutoCloseLoop();

  // Muxes completed glasses recordings into muxed/pNNN.mp4 (glasses-mux.ts).
  const startGlassesMuxLoop = (): void => {
    const tools = { ffmpeg: cfg.ffmpegBin, ffprobe: cfg.ffprobeBin, run: execRunner };
    const tick = async (): Promise<void> => {
      try {
        const result = await runMuxOnce(pool, cfg.recordingsRoot, tools);
        if (result.processed > 0 || result.failed.length > 0) {
          logger.info({ result }, "glasses mux pass");
        }
      } catch (err) {
        logger.error({ err }, "glasses mux pass crashed");
      } finally {
        setTimeout(tick, cfg.glassesMuxIntervalMs);
      }
    };
    setTimeout(tick, 5_000);
  };

  startGlassesMuxLoop();

  const app = buildApp({
    pool,
    embedderClient: {
      // Request-path embeds (search, similarity check) must finish inside the
      // adapter's 5 s memory RPC timeout; on failure both fall back (FTS /
      // write without the check) instead of hanging.
      embedTexts: (texts, kind) => embedTexts({ baseUrl: cfg.embedderUrl, texts, kind, timeoutMs: 3_000 }),
    },
    mergeSimilarity: cfg.memoryMergeSimilarity,
    managers:        cfg.memoryOrgManagers,
    clearance:       cfg.memoryClearance,
    workspacesRoot:  cfg.workspacesRoot,
    repo: {
      searchMemories,
      getMemory,
      timelineMemories,
      writeUserMemory,
      forgetMemory,
      getContext,
      updateMemory,
      restoreMemory,
      listMemories,
      getAuditTrail,
      getMetrics,
      listDirs,
      getDir,
      memoryTree,
      recordFeedback,
      recordUse,
      usedSince,
      proposeExperiences,
      writeDistillation,
      linkMemories,
      buildBundle,
      consolidate,
      memoryGraph,
      importEntries,
      createBuildJob,
      updateBuildJob,
      listBuildJobs,
    },
  });
  checkCallers(app, { mapFile: cfg.callerMapFile, warn: (obj, msg) => logger.warn(obj, msg) });
  await app.register(shareRoutesPlugin({
    pool,
    managers:            cfg.memoryOrgManagers,
    workspacesRoot:      cfg.workspacesRoot,
    shareSnapshotsDir:   cfg.shareSnapshotsDir,
    shareMaxFolderBytes: cfg.shareMaxFolderBytes,
    repo: {
      submitShareRequest,
      listShareRequests,
      getShareRequest,
      decideShareRequest,
      withdrawShareRequest,
      getShareCapabilities,
    },
  }));

  await app.register(glassesRoutesPlugin({
    pool,
    recordingsRoot: cfg.recordingsRoot,
    maxChunkBytes:  cfg.glassesMaxChunkBytes,
    proxySecret:    cfg.glassesProxySecret,
  }));
  if (!cfg.glassesProxySecret) logger.warn("GLASSES_PROXY_SECRET unset: /api/glasses/ rejects every request");

  await app.listen({ port: cfg.memoryApiPort, host: "0.0.0.0" });
  logger.info({ port: cfg.memoryApiPort }, "memory-api listening");

  const shutdown = async (sig: NodeJS.Signals): Promise<void> => {
    logger.info({ sig }, "shutdown signal");
    await app.close();
    await handle.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function waitForPg(pool: Pool, maxWaitSec: number, logger: pino.Logger): Promise<void> {
  const deadline = Date.now() + maxWaitSec * 1000;
  let delay = 500;
  while (Date.now() < deadline) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      logger.warn({ err: (err as Error).message, delay }, "waiting for PG");
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }
  logger.error("PG unreachable past PG_STARTUP_MAX_WAIT_SEC — exiting");
  process.exit(1);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});

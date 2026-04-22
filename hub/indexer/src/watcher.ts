import chokidar from "chokidar";
import type { FSWatcher } from "chokidar";
import type { Stats } from "node:fs";
import type { Pool } from "pg";
import type { Logger } from "pino";
import { processFile } from "./process-file.js";
import { resolveJsonlPath } from "./path-decode.js";
import { Semaphore } from "./semaphore.js";

export interface StartWatcherOptions {
  pool: Pool;
  watchRoot: string;
  maxConcurrentFiles: number;
  maxPassBytes: number;
  logger: Logger;
}

export interface WatcherHandle {
  close(): Promise<void>;
  waitIdle(): Promise<void>;
}

interface FileState {
  processing: boolean;
  reprocess: boolean;
}

export function startWatcher(opts: StartWatcherOptions): WatcherHandle {
  const { pool, watchRoot, maxConcurrentFiles, maxPassBytes, logger } = opts;
  const sem = new Semaphore(maxConcurrentFiles);
  const state = new Map<string, FileState>();
  const inflight = new Set<Promise<void>>();

  // chokidar v4 does not expand glob patterns, so we watch the root
  // directory and filter events down to the expected layout via
  // resolveJsonlPath. The `ignored` predicate is a fast-path pre-filter
  // that keeps non-.jsonl files out of the event stream altogether.
  const watcher: FSWatcher = chokidar.watch(watchRoot, {
    persistent: true,
    awaitWriteFinish: false,
    ignoreInitial: false,
    alwaysStat: true,
    followSymlinks: false,
    ignored: (p: string, stats?: Stats) =>
      stats?.isFile() ? !p.endsWith(".jsonl") : false,
  });

  function enqueue(fullPath: string): void {
    // Reject any path that does not match the expected per-tenant layout.
    // This is the place the trust boundary is enforced on the watcher side.
    if (resolveJsonlPath(watchRoot, fullPath) === null) return;

    let s = state.get(fullPath);
    if (!s) {
      s = { processing: false, reprocess: false };
      state.set(fullPath, s);
    }
    if (s.processing) {
      s.reprocess = true;
      return;
    }
    s.processing = true;
    const p = (async () => {
      try {
        do {
          s!.reprocess = false;
          await sem.run(() => processFile({ pool, watchRoot, fullPath, maxPassBytes }));
        } while (s!.reprocess);
      } catch (err) {
        logger.error({ err, fullPath }, "processFile failed");
      } finally {
        s!.processing = false;
      }
    })();
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  }

  watcher.on("add", (p) => enqueue(p));
  watcher.on("change", (p) => enqueue(p));
  watcher.on("error", (err) => logger.error({ err }, "watcher error"));

  return {
    async close() {
      await watcher.close();
      await Promise.allSettled([...inflight]);
    },
    async waitIdle() {
      while (inflight.size > 0) {
        await Promise.allSettled([...inflight]);
      }
    },
  };
}

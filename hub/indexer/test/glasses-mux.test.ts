import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { runMuxOnce, ToolUnavailableError, type MuxTools, type Runner } from "../src/glasses-mux.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

let pg: StartedPostgreSqlContainer;
let pool: Pool;
let root: string;

// Fake ffmpeg: writes the concatenation of its -i inputs to the output path,
// so a test can read back exactly which bytes went in, in which order.
// Fake ffprobe: reports a 360x640 video stream of 1.5 s.
function fakeTools(opts: { ffmpegExit?: number; calls?: string[][] } = {}): MuxTools {
  const run: Runner = async (bin, args) => {
    opts.calls?.push([bin, ...args]);
    if (bin === "ffprobe") {
      return { code: 0, stderr: "", stdout: JSON.stringify({
        format: { duration: "1.5" }, streams: [{ codec_type: "video", width: 360, height: 640 }] }) };
    }
    if (opts.ffmpegExit) return { code: opts.ffmpegExit, stdout: "", stderr: "boom: invalid data" };
    const inputs = args.flatMap((a, i) => (args[i - 1] === "-i" ? [a] : []));
    const out = args[args.length - 1]!;
    const bytes = await Promise.all(inputs.map((f) => readFile(f, "utf8")));
    await writeFile(out, bytes.join("|"));
    return { code: 0, stdout: "", stderr: "non monotonically increasing dts" };
  };
  return { ffmpeg: "ffmpeg", ffprobe: "ffprobe", run };
}

type F = { file: string; kind: "init" | "media"; track: "video" | "audio"; seq: number };

// Seeds a completed recording whose files contain their own names.
async function seed(id: string, parts: { index: number; audio?: boolean; files: F[] }[]) {
  const dir = path.join(root, "alice", id);
  await mkdir(dir, { recursive: true });
  for (const p of parts) for (const f of p.files) await writeFile(path.join(dir, f.file), f.file);
  const manifest = { recordingId: id,
    mediaParts: parts.map((p) => ({ ...p, startMs: p.index * 1000, endMs: p.index * 1000 + 900 })) };
  await pool.query(
    `INSERT INTO glasses_recordings (owner, recording_id, started_at, state, manifest, completed_at)
     VALUES ('alice', $1, now(), 'complete', $2, now())`, [id, manifest]);
  return dir;
}

const av = (part: number, segs: [number, "video" | "audio"][]): F[] => [
  { file: `p00${part}-video-init.mp4`, kind: "init", track: "video", seq: 0 },
  { file: `p00${part}-audio-init.mp4`, kind: "init", track: "audio", seq: 0 },
  ...segs.map(([seq, track]) => ({ file: `seg-${String(seq).padStart(6, "0")}-${track}.m4s`, kind: "media" as const, track, seq })),
];

async function state(id: string) {
  const r = await pool.query("SELECT state, mux_error FROM glasses_recordings WHERE recording_id = $1", [id]);
  return r.rows[0];
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await runMigrations({ pool, migrationsDir: MIGRATIONS_DIR, lockKey: 0x62696f666c77n });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

beforeEach(async () => {
  await pool.query("TRUNCATE glasses_recordings CASCADE");
  root = await mkdtemp(path.join(tmpdir(), "glasses-mux-"));
});

describe("runMuxOnce", () => {
  it("muxes each part from init + media in seq order, records parts, marks processed", async () => {
    // Manifest order is scrambled on purpose; seq decides.
    const dir = await seed("r1", [
      { index: 1, files: av(1, [[3, "video"], [1, "video"], [2, "audio"], [4, "audio"]]) },
      { index: 2, files: av(2, [[5, "video"], [6, "audio"]]) },
    ]);
    const result = await runMuxOnce(pool, root, fakeTools());
    expect(result).toEqual({ processed: 1, failed: [] });

    expect(await readFile(path.join(dir, "muxed", "p001.mp4"), "utf8")).toBe(
      "p001-video-init.mp4seg-000001-video.m4sseg-000003-video.m4s|p001-audio-init.mp4seg-000002-audio.m4sseg-000004-audio.m4s");
    // Only the final files remain: intermediates and temp files are removed.
    expect((await readdir(path.join(dir, "muxed"))).sort()).toEqual(["p001.mp4", "p002.mp4"]);

    expect(await state("r1")).toEqual({ state: "processed", mux_error: null });
    const parts = await pool.query(
      "SELECT part, file, duration_ms, width, height, has_audio, start_ms, end_ms FROM glasses_parts ORDER BY part");
    expect(parts.rows).toEqual([
      { part: 1, file: "muxed/p001.mp4", duration_ms: "1500", width: 360, height: 640, has_audio: true, start_ms: "1000", end_ms: "1900" },
      { part: 2, file: "muxed/p002.mp4", duration_ms: "1500", width: 360, height: 640, has_audio: true, start_ms: "2000", end_ms: "2900" },
    ]);
  });

  it("muxes video only when the manifest says audio false or the part has no audio media", async () => {
    const calls: string[][] = [];
    const dir = await seed("r2", [
      { index: 1, audio: false, files: av(1, [[1, "video"], [2, "audio"]]) },
      { index: 2, files: av(2, [[3, "video"]]) },
    ]);
    await runMuxOnce(pool, root, fakeTools({ calls }));
    expect(await readFile(path.join(dir, "muxed", "p001.mp4"), "utf8")).toBe("p001-video-init.mp4seg-000001-video.m4s");
    expect(await readFile(path.join(dir, "muxed", "p002.mp4"), "utf8")).toBe("p002-video-init.mp4seg-000003-video.m4s");
    const ffmpeg = calls.filter((c) => c[0] === "ffmpeg");
    expect(ffmpeg.every((c) => !c.includes("-map"))).toBe(true);
    const parts = await pool.query("SELECT has_audio FROM glasses_parts");
    expect(parts.rows.map((r) => r.has_audio)).toEqual([false, false]);
  });

  it("a non-zero ffmpeg exit marks mux_failed with the error; stderr alone is not a failure", async () => {
    await seed("r3", [{ index: 1, files: av(1, [[1, "video"], [2, "audio"]]) }]);
    const result = await runMuxOnce(pool, root, fakeTools({ ffmpegExit: 1 }));
    expect(result.processed).toBe(0);
    expect(result.failed).toEqual([{ recordingId: "r3", error: "p001: ffmpeg exited 1: boom: invalid data" }]);
    expect(await state("r3")).toEqual({ state: "mux_failed", mux_error: "p001: ffmpeg exited 1: boom: invalid data" });
  });

  it("a missing segment marks mux_failed and the next recording still runs", async () => {
    const dir = await seed("r4", [{ index: 1, files: av(1, [[1, "video"]]) }]);
    await seed("r5", [{ index: 1, files: av(1, [[1, "video"]]) }]);
    await writeFile(path.join(dir, "p001-video-init.mp4"), "x");
    await import("node:fs/promises").then((fs) => fs.unlink(path.join(dir, "seg-000001-video.m4s")));
    const result = await runMuxOnce(pool, root, fakeTools());
    expect(result.processed).toBe(1);
    expect((await state("r4")).state).toBe("mux_failed");
    expect((await state("r5")).state).toBe("processed");
  });

  it("an unavailable ffmpeg leaves the recording waiting in complete", async () => {
    await seed("r6", [{ index: 1, files: av(1, [[1, "video"]]) }]);
    const tools: MuxTools = { ffmpeg: "ffmpeg", ffprobe: "ffprobe",
      run: async () => { throw new ToolUnavailableError("ffmpeg: spawn ENOENT"); } };
    await expect(runMuxOnce(pool, root, tools)).rejects.toThrow(ToolUnavailableError);
    expect((await state("r6")).state).toBe("complete");
  });

  it("running again after a crash (state reset to complete) gives the same single set of parts", async () => {
    const dir = await seed("r7", [{ index: 1, files: av(1, [[1, "video"], [2, "audio"]]) }]);
    await runMuxOnce(pool, root, fakeTools());
    await pool.query("UPDATE glasses_recordings SET state = 'complete'");
    await runMuxOnce(pool, root, fakeTools());
    expect(await readdir(path.join(dir, "muxed"))).toEqual(["p001.mp4"]);
    expect((await pool.query("SELECT count(*)::int AS n FROM glasses_parts")).rows[0].n).toBe(1);
    expect((await runMuxOnce(pool, root, fakeTools())).processed).toBe(0);   // nothing left
  });
});

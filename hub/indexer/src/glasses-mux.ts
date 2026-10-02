// Server-side muxing of completed glasses recordings: each media part becomes
// <recording>/muxed/pNNN.mp4, without re-encoding. Same steps as
// scripts/mux-recording.sh in lili-8477/labweaver-glasses (the reference):
// per track, cat the init segment and the media segments in seq order, then
// `ffmpeg -i video -i audio -map 0:v -map 1:a -c copy`.
//
// Runs from a polling loop over recordings in state 'complete'. Outputs are
// written to a temp file and renamed under fixed names, so a crash or restart
// just redoes the recording without leaving duplicates.

import { execFile } from "node:child_process";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import * as path from "node:path";
import type { Pool } from "pg";
import { z } from "zod";
import {
  markMuxFailed,
  nextRecordingToMux,
  saveMuxResult,
  type PartRow,
} from "./glasses-repo.js";

export type Runner = (bin: string, args: string[]) =>
  Promise<{ code: number; stdout: string; stderr: string }>;

export interface MuxTools {
  ffmpeg:  string;   // binary names or paths
  ffprobe: string;
  run:     Runner;
}

/** The tool could not be run at all (e.g. ffmpeg not installed). */
export class ToolUnavailableError extends Error {}

/** Runs a binary; never rejects on a non-zero exit, only when it cannot run. */
export const execRunner: Runner = (bin, args) => new Promise((resolve, reject) => {
  execFile(bin, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") {
      return reject(new ToolUnavailableError(`${bin}: ${err.message}`));
    }
    resolve({ code: err ? (err.code as number) : 0, stdout, stderr });
  });
});

const ManifestFile = z.object({
  file:  z.string(),
  kind:  z.enum(["init", "media"]),
  track: z.enum(["video", "audio"]),
  seq:   z.number(),
}).passthrough();

const MuxManifest = z.object({
  mediaParts: z.array(z.object({
    index:   z.number().int().min(1),
    audio:   z.boolean().optional(),
    startMs: z.number().nullable().optional(),
    endMs:   z.number().nullable().optional(),
    files:   z.array(ManifestFile),
  }).passthrough()),
}).passthrough();

type Part = z.infer<typeof MuxManifest>["mediaParts"][number];

/** init segment first, then media segments by seq; empty if the track has no media. */
function trackFiles(part: Part, track: "video" | "audio"): string[] {
  const files = part.files.filter((f) => f.track === track);
  const init = files.find((f) => f.kind === "init");
  const media = files.filter((f) => f.kind === "media").sort((a, b) => a.seq - b.seq);
  return init && media.length > 0 ? [init.file, ...media.map((f) => f.file)] : [];
}

async function concat(dir: string, files: string[], target: string): Promise<void> {
  const out = await open(target, "w");
  try {
    for (const f of files) await out.write(await readFile(path.join(dir, f)));
  } finally {
    await out.close();
  }
}

function tail(s: string): string {
  return s.trim().split("\n").slice(-5).join("\n");
}

/** Muxes every part of one recording folder; throws on the first failure. */
export async function muxRecording(dir: string, manifest: unknown, tools: MuxTools): Promise<PartRow[]> {
  const parsed = MuxManifest.safeParse(manifest);
  if (!parsed.success) throw new Error(`manifest has no usable mediaParts: ${parsed.error.issues[0]?.message}`);
  const outDir = path.join(dir, "muxed");
  await mkdir(outDir, { recursive: true });

  const rows: PartRow[] = [];
  for (const part of parsed.data.mediaParts) {
    const name = `p${String(part.index).padStart(3, "0")}`;
    const video = trackFiles(part, "video");
    if (video.length === 0) throw new Error(`${name}: no video init or media segments`);
    const audio = part.audio === false ? [] : trackFiles(part, "audio");

    const vPath = path.join(outDir, `${name}-video.mp4`);
    const aPath = path.join(outDir, `${name}-audio.mp4`);
    const final = path.join(outDir, `${name}.mp4`);
    const tmp = path.join(outDir, `.${name}.mp4.tmp`);
    await concat(dir, video, vPath);
    if (audio.length > 0) await concat(dir, audio, aPath);

    // stderr is not a failure signal: these files always print a harmless
    // "non monotonically increasing dts" warning. Use the exit code.
    const args = audio.length > 0
      ? ["-v", "error", "-y", "-i", vPath, "-i", aPath, "-map", "0:v", "-map", "1:a", "-c", "copy", "-f", "mp4", tmp]
      : ["-v", "error", "-y", "-i", vPath, "-c", "copy", "-f", "mp4", tmp];
    const mux = await tools.run(tools.ffmpeg, args);
    if (mux.code !== 0) {
      await unlink(tmp).catch(() => {});
      throw new Error(`${name}: ffmpeg exited ${mux.code}: ${tail(mux.stderr)}`);
    }
    await rename(tmp, final);

    const probe = await tools.run(tools.ffprobe, [
      "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", final,
    ]);
    if (probe.code !== 0) throw new Error(`${name}: ffprobe exited ${probe.code}: ${tail(probe.stderr)}`);
    const info = JSON.parse(probe.stdout) as {
      format?: { duration?: string };
      streams?: { codec_type?: string; width?: number; height?: number }[];
    };
    const v = info.streams?.find((s) => s.codec_type === "video");
    if (!v) throw new Error(`${name}: output has no video stream`);
    const seconds = Number(info.format?.duration);

    await unlink(vPath);
    if (audio.length > 0) await unlink(aPath);
    rows.push({
      part:       part.index,
      file:       `muxed/${name}.mp4`,
      bytes:      (await stat(final)).size,
      durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null,
      width:      v.width ?? null,
      height:     v.height ?? null,
      hasAudio:   audio.length > 0,
      startMs:    part.startMs ?? null,
      endMs:      part.endMs ?? null,
    });
  }
  return rows;
}

/** Muxes every recording waiting in state 'complete', oldest first. */
export async function runMuxOnce(pool: Pool, recordingsRoot: string, tools: MuxTools): Promise<{
  processed: number; failed: { recordingId: string; error: string }[];
}> {
  let processed = 0;
  const failed: { recordingId: string; error: string }[] = [];
  for (;;) {
    const next = await nextRecordingToMux(pool);
    if (!next) break;
    const dir = path.join(recordingsRoot, next.owner, next.recordingId);
    try {
      const parts = await muxRecording(dir, next.manifest, tools);
      await saveMuxResult(pool, next.owner, next.recordingId, parts);
      processed++;
    } catch (err) {
      // A missing ffmpeg is not the recording's fault: stop the pass and leave
      // it in 'complete' so the next pass retries.
      if (err instanceof ToolUnavailableError) throw err;
      const error = (err as Error).message;
      await markMuxFailed(pool, next.owner, next.recordingId, error);
      failed.push({ recordingId: next.recordingId, error });
    }
  }
  return { processed, failed };
}

// Upload API for the LabWeaver Glasses iOS app. The contract is DESIGN.md §7
// in lili-8477/labweaver-glasses.
//
// nginx authenticates the Bearer token, strips it, and passes the workspace
// owner in X-Forwarded-User; this plugin trusts that header the same way the
// memory and share APIs trust their `actor` (private docker network).
//
// Files land in <recordingsRoot>/<owner>/<recordingId>/ under the names the
// phone uses, so scripts/mux-recording.sh from the glasses repo runs on them.

import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  createRecording,
  getRecordingState,
  listChunkFiles,
  markComplete,
  storeChunk,
} from "./glasses-repo.js";

export interface GlassesApiDeps {
  pool:           Pool;
  recordingsRoot: string;
  maxChunkBytes:  number;
}

const OWNER_RE        = /^[a-z0-9][a-z0-9-]*$/;           // add-user.sh rule
const RECORDING_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{4}$/;       // yyyyMMdd-HHmmss-xxxx
const SHA256_RE       = /^[0-9a-f]{64}$/;

const CreateBody = z.object({
  startedAt: z.string().datetime({ offset: true }),
  device:    z.record(z.unknown()).default({}),
  config:    z.record(z.unknown()).default({}),
});

const ChunkParams = z.object({
  part:  z.coerce.number().int().min(1),
  track: z.enum(["video", "audio"]),
  seq:   z.coerce.number().int().min(0),
});

// Only the fields the server checks; the rest of the manifest is stored as is.
const Manifest = z.object({
  recordingId: z.string().optional(),
  mediaParts:  z.array(z.object({
    files: z.array(z.object({ file: z.string() }).passthrough()),
  }).passthrough()),
}).passthrough();

/** Name of a chunk's file, matching Recorder.swift on the phone. */
export function chunkFileName(part: number, track: "video" | "audio", seq: number): string {
  return seq === 0
    ? `p${String(part).padStart(3, "0")}-${track}-init.mp4`
    : `seg-${String(seq).padStart(6, "0")}-${track}.m4s`;
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(() => true, () => false);
}

/** Writes next to the target, then renames, so readers never see half a file. */
async function writeAtomic(target: string, data: Buffer | string): Promise<void> {
  const tmp = tempPath(target);
  await writeFile(tmp, data);
  await rename(tmp, target);
}

function tempPath(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
}

export function glassesRoutesPlugin(deps: GlassesApiDeps) {
  return async function (instance: FastifyInstance) {
    instance.addContentTypeParser(
      ["video/mp4", "video/iso.segment", "application/octet-stream", "application/x-ndjson"],
      { parseAs: "buffer", bodyLimit: deps.maxChunkBytes },
      (_req, body, done) => done(null, body),
    );

    // Resolves owner and recording id, or sends the error and returns null.
    const target = (req: FastifyRequest, reply: FastifyReply) => {
      const owner = req.headers["x-forwarded-user"];
      if (typeof owner !== "string" || !OWNER_RE.test(owner)) {
        reply.code(401).send({ error: "unauthenticated" });
        return null;
      }
      const recordingId = (req.params as { id: string }).id;
      if (!RECORDING_ID_RE.test(recordingId)) {
        reply.code(400).send({ error: "invalid recording id" });
        return null;
      }
      return { owner, recordingId, dir: path.join(deps.recordingsRoot, owner, recordingId) };
    };

    // PUT /api/glasses/recordings/:id — create (idempotent).
    instance.put("/api/glasses/recordings/:id", async (req, reply) => {
      const t = target(req, reply);
      if (!t) return reply;
      const parsed = CreateBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "validation failed", issues: parsed.error.issues });
      }
      await mkdir(t.dir, { recursive: true });
      const { created } = await createRecording(deps.pool, {
        owner: t.owner, recordingId: t.recordingId, ...parsed.data,
      });
      return reply.code(created ? 201 : 200).send({ recordingId: t.recordingId });
    });

    // PUT /api/glasses/recordings/:id/chunks/:part/:track/:seq — one fMP4 file.
    instance.put("/api/glasses/recordings/:id/chunks/:part/:track/:seq", async (req, reply) => {
      const t = target(req, reply);
      if (!t) return reply;
      const params = ChunkParams.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: "invalid chunk key" });
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: "empty body" });
      }
      const claimed = String(req.headers["x-chunk-sha256"] ?? "").toLowerCase();
      if (!SHA256_RE.test(claimed)) return reply.code(400).send({ error: "missing X-Chunk-SHA256" });
      const sha256 = createHash("sha256").update(body).digest("hex");
      if (sha256 !== claimed) return reply.code(400).send({ error: "sha256 mismatch" });

      const { part, track, seq } = params.data;
      const file = chunkFileName(part, track, seq);
      const final = path.join(t.dir, file);
      const tmp = tempPath(final);
      const state = await getRecordingState(deps.pool, t.owner, t.recordingId);
      if (state === null) return reply.code(404).send({ error: "recording not found" });
      await writeFile(tmp, body);
      const result = await storeChunk(
        deps.pool,
        { owner: t.owner, recordingId: t.recordingId, part, track, seq, file, sha256, bytes: body.length },
        () => rename(tmp, final),
      ).finally(() => unlink(tmp).catch(() => {}));   // no-op once renamed

      switch (result.status) {
        case "created":      return reply.code(201).send({ file });
        case "exists":       return result.sha256 === sha256
          ? reply.code(200).send({ file })
          : reply.code(409).send({ error: "chunk exists with a different sha256", file });
        case "closed":       return reply.code(409).send({ error: "recording is complete" });
        case "no_recording": return reply.code(404).send({ error: "recording not found" });
      }
    });

    // PUT /api/glasses/recordings/:id/events — the whole events.jsonl.
    instance.put("/api/glasses/recordings/:id/events", async (req, reply) => {
      const t = target(req, reply);
      if (!t) return reply;
      if (!Buffer.isBuffer(req.body)) return reply.code(400).send({ error: "expected application/x-ndjson" });
      const state = await getRecordingState(deps.pool, t.owner, t.recordingId);
      if (state === null) return reply.code(404).send({ error: "recording not found" });
      if (state === "complete") return reply.code(409).send({ error: "recording is complete" });
      await writeAtomic(path.join(t.dir, "events.jsonl"), req.body);
      return reply.code(204).send();
    });

    // POST /api/glasses/recordings/:id/complete — body is manifest.json.
    instance.post("/api/glasses/recordings/:id/complete",
      { bodyLimit: 16 * 1024 * 1024 },
      async (req, reply) => {
        const t = target(req, reply);
        if (!t) return reply;
        const parsed = Manifest.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: "validation failed", issues: parsed.error.issues });
        }
        const manifest = parsed.data;
        if (manifest.recordingId !== undefined && manifest.recordingId !== t.recordingId) {
          return reply.code(400).send({ error: "manifest recordingId does not match the URL" });
        }
        const state = await getRecordingState(deps.pool, t.owner, t.recordingId);
        if (state === null) return reply.code(404).send({ error: "recording not found" });
        if (state === "complete") return reply.code(202).send({ state });

        const received = await listChunkFiles(deps.pool, t.owner, t.recordingId);
        const missing = manifest.mediaParts
          .flatMap((p) => p.files.map((f) => f.file))
          .filter((f) => !received.has(f));
        if (!(await exists(path.join(t.dir, "events.jsonl")))) missing.push("events.jsonl");
        if (missing.length > 0) return reply.code(409).send({ missing });

        await writeAtomic(path.join(t.dir, "manifest.json"), JSON.stringify(manifest, null, 2));
        await markComplete(deps.pool, t.owner, t.recordingId, manifest);
        return reply.code(202).send({ state: "complete" });
      });
  };
}

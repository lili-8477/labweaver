// Upload API for the LabWeaver Glasses iOS app. The contract is
// docs/UPLOAD_API.md in lili-8477/labweaver-glasses.
//
// nginx authenticates the Bearer token, strips it, and passes the workspace
// owner in X-Forwarded-User. User containers share the indexer's docker
// network and could send that header themselves, so the owner is only
// trusted alongside X-Glasses-Proxy-Secret, which only nginx knows
// (GLASSES_PROXY_SECRET). With no secret configured every request is refused.
//
// Files land in <recordingsRoot>/<owner>/<recordingId>/<name> under the names
// the phone uses, so scripts/mux-recording.sh from the glasses repo runs on them.

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  createRecording,
  getRecordingState,
  listFileNames,
  markComplete,
  storeFile,
  type FileRow,
} from "./glasses-repo.js";

export interface GlassesApiDeps {
  pool:           Pool;
  recordingsRoot: string;
  maxChunkBytes:  number;
  proxySecret:    string;   // must match nginx's X-Glasses-Proxy-Secret
}

const PREFIX          = "/api/glasses";
const OWNER_RE        = /^[a-z0-9][a-z0-9-]*$/;             // add-user.sh rule
const RECORDING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;  // phone: yyyyMMdd-HHmmss-xxxx
const SHA256_RE       = /^[0-9a-f]{64}$/;
const INT_RE          = /^\d{1,12}$/;

const CreateBody = z.object({
  localId:   z.string().regex(RECORDING_ID_RE),
  startedAt: z.string().datetime({ offset: true }),
  device:    z.record(z.unknown()).default({}),
  config:    z.record(z.unknown()).default({}),
});

const CompleteBody = z.object({
  durationMs: z.number().int().nonnegative().optional(),
  endedAt:    z.string().datetime({ offset: true }).optional(),
}).passthrough();

// Only the fields the server checks; the rest of the manifest is stored as is.
const Manifest = z.object({
  recordingId: z.string().optional(),
  mediaParts:  z.array(z.object({
    files: z.array(z.object({ file: z.string() }).passthrough()),
  }).passthrough()),
}).passthrough();

type Kind = FileRow["kind"];
type Track = "video" | "audio";

/** Kind and track implied by a file name, or null if the name is not allowed. */
export function classifyName(name: string): { kind: Kind; track: Track | null; part?: number; seq?: number } | null {
  let m = /^p(\d{3})-(video|audio)-init\.mp4$/.exec(name);
  if (m) return { kind: "init", track: m[2] as Track, part: Number(m[1]) };
  m = /^seg-(\d{6})-(video|audio)\.m4s$/.exec(name);
  if (m) return { kind: "media", track: m[2] as Track, seq: Number(m[1]) };
  if (name === "events.jsonl") return { kind: "events", track: null };
  if (name === "manifest.json") return { kind: "manifest", track: null };
  return null;
}

function tempPath(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
}

export function glassesRoutesPlugin(deps: GlassesApiDeps) {
  return async function (instance: FastifyInstance) {
    instance.addContentTypeParser(
      ["application/octet-stream", "video/mp4", "video/iso.segment", "application/x-ndjson"],
      { parseAs: "buffer", bodyLimit: deps.maxChunkBytes },
      (_req, body, done) => done(null, body),
    );

    const expected = Buffer.from(deps.proxySecret);
    const fromProxy = (req: FastifyRequest): boolean => {
      const got = Buffer.from(String(req.headers["x-glasses-proxy-secret"] ?? ""));
      return expected.length > 0 && got.length === expected.length && timingSafeEqual(got, expected);
    };

    // Resolves the owner, or sends 401 and returns null.
    const ownerOf = (req: FastifyRequest, reply: FastifyReply): string | null => {
      const owner = req.headers["x-forwarded-user"];
      if (fromProxy(req) && typeof owner === "string" && OWNER_RE.test(owner)) return owner;
      reply.code(401).send({ error: "unauthenticated" });
      return null;
    };

    // Resolves owner and recording id from the URL, or sends the error and returns null.
    const target = (req: FastifyRequest, reply: FastifyReply) => {
      const owner = ownerOf(req, reply);
      if (!owner) return null;
      const recordingId = (req.params as { id: string }).id;
      if (!RECORDING_ID_RE.test(recordingId)) {
        reply.code(400).send({ error: "invalid recording id" });
        return null;
      }
      return { owner, recordingId, dir: path.join(deps.recordingsRoot, owner, recordingId) };
    };

    instance.get(`${PREFIX}/ping`, async (req, reply) => {
      if (!ownerOf(req, reply)) return reply;
      return { ok: true };
    });

    // POST /recordings — create (idempotent per owner + localId).
    instance.post(`${PREFIX}/recordings`, async (req, reply) => {
      const owner = ownerOf(req, reply);
      if (!owner) return reply;
      const parsed = CreateBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "validation failed", issues: parsed.error.issues });
      }
      const { localId, ...rest } = parsed.data;
      await mkdir(path.join(deps.recordingsRoot, owner, localId), { recursive: true });
      const { created } = await createRecording(deps.pool, { owner, recordingId: localId, ...rest });
      return reply.code(created ? 201 : 200).send({ recordingId: localId });
    });

    // PUT /recordings/:id/files/:name — one file, stored atomically.
    instance.put(`${PREFIX}/recordings/:id/files/:name`, async (req, reply) => {
      const t = target(req, reply);
      if (!t) return reply;
      const name = (req.params as { name: string }).name;
      const implied = classifyName(name);
      if (!implied) return reply.code(400).send({ error: "invalid file name" });

      const h = req.headers;
      const header = (k: string) => (typeof h[k] === "string" ? (h[k] as string) : undefined);
      const intHeader = (k: string): number | null | "bad" => {
        const v = header(k);
        if (v === undefined) return null;
        return INT_RE.test(v) ? Number(v) : "bad";
      };
      const claimed = header("x-file-sha256");
      if (!claimed || !SHA256_RE.test(claimed)) {
        return reply.code(400).send({ error: "X-File-SHA256 must be lowercase hex" });
      }
      if (header("x-file-kind") !== implied.kind) {
        return reply.code(400).send({ error: `X-File-Kind must be ${implied.kind} for ${name}` });
      }
      const track = header("x-file-track");
      if (track !== undefined && track !== implied.track) {
        return reply.code(400).send({ error: "X-File-Track does not match the file name" });
      }
      const ints = {
        part:       intHeader("x-file-part"),
        seq:        intHeader("x-file-seq"),
        startMs:    intHeader("x-file-start-ms"),
        durationMs: intHeader("x-file-duration-ms"),
      };
      if (Object.values(ints).includes("bad")) {
        return reply.code(400).send({ error: "X-File-Part/Seq/Start-Ms/Duration-Ms must be integers" });
      }

      const body = req.body;
      if (!Buffer.isBuffer(body)) return reply.code(400).send({ error: "expected a raw body" });
      const sha256 = createHash("sha256").update(body).digest("hex");
      if (sha256 !== claimed) return reply.code(400).send({ error: "sha256 mismatch" });

      const state = await getRecordingState(deps.pool, t.owner, t.recordingId);
      if (state === null) return reply.code(404).send({ error: "recording not found" });

      const final = path.join(t.dir, name);
      const tmp = tempPath(final);
      await writeFile(tmp, body);
      const row: FileRow = {
        owner: t.owner, recordingId: t.recordingId, name, kind: implied.kind, track: implied.track,
        part:       (ints.part as number | null) ?? implied.part ?? null,
        seq:        (ints.seq as number | null) ?? implied.seq ?? null,
        startMs:    ints.startMs as number | null,
        durationMs: ints.durationMs as number | null,
        sha256, bytes: body.length,
      };
      const result = await storeFile(deps.pool, row, () => rename(tmp, final))
        .finally(() => unlink(tmp).catch(() => {}));   // no-op once renamed

      switch (result.status) {
        case "created":      return reply.code(201).send({ ok: true });
        case "exists":       return result.sha256 === sha256
          ? reply.code(200).send({ ok: true })
          : reply.code(409).send({ error: "different bytes already stored under this name" });
        case "closed":       return reply.code(409).send({ error: "recording is complete" });
        case "no_recording": return reply.code(404).send({ error: "recording not found" });
      }
    });

    // POST /recordings/:id/complete — checks the uploaded manifest.json.
    instance.post(`${PREFIX}/recordings/:id/complete`, async (req, reply) => {
      const t = target(req, reply);
      if (!t) return reply;
      const body = CompleteBody.safeParse(req.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: "validation failed", issues: body.error.issues });
      }
      const state = await getRecordingState(deps.pool, t.owner, t.recordingId);
      if (state === null) return reply.code(404).send({ error: "recording not found" });
      if (state !== "uploading") return reply.code(202).send({ ok: true });   // already complete

      const received = await listFileNames(deps.pool, t.owner, t.recordingId);
      if (!received.has("manifest.json")) return reply.code(409).send({ missing: ["manifest.json"] });

      let manifestJson: unknown;
      try {
        manifestJson = JSON.parse(await readFile(path.join(t.dir, "manifest.json"), "utf8"));
      } catch {
        return reply.code(400).send({ error: "manifest.json is not valid JSON" });
      }
      const manifest = Manifest.safeParse(manifestJson);
      if (!manifest.success) {
        return reply.code(400).send({ error: "manifest.json has no mediaParts[].files[].file" });
      }
      if (manifest.data.recordingId !== undefined && manifest.data.recordingId !== t.recordingId) {
        return reply.code(400).send({ error: "manifest recordingId does not match the URL" });
      }

      const missing = [
        ...manifest.data.mediaParts.flatMap((p) => p.files.map((f) => f.file)),
        "events.jsonl",
      ].filter((f) => !received.has(f));
      if (missing.length > 0) return reply.code(409).send({ missing });

      await markComplete(deps.pool, {
        owner: t.owner, recordingId: t.recordingId, manifest: manifest.data,
        durationMs: body.data.durationMs ?? null, endedAt: body.data.endedAt ?? null,
      });
      return reply.code(202).send({ ok: true });
    });
  };
}

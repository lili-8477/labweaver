import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { chunkFileName, glassesRoutesPlugin } from "../src/glasses-api.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const ID = "20260929-101500-ab12";
const BASE = `/api/glasses/recordings/${ID}`;
const USER = { "x-forwarded-user": "alice" };

let pg: StartedPostgreSqlContainer;
let pool: Pool;
let app: FastifyInstance;
let root: string;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function create(headers: Record<string, string> = USER) {
  return app.inject({
    method: "PUT", url: BASE, headers,
    payload: { startedAt: "2026-09-29T10:15:00Z", device: { model: "rb" }, config: { fps: 24 } },
  });
}

function putChunk(part: number, track: string, seq: number, body: Buffer, hash = sha(body)) {
  return app.inject({
    method: "PUT", url: `${BASE}/chunks/${part}/${track}/${seq}`,
    headers: { ...USER, "content-type": "video/iso.segment", "x-chunk-sha256": hash },
    payload: body,
  });
}

function putEvents(text = '{"t":0,"type":"session_state","payload":{}}\n') {
  return app.inject({
    method: "PUT", url: `${BASE}/events`,
    headers: { ...USER, "content-type": "application/x-ndjson" }, payload: text,
  });
}

function complete(files: string[]) {
  return app.inject({
    method: "POST", url: `${BASE}/complete`, headers: USER,
    payload: { recordingId: ID, durationMs: 1000, mediaParts: [{ index: 1, files: files.map((file) => ({ file })) }] },
  });
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await runMigrations({ pool, migrationsDir: MIGRATIONS_DIR, lockKey: 0x62696f666c77n });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await pg?.stop();
}, 30_000);

beforeEach(async () => {
  await pool.query("TRUNCATE glasses_recordings CASCADE");
  await app?.close();
  root = await mkdtemp(path.join(tmpdir(), "glasses-"));
  app = Fastify({ logger: false });
  await app.register(glassesRoutesPlugin({ pool, recordingsRoot: root, maxChunkBytes: 1024 * 1024 }));
});

describe("chunkFileName", () => {
  it("matches the phone's names", () => {
    expect(chunkFileName(1, "video", 0)).toBe("p001-video-init.mp4");
    expect(chunkFileName(12, "audio", 0)).toBe("p012-audio-init.mp4");
    expect(chunkFileName(3, "audio", 42)).toBe("seg-000042-audio.m4s");
  });
});

describe("auth and ids", () => {
  it("401 without a forwarded user", async () => {
    expect((await create({})).statusCode).toBe(401);
  });

  it("401 for a user name that fails the add-user.sh rule", async () => {
    expect((await create({ "x-forwarded-user": "../etc" })).statusCode).toBe(401);
  });

  it("400 for a recording id not in the phone's format", async () => {
    const res = await app.inject({ method: "PUT", url: "/api/glasses/recordings/..%2Fx", headers: USER,
      payload: { startedAt: "2026-09-29T10:15:00Z" } });
    expect(res.statusCode).toBe(400);
  });
});

describe("PUT recording", () => {
  it("201 then 200, and creates the owner-scoped folder", async () => {
    expect((await create()).statusCode).toBe(201);
    expect((await create()).statusCode).toBe(200);
    expect(await readdir(path.join(root, "alice", ID))).toEqual([]);
  });

  it("400 without startedAt", async () => {
    const res = await app.inject({ method: "PUT", url: BASE, headers: USER, payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe("PUT chunk", () => {
  const body = Buffer.from("fmp4 segment bytes");

  it("404 before the recording exists", async () => {
    expect((await putChunk(1, "video", 1, body)).statusCode).toBe(404);
  });

  it("201 stores the file under the phone's name; a retry is 200", async () => {
    await create();
    const res = await putChunk(1, "video", 0, body);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ file: "p001-video-init.mp4" });
    expect(await readFile(path.join(root, "alice", ID, "p001-video-init.mp4"))).toEqual(body);
    expect((await putChunk(1, "video", 0, body)).statusCode).toBe(200);
  });

  it("init segments of different parts and tracks do not collide", async () => {
    await create();
    for (const [part, track] of [[1, "video"], [1, "audio"], [2, "video"]] as const) {
      expect((await putChunk(part, track, 0, body)).statusCode).toBe(201);
    }
  });

  it("400 when the body does not match X-Chunk-SHA256, nothing stored", async () => {
    await create();
    expect((await putChunk(1, "video", 1, body, "0".repeat(64))).statusCode).toBe(400);
    expect(await readdir(path.join(root, "alice", ID))).toEqual([]);
  });

  it("409 for the same key with different bytes; the first file is kept", async () => {
    await create();
    await putChunk(1, "audio", 5, body);
    expect((await putChunk(1, "audio", 5, Buffer.from("other"))).statusCode).toBe(409);
    expect(await readFile(path.join(root, "alice", ID, "seg-000005-audio.m4s"))).toEqual(body);
  });

  it("409 for one media seq sent under a second part", async () => {
    await create();
    await putChunk(1, "video", 7, body);
    expect((await putChunk(2, "video", 7, Buffer.from("other"))).statusCode).toBe(409);
  });

  it("400 for a bad track or seq", async () => {
    await create();
    expect((await putChunk(1, "depth", 1, body)).statusCode).toBe(400);
    expect((await putChunk(0, "video", 1, body)).statusCode).toBe(400);
  });

  it("413 over the size limit", async () => {
    await create();
    expect((await putChunk(1, "video", 1, Buffer.alloc(2 * 1024 * 1024))).statusCode).toBe(413);
  });

  it("owners are isolated", async () => {
    await create();
    const res = await app.inject({
      method: "PUT", url: `${BASE}/chunks/1/video/1`,
      headers: { "x-forwarded-user": "bob", "content-type": "video/iso.segment", "x-chunk-sha256": sha(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("events and complete", () => {
  const body = Buffer.from("seg");

  it("events replace the previous copy", async () => {
    await create();
    expect((await putEvents("a\n")).statusCode).toBe(204);
    expect((await putEvents("a\nb\n")).statusCode).toBe(204);
    expect(await readFile(path.join(root, "alice", ID, "events.jsonl"), "utf8")).toBe("a\nb\n");
  });

  it("409 lists the missing files and events.jsonl", async () => {
    await create();
    await putChunk(1, "video", 0, body);
    const res = await complete(["p001-video-init.mp4", "seg-000001-video.m4s"]);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ missing: ["seg-000001-video.m4s", "events.jsonl"] });
  });

  it("202 once everything arrived; writes manifest.json; repeat is 202; later uploads 409", async () => {
    await create();
    await putChunk(1, "video", 0, body);
    await putChunk(1, "video", 1, body);
    await putEvents();
    const files = ["p001-video-init.mp4", "seg-000001-video.m4s"];
    expect((await complete(files)).statusCode).toBe(202);
    const manifest = JSON.parse(await readFile(path.join(root, "alice", ID, "manifest.json"), "utf8"));
    expect(manifest.recordingId).toBe(ID);
    const row = await pool.query("SELECT state, manifest->>'durationMs' AS d FROM glasses_recordings");
    expect(row.rows[0]).toEqual({ state: "complete", d: "1000" });

    expect((await complete(files)).statusCode).toBe(202);
    expect((await putChunk(1, "video", 2, body)).statusCode).toBe(409);
    expect((await putEvents()).statusCode).toBe(409);
  });

  it("400 when the manifest names another recording", async () => {
    await create();
    const res = await app.inject({ method: "POST", url: `${BASE}/complete`, headers: USER,
      payload: { recordingId: "20260101-000000-0000", mediaParts: [] } });
    expect(res.statusCode).toBe(400);
  });
});

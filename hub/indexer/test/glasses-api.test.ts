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
import { classifyName, glassesRoutesPlugin } from "../src/glasses-api.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const ID = "20260929-101500-ab12";
const API = "/api/glasses";
const REC = `${API}/recordings/${ID}`;
const SECRET = "proxy-secret-for-tests";
const USER = { "x-forwarded-user": "alice", "x-glasses-proxy-secret": SECRET };

let pg: StartedPostgreSqlContainer;
let pool: Pool;
let app: FastifyInstance;
let root: string;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const KIND: Record<string, string> = { mp4: "init", m4s: "media", jsonl: "events", json: "manifest" };

function create(headers: Record<string, string> = USER, localId = ID) {
  return app.inject({
    method: "POST", url: `${API}/recordings`, headers,
    payload: { localId, startedAt: "2026-09-29T10:15:00Z",
      device: { id: "d1", name: "RB Meta" }, config: { resolution: "medium", fps: 24 } },
  });
}

function putFile(name: string, body: Buffer | string, extra: Record<string, string> = {}, owner = "alice") {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return app.inject({
    method: "PUT", url: `${REC}/files/${name}`,
    headers: {
      "x-forwarded-user": owner, "x-glasses-proxy-secret": SECRET, "content-type": "application/octet-stream",
      "x-file-sha256": sha(buf), "x-file-kind": KIND[name.split(".").pop()!]!, ...extra,
    },
    payload: buf,
  });
}

function manifest(files: string[]) {
  return JSON.stringify({ recordingId: ID, mediaParts: [{ index: 1, files: files.map((file) => ({ file })) }] });
}

function complete() {
  return app.inject({ method: "POST", url: `${REC}/complete`, headers: USER,
    payload: { durationMs: 1000, endedAt: "2026-09-29T10:16:00Z", fileCount: 4 } });
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
  await app.register(glassesRoutesPlugin({ pool, recordingsRoot: root, maxChunkBytes: 1024 * 1024, proxySecret: SECRET }));
});

describe("classifyName", () => {
  it("accepts the phone's four name shapes", () => {
    expect(classifyName("p001-video-init.mp4")).toEqual({ kind: "init", track: "video", part: 1 });
    expect(classifyName("seg-000042-audio.m4s")).toEqual({ kind: "media", track: "audio", seq: 42 });
    expect(classifyName("events.jsonl")).toEqual({ kind: "events", track: null });
    expect(classifyName("manifest.json")).toEqual({ kind: "manifest", track: null });
  });

  it("rejects anything else", () => {
    for (const n of ["p1-video-init.mp4", "seg-000001-depth.m4s", "../manifest.json", "notes.txt"]) {
      expect(classifyName(n)).toBeNull();
    }
  });
});

describe("auth and ping", () => {
  it("ping is 200 {ok:true} for a forwarded user", async () => {
    const res = await app.inject({ method: "GET", url: `${API}/ping`, headers: USER });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("401 without a forwarded user, or with one that fails the add-user.sh rule", async () => {
    expect((await app.inject({ method: "GET", url: `${API}/ping` })).statusCode).toBe(401);
    expect((await create({ ...USER, "x-forwarded-user": "../etc" })).statusCode).toBe(401);
  });

  it("401 for a forwarded user without the proxy secret, or with a wrong one", async () => {
    // What a process in a user's container could send straight to the indexer.
    expect((await create({ "x-forwarded-user": "alice" })).statusCode).toBe(401);
    expect((await create({ "x-forwarded-user": "alice", "x-glasses-proxy-secret": "guess" })).statusCode).toBe(401);
    expect((await create({ "x-forwarded-user": "alice", "x-glasses-proxy-secret": SECRET + "x" })).statusCode).toBe(401);
  });

  it("401 for everything when no secret is configured", async () => {
    const open = Fastify({ logger: false });
    await open.register(glassesRoutesPlugin({ pool, recordingsRoot: root, maxChunkBytes: 1024, proxySecret: "" }));
    const res = await open.inject({ method: "GET", url: `${API}/ping`,
      headers: { "x-forwarded-user": "alice", "x-glasses-proxy-secret": "" } });
    expect(res.statusCode).toBe(401);
    await open.close();
  });
});

describe("POST /recordings", () => {
  it("201 then 200 with the same id, and creates the owner-scoped folder", async () => {
    const first = await create();
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ recordingId: ID });
    const again = await create();
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ recordingId: ID });
    expect(await readdir(path.join(root, "alice", ID))).toEqual([]);
  });

  it("400 for a missing startedAt or an unsafe localId", async () => {
    const res = await app.inject({ method: "POST", url: `${API}/recordings`, headers: USER, payload: { localId: ID } });
    expect(res.statusCode).toBe(400);
    expect((await create(USER, "../x")).statusCode).toBe(400);
  });
});

describe("PUT files", () => {
  const body = Buffer.from("fmp4 segment bytes");

  it("404 before the recording exists", async () => {
    expect((await putFile("seg-000001-video.m4s", body)).statusCode).toBe(404);
  });

  it("201 stores the file under its name; a retry is 200", async () => {
    await create();
    expect((await putFile("p001-video-init.mp4", body, { "x-file-track": "video", "x-file-part": "1" })).statusCode).toBe(201);
    expect(await readFile(path.join(root, "alice", ID, "p001-video-init.mp4"))).toEqual(body);
    expect((await putFile("p001-video-init.mp4", body)).statusCode).toBe(200);
  });

  it("records the X-File-* headers", async () => {
    await create();
    await putFile("seg-000003-audio.m4s", body, {
      "x-file-track": "audio", "x-file-part": "2", "x-file-seq": "3",
      "x-file-start-ms": "20000", "x-file-duration-ms": "10000",
    });
    const r = await pool.query("SELECT kind, track, part, seq, start_ms, duration_ms, bytes FROM glasses_files");
    expect(r.rows[0]).toEqual({ kind: "media", track: "audio", part: 2, seq: 3,
      start_ms: "20000", duration_ms: "10000", bytes: String(body.length) });
  });

  it("400 for a hash mismatch, and nothing is stored", async () => {
    await create();
    const res = await putFile("seg-000001-video.m4s", body, { "x-file-sha256": "0".repeat(64) });
    expect(res.statusCode).toBe(400);
    expect(await readdir(path.join(root, "alice", ID))).toEqual([]);
  });

  it("400 for a bad name, a wrong kind or track, or a non-integer header", async () => {
    await create();
    expect((await putFile("notes.json", body)).statusCode).toBe(400);
    expect((await putFile("seg-000001-video.m4s", body, { "x-file-kind": "init" })).statusCode).toBe(400);
    expect((await putFile("seg-000001-video.m4s", body, { "x-file-track": "audio" })).statusCode).toBe(400);
    expect((await putFile("seg-000001-video.m4s", body, { "x-file-seq": "one" })).statusCode).toBe(400);
    expect((await putFile("seg-000001-video.m4s", body, { "x-file-sha256": sha(body).toUpperCase() })).statusCode).toBe(400);
  });

  it("409 for different bytes under the same name; the first file is kept", async () => {
    await create();
    await putFile("seg-000005-audio.m4s", body);
    expect((await putFile("seg-000005-audio.m4s", "other")).statusCode).toBe(409);
    expect(await readFile(path.join(root, "alice", ID, "seg-000005-audio.m4s"))).toEqual(body);
  });

  it("413 over the size limit", async () => {
    await create();
    expect((await putFile("seg-000001-video.m4s", Buffer.alloc(2 * 1024 * 1024))).statusCode).toBe(413);
  });

  it("owners are isolated", async () => {
    await create();
    expect((await putFile("seg-000001-video.m4s", body, {}, "bob")).statusCode).toBe(404);
  });
});

describe("complete", () => {
  const seg = Buffer.from("seg");
  const files = ["p001-video-init.mp4", "seg-000001-video.m4s"];

  it("409 [manifest.json] before the manifest is uploaded", async () => {
    await create();
    const res = await complete();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ missing: ["manifest.json"] });
  });

  it("409 lists the missing media files and events.jsonl", async () => {
    await create();
    await putFile("p001-video-init.mp4", seg);
    await putFile("manifest.json", manifest(files));
    const res = await complete();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ missing: ["seg-000001-video.m4s", "events.jsonl"] });
  });

  it("202 {ok:true} once everything arrived; repeat is 202; later uploads 409", async () => {
    await create();
    await putFile("p001-video-init.mp4", seg);
    await putFile("seg-000001-video.m4s", seg);
    await putFile("events.jsonl", '{"t":0,"type":"session_state","payload":{}}\n');
    await putFile("manifest.json", manifest(files));
    const res = await complete();
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });
    const row = await pool.query(
      "SELECT state, duration_ms, manifest->>'recordingId' AS m FROM glasses_recordings");
    expect(row.rows[0]).toEqual({ state: "complete", duration_ms: "1000", m: ID });

    expect((await complete()).statusCode).toBe(202);
    expect((await putFile("seg-000002-video.m4s", seg)).statusCode).toBe(409);
  });

  it("after muxing (processed or mux_failed), complete is still 202 and uploads are 409", async () => {
    await create();
    for (const state of ["processed", "mux_failed"]) {
      await pool.query("UPDATE glasses_recordings SET state = $1", [state]);
      expect((await complete()).statusCode).toBe(202);
      expect((await putFile("seg-000009-video.m4s", seg)).statusCode).toBe(409);
    }
  });

  it("400 when manifest.json is not JSON or names another recording", async () => {
    await create();
    await putFile("manifest.json", "{not json");
    expect((await complete()).statusCode).toBe(400);
    await pool.query("TRUNCATE glasses_recordings CASCADE");
    await create();
    await putFile("manifest.json", JSON.stringify({ recordingId: "other", mediaParts: [] }));
    expect((await complete()).statusCode).toBe(400);
  });
});

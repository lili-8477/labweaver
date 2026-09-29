// Postgres access for glasses recordings (migration 0014). The media bytes
// live on disk; these rows record what arrived and act as the upload ACK.

import type { Pool } from "pg";

export type RecordingState = "uploading" | "complete";

export interface ChunkRow {
  owner:       string;
  recordingId: string;
  part:        number;
  track:       "video" | "audio";
  seq:         number;
  file:        string;
  sha256:      string;
  bytes:       number;
}

export type StoreChunkResult =
  | { status: "created" }
  | { status: "exists"; sha256: string }
  | { status: "no_recording" }
  | { status: "closed" };

/** Creates the recording row. Idempotent: `created` is false if it existed. */
export async function createRecording(pool: Pool, args: {
  owner: string; recordingId: string; startedAt: string;
  device: Record<string, unknown>; config: Record<string, unknown>;
}): Promise<{ created: boolean }> {
  const r = await pool.query(
    `INSERT INTO glasses_recordings (owner, recording_id, started_at, device, config)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (owner, recording_id) DO NOTHING`,
    [args.owner, args.recordingId, args.startedAt, args.device, args.config],
  );
  return { created: r.rowCount === 1 };
}

export async function getRecordingState(
  pool: Pool, owner: string, recordingId: string,
): Promise<RecordingState | null> {
  const r = await pool.query<{ state: RecordingState }>(
    `SELECT state FROM glasses_recordings WHERE owner = $1 AND recording_id = $2`,
    [owner, recordingId],
  );
  return r.rows[0]?.state ?? null;
}

/**
 * Records a chunk and runs `place` (moving the file into place) in the same
 * transaction, so a row exists only if its file does. The recording row is
 * share-locked, which serializes chunk writes against `markComplete`.
 */
export async function storeChunk(
  pool: Pool, row: ChunkRow, place: () => Promise<void>,
): Promise<StoreChunkResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rec = await client.query<{ state: RecordingState }>(
      `SELECT state FROM glasses_recordings
       WHERE owner = $1 AND recording_id = $2 FOR SHARE`,
      [row.owner, row.recordingId],
    );
    const state = rec.rows[0]?.state;
    if (state !== "uploading") {
      await client.query("ROLLBACK");
      return { status: state === "complete" ? "closed" : "no_recording" };
    }
    const ins = await client.query(
      `INSERT INTO glasses_chunks (owner, recording_id, part, track, seq, file, sha256, bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING`,
      [row.owner, row.recordingId, row.part, row.track, row.seq, row.file, row.sha256, row.bytes],
    );
    if (ins.rowCount === 1) {
      await place();
      await client.query("COMMIT");
      return { status: "created" };
    }
    const existing = await client.query<{ sha256: string }>(
      `SELECT sha256 FROM glasses_chunks
       WHERE owner = $1 AND recording_id = $2
         AND ((part = $3 AND track = $4 AND seq = $5) OR file = $6)
       LIMIT 1`,
      [row.owner, row.recordingId, row.part, row.track, row.seq, row.file],
    );
    await client.query("ROLLBACK");
    return { status: "exists", sha256: existing.rows[0]!.sha256 };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function listChunkFiles(
  pool: Pool, owner: string, recordingId: string,
): Promise<Set<string>> {
  const r = await pool.query<{ file: string }>(
    `SELECT file FROM glasses_chunks WHERE owner = $1 AND recording_id = $2`,
    [owner, recordingId],
  );
  return new Set(r.rows.map((x) => x.file));
}

export async function markComplete(
  pool: Pool, owner: string, recordingId: string, manifest: unknown,
): Promise<void> {
  await pool.query(
    `UPDATE glasses_recordings
     SET state = 'complete', manifest = $3, completed_at = now()
     WHERE owner = $1 AND recording_id = $2 AND state = 'uploading'`,
    [owner, recordingId, manifest],
  );
}

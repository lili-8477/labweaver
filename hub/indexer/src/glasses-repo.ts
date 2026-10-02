// Postgres access for glasses recordings (migration 0014). The bytes live on
// disk; these rows record what arrived and act as the upload ACK.

import type { Pool } from "pg";

export type RecordingState = "uploading" | "complete" | "processed" | "mux_failed";

export interface FileRow {
  owner:       string;
  recordingId: string;
  name:        string;
  kind:        "init" | "media" | "events" | "manifest";
  track:       "video" | "audio" | null;
  part:        number | null;
  seq:         number | null;
  startMs:     number | null;
  durationMs:  number | null;
  sha256:      string;
  bytes:       number;
}

export type StoreFileResult =
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
 * Records a file and runs `place` (moving it into place) in the same
 * transaction, so a row exists only if its file does. The recording row is
 * share-locked, which serializes file writes against `markComplete`.
 */
export async function storeFile(
  pool: Pool, row: FileRow, place: () => Promise<void>,
): Promise<StoreFileResult> {
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
      return { status: state === undefined ? "no_recording" : "closed" };
    }
    const ins = await client.query(
      `INSERT INTO glasses_files (owner, recording_id, name, kind, track, part, seq,
                                  start_ms, duration_ms, sha256, bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT DO NOTHING`,
      [row.owner, row.recordingId, row.name, row.kind, row.track, row.part, row.seq,
       row.startMs, row.durationMs, row.sha256, row.bytes],
    );
    if (ins.rowCount === 1) {
      await place();
      await client.query("COMMIT");
      return { status: "created" };
    }
    const existing = await client.query<{ sha256: string }>(
      `SELECT sha256 FROM glasses_files WHERE owner = $1 AND recording_id = $2 AND name = $3`,
      [row.owner, row.recordingId, row.name],
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

export async function listFileNames(
  pool: Pool, owner: string, recordingId: string,
): Promise<Set<string>> {
  const r = await pool.query<{ name: string }>(
    `SELECT name FROM glasses_files WHERE owner = $1 AND recording_id = $2`,
    [owner, recordingId],
  );
  return new Set(r.rows.map((x) => x.name));
}

export async function markComplete(pool: Pool, args: {
  owner: string; recordingId: string; manifest: unknown;
  durationMs: number | null; endedAt: string | null;
}): Promise<void> {
  await pool.query(
    `UPDATE glasses_recordings
     SET state = 'complete', manifest = $3, duration_ms = $4, ended_at = $5, completed_at = now()
     WHERE owner = $1 AND recording_id = $2 AND state = 'uploading'`,
    [args.owner, args.recordingId, args.manifest, args.durationMs, args.endedAt],
  );
}

// ─── Muxing (migration 0015) ────────────────────────────────────────────────

export interface MuxCandidate {
  owner:       string;
  recordingId: string;
  manifest:    unknown;
}

export interface PartRow {
  part:       number;
  file:       string;
  bytes:      number;
  durationMs: number | null;
  width:      number | null;
  height:     number | null;
  hasAudio:   boolean;
  startMs:    number | null;
  endMs:      number | null;
}

/** Oldest completed recording that has not been muxed yet. */
export async function nextRecordingToMux(pool: Pool): Promise<MuxCandidate | null> {
  const r = await pool.query<{ owner: string; recording_id: string; manifest: unknown }>(
    `SELECT owner, recording_id, manifest FROM glasses_recordings
     WHERE state = 'complete' ORDER BY completed_at LIMIT 1`,
  );
  const row = r.rows[0];
  return row ? { owner: row.owner, recordingId: row.recording_id, manifest: row.manifest } : null;
}

/** Replaces the recording's part rows and marks it processed. */
export async function saveMuxResult(
  pool: Pool, owner: string, recordingId: string, parts: PartRow[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM glasses_parts WHERE owner = $1 AND recording_id = $2`, [owner, recordingId]);
    for (const p of parts) {
      await client.query(
        `INSERT INTO glasses_parts (owner, recording_id, part, file, bytes, duration_ms,
                                    width, height, has_audio, start_ms, end_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [owner, recordingId, p.part, p.file, p.bytes, p.durationMs, p.width, p.height,
         p.hasAudio, p.startMs, p.endMs],
      );
    }
    await client.query(
      `UPDATE glasses_recordings SET state = 'processed', mux_error = NULL, processed_at = now()
       WHERE owner = $1 AND recording_id = $2`,
      [owner, recordingId],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function markMuxFailed(
  pool: Pool, owner: string, recordingId: string, error: string,
): Promise<void> {
  await pool.query(
    `UPDATE glasses_recordings SET state = 'mux_failed', mux_error = $3, processed_at = now()
     WHERE owner = $1 AND recording_id = $2`,
    [owner, recordingId, error],
  );
}

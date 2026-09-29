-- 0015_glasses_mux.sql
-- Server-side muxing of completed glasses recordings (glasses-mux.ts):
-- each media part becomes muxed/pNNN.mp4. State machine:
--   uploading → complete → processed | mux_failed
-- A mux_failed recording is retried by setting its state back to 'complete'.

ALTER TABLE glasses_recordings DROP CONSTRAINT glasses_recordings_state_check;
ALTER TABLE glasses_recordings ADD CONSTRAINT glasses_recordings_state_check
  CHECK (state IN ('uploading', 'complete', 'processed', 'mux_failed'));
ALTER TABLE glasses_recordings
  ADD COLUMN mux_error    TEXT,
  ADD COLUMN processed_at TIMESTAMPTZ;

CREATE INDEX glasses_recordings_to_mux_idx
  ON glasses_recordings (completed_at) WHERE state = 'complete';

-- One row per muxed part. start_ms/end_ms come from the manifest (ms since
-- recording start, host clock), so parts can be placed on the timeline.
CREATE TABLE glasses_parts (
  owner         TEXT NOT NULL,
  recording_id  TEXT NOT NULL,
  part          INT  NOT NULL,
  file          TEXT NOT NULL,
  bytes         BIGINT NOT NULL,
  duration_ms   BIGINT,
  width         INT,
  height        INT,
  has_audio     BOOLEAN NOT NULL,
  start_ms      BIGINT,
  end_ms        BIGINT,
  PRIMARY KEY (owner, recording_id, part),
  FOREIGN KEY (owner, recording_id)
    REFERENCES glasses_recordings (owner, recording_id) ON DELETE CASCADE
);

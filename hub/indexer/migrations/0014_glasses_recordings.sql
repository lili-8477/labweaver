-- 0014_glasses_recordings.sql
-- Recordings uploaded by the LabWeaver Glasses iOS app (contract:
-- docs/UPLOAD_API.md in lili-8477/labweaver-glasses). Rows only: the bytes
-- live on disk under RECORDINGS_ROOT/<owner>/<recording_id>/<name>.
--
-- recording_id is the app's localId, scoped by owner.

CREATE TABLE glasses_recordings (
  owner         TEXT NOT NULL,
  recording_id  TEXT NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL,
  device        JSONB NOT NULL DEFAULT '{}'::jsonb,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  state         TEXT NOT NULL DEFAULT 'uploading'
                CHECK (state IN ('uploading', 'complete')),
  manifest      JSONB,
  duration_ms   BIGINT,
  ended_at      TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ,
  PRIMARY KEY (owner, recording_id)
);

-- One row per received file. A row exists only once its file is on disk
-- (inserted in the same transaction as the rename), so it is the upload ACK.
-- track/part/seq/start_ms/duration_ms are the phone's X-File-* headers.
CREATE TABLE glasses_files (
  owner         TEXT NOT NULL,
  recording_id  TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('init', 'media', 'events', 'manifest')),
  track         TEXT CHECK (track IN ('video', 'audio')),
  part          INT,
  seq           INT,
  start_ms      BIGINT,
  duration_ms   BIGINT,
  sha256        TEXT NOT NULL,
  bytes         BIGINT NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, recording_id, name),
  FOREIGN KEY (owner, recording_id)
    REFERENCES glasses_recordings (owner, recording_id) ON DELETE CASCADE
);

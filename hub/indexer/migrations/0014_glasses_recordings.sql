-- 0014_glasses_recordings.sql
-- Recordings uploaded by the LabWeaver Glasses iOS app (contract: DESIGN.md §7
-- in lili-8477/labweaver-glasses). Rows only: the media bytes live on disk
-- under RECORDINGS_ROOT/<owner>/<recording_id>/, named as on the phone.
--
-- recording_id is the app's local id (yyyyMMdd-HHmmss-xxxx), scoped by owner.

CREATE TABLE glasses_recordings (
  owner         TEXT NOT NULL,
  recording_id  TEXT NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL,
  device        JSONB NOT NULL DEFAULT '{}'::jsonb,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  state         TEXT NOT NULL DEFAULT 'uploading'
                CHECK (state IN ('uploading', 'complete')),
  manifest      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ,
  PRIMARY KEY (owner, recording_id)
);

-- One row per received file. A row exists only once its file is on disk
-- (inserted in the same transaction as the rename), so it is the upload ACK.
CREATE TABLE glasses_chunks (
  owner         TEXT NOT NULL,
  recording_id  TEXT NOT NULL,
  part          INT  NOT NULL CHECK (part >= 1),
  track         TEXT NOT NULL CHECK (track IN ('video', 'audio')),
  seq           INT  NOT NULL CHECK (seq >= 0),
  file          TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  bytes         BIGINT NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, recording_id, part, track, seq),
  -- The file name is derived from the key; this also stops a client bug that
  -- sends one media seq under two parts from overwriting the other's file.
  UNIQUE (owner, recording_id, file),
  FOREIGN KEY (owner, recording_id)
    REFERENCES glasses_recordings (owner, recording_id) ON DELETE CASCADE
);

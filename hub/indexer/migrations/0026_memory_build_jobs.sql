-- Memory builder jobs: one row per build of a file, folder or website. The
-- member's adapter runs the job and reports progress here (memory-build-jobs.ts).
CREATE TABLE memory_build_jobs (
  job_id          UUID PRIMARY KEY,
  username        TEXT NOT NULL,
  project_dir     TEXT,
  origin_kind     TEXT NOT NULL CHECK (origin_kind IN ('file', 'folder', 'website')),
  origin          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  files_seen      INT  NOT NULL DEFAULT 0,
  files_parsed    INT  NOT NULL DEFAULT 0,
  files_skipped   INT  NOT NULL DEFAULT 0,
  entries_created INT  NOT NULL DEFAULT 0,
  duplicates      INT  NOT NULL DEFAULT 0,
  report          JSONB NOT NULL DEFAULT '{}'::jsonb,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);

CREATE INDEX memory_build_jobs_user_idx ON memory_build_jobs (username, created_at DESC);

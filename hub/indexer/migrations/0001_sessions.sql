CREATE TABLE sessions (
  session_id          UUID PRIMARY KEY,
  username            TEXT NOT NULL,
  parent_session_id   UUID,
  encoded_project_dir TEXT NOT NULL,
  project_display     TEXT,
  title               TEXT,
  model               TEXT,
  message_count       INT  NOT NULL DEFAULT 0,
  token_usage         JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_active        TIMESTAMPTZ,
  last_active         TIMESTAMPTZ,
  jsonl_location      TEXT NOT NULL DEFAULT 'volume',
  status              TEXT NOT NULL DEFAULT 'active',
  is_sidechain        BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX sessions_username_last_active_idx
  ON sessions (username, last_active DESC);

CREATE INDEX sessions_username_project_last_active_idx
  ON sessions (username, encoded_project_dir, last_active DESC);

CREATE INDEX sessions_parent_idx
  ON sessions (parent_session_id) WHERE parent_session_id IS NOT NULL;

CREATE INDEX sessions_status_last_active_idx
  ON sessions (status, last_active) WHERE status = 'active';

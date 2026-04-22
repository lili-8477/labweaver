CREATE TABLE token_usage_log (
  id                  BIGSERIAL PRIMARY KEY,
  username            TEXT NOT NULL,
  session_id          UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  entry_uuid          UUID NOT NULL,
  model               TEXT,
  input_tokens        INT  NOT NULL DEFAULT 0,
  output_tokens       INT  NOT NULL DEFAULT 0,
  cache_read_tokens   INT  NOT NULL DEFAULT 0,
  cache_write_tokens  INT  NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL,
  UNIQUE (session_id, entry_uuid)
);

CREATE INDEX token_usage_log_username_created_idx
  ON token_usage_log (username, created_at);

CREATE INDEX token_usage_log_session_idx
  ON token_usage_log (session_id, created_at);

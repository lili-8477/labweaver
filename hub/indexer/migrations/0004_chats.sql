CREATE TABLE chats (
  chat_id        UUID PRIMARY KEY,
  username       TEXT NOT NULL,
  session_id     UUID,
  name           TEXT NOT NULL DEFAULT 'New chat',
  active_agent   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);

CREATE INDEX chats_username_last_used_idx
  ON chats (username, last_used_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX chats_session_id_idx
  ON chats (session_id) WHERE session_id IS NOT NULL;

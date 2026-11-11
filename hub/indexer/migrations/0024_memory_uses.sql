-- Memory uses (GLOSSARY.md: Outcome loop): each time the agent opens a memory,
-- so a later step outcome (an Auto-mode review verdict) can be credited to
-- the memories that informed the work.
CREATE TABLE memory_uses (
  username  TEXT        NOT NULL,
  memory_id UUID        NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
  used_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX memory_uses_user_time_idx ON memory_uses (username, used_at);

CREATE TABLE memory_facets (
  memory_id   UUID NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  PRIMARY KEY (memory_id, key, value)
);

CREATE INDEX memory_facets_kv_idx ON memory_facets (key, value);

CREATE TABLE embedder_queue (
  chunk_id    BIGINT PRIMARY KEY REFERENCES memory_chunks(chunk_id) ON DELETE CASCADE,
  attempts    INT NOT NULL DEFAULT 0,
  last_error  TEXT,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memory_distill_cursor (
  username                       TEXT PRIMARY KEY,
  last_seen_session_last_active  TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01'::timestamptz
);

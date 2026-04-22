CREATE TABLE file_offsets (
  username     TEXT NOT NULL,
  jsonl_path   TEXT NOT NULL,
  byte_offset  BIGINT NOT NULL,
  inode        BIGINT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (username, jsonl_path)
);

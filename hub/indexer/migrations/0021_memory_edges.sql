-- Typed lineage between memory rows, read as `src rel dst`
-- (e.g. new SUPERSEDES old, experience DERIVED_FROM claim). Spec §4.3.
CREATE TABLE memory_edges (
  src_id     UUID NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
  dst_id     UUID NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
  rel        TEXT NOT NULL CHECK (rel IN (
               'DERIVED_FROM','SUPPORTS','QUALIFIES','CONTRADICTS',
               'SUPERSEDES','RETRACTS','VALIDATED_BY','FAILED_TO_REPLICATE')),
  status     TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','rejected')),
  actor      TEXT NOT NULL,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (src_id, dst_id, rel),
  CHECK (src_id <> dst_id)
);
CREATE INDEX memory_edges_dst_idx ON memory_edges (dst_id, rel);

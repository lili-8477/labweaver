-- Evidence a memory cites (spec §4.4). Immutable; not embedded.
CREATE TABLE evidence_assets (
  evidence_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uri          TEXT NOT NULL,
  sha256       BYTEA,
  modality     TEXT NOT NULL CHECK (modality IN
                 ('transcript','tool_output','file','image','video','notebook','instrument_run','table')),
  locator      JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at  TIMESTAMPTZ,
  actor        TEXT NOT NULL,
  access_class TEXT NOT NULL DEFAULT 'internal' CHECK (access_class IN
                 ('public','internal','restricted','irb')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (uri, sha256)
);

CREATE TABLE memory_evidence (
  memory_id   UUID NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
  evidence_id UUID NOT NULL REFERENCES evidence_assets(evidence_id),
  role        TEXT NOT NULL DEFAULT 'source' CHECK (role IN ('source','input','output','qc')),
  PRIMARY KEY (memory_id, evidence_id, role)
);
CREATE INDEX memory_evidence_evidence_idx ON memory_evidence (evidence_id);

-- Backfill: each transcript entry a distilled memory came from becomes a
-- transcript:// evidence row. source_entry_uuids itself is left unchanged.
INSERT INTO evidence_assets (uri, modality, locator, actor)
SELECT DISTINCT 'transcript://' || m.source_session_id || '/' || e.uuid,
       'transcript',
       jsonb_build_object('session_id', m.source_session_id, 'entry_uuid', e.uuid),
       m.username
  FROM memories m, jsonb_array_elements_text(m.source_entry_uuids) AS e(uuid)
 WHERE m.source_session_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO memory_evidence (memory_id, evidence_id)
SELECT m.memory_id, a.evidence_id
  FROM memories m
  CROSS JOIN LATERAL jsonb_array_elements_text(m.source_entry_uuids) AS e(uuid)
  JOIN evidence_assets a
    ON a.uri = 'transcript://' || m.source_session_id || '/' || e.uuid AND a.sha256 IS NULL
 WHERE m.source_session_id IS NOT NULL
ON CONFLICT DO NOTHING;

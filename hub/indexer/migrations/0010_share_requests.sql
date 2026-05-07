-- 0010_share_requests.sql
-- Share-to-org promotion queue. One row per submission. State machine:
--   pending → approved | rejected | withdrawn (terminal).
-- Frozen JSONB snapshot at submission time so manager reviews what was
-- submitted, not whatever the source looks like at decision time.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE share_requests (
  share_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_kind    TEXT NOT NULL CHECK (artifact_kind IN ('memory', 'skill', 'folder')),
  artifact_ref     TEXT NOT NULL,
  snapshot_meta    JSONB NOT NULL,
  requester        TEXT NOT NULL,
  reviewer         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  requester_note   TEXT,
  review_comment   TEXT,
  promotion_result JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at       TIMESTAMPTZ
);

CREATE INDEX share_requests_status_created_idx
  ON share_requests (status, created_at DESC);

CREATE INDEX share_requests_requester_idx
  ON share_requests (requester, created_at DESC);

CREATE INDEX share_requests_reviewer_pending_idx
  ON share_requests (reviewer, created_at DESC)
  WHERE status = 'pending';

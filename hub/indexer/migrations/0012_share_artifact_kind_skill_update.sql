-- 0012_share_artifact_kind_skill_update.sql
-- Add 'skill_update' to share_requests.artifact_kind. Distinct from 'skill'
-- so we can tell apart "new skill install" from "atomic replace of an existing
-- org skill". See phase-4 update-existing-skill plan.

ALTER TABLE share_requests
  DROP CONSTRAINT share_requests_artifact_kind_check;

ALTER TABLE share_requests
  ADD CONSTRAINT share_requests_artifact_kind_check
  CHECK (artifact_kind IN ('memory', 'skill', 'folder', 'skill_update'));

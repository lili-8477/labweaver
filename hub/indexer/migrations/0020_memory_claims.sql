-- Scientific memory, phase 1 (docs/superpowers/specs/2026-10-17-scientific-memory-design.md §4.1).
-- Claims and experiences are ordinary memory rows: their typed fields live in
-- attrs (validated by zod in src/science.ts), their conditions in memory_facets.
ALTER TABLE memories DROP CONSTRAINT memories_type_check;
ALTER TABLE memories ADD CONSTRAINT memories_type_check CHECK (type IN (
  'user','feedback','project','reference','session_summary','observation',
  'claim','experience'));

ALTER TABLE memories
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN
    ('active','proposed','superseded','retracted','shadowed')),
  ADD COLUMN claim_kind TEXT CHECK (claim_kind IN
    ('run','observation','result','interpretation','decision','feedback')),
  ADD COLUMN confidence REAL CHECK (confidence BETWEEN 0 AND 1),
  ADD COLUMN validation_level TEXT CHECK (validation_level IN
    ('anecdotal','repeated','replicated','reviewed')),
  ADD COLUMN observed_at TIMESTAMPTZ,
  ADD COLUMN valid_from  TIMESTAMPTZ,
  ADD COLUMN valid_to    TIMESTAMPTZ,
  ADD COLUMN access_class TEXT NOT NULL DEFAULT 'internal' CHECK (access_class IN
    ('public','internal','restricted','irb')),
  ADD COLUMN condition_key BYTEA,
  ADD COLUMN attrs JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX memories_condition_idx ON memories (username, project_dir, condition_key)
  WHERE condition_key IS NOT NULL AND status = 'active' AND deleted_at IS NULL;

-- Status changes on immutable claims are audited like any other change.
ALTER TABLE memory_audit_log DROP CONSTRAINT memory_audit_log_action_check;
ALTER TABLE memory_audit_log ADD CONSTRAINT memory_audit_log_action_check
  CHECK (action IN ('write', 'update', 'forget', 'restore', 'merge', 'status'));

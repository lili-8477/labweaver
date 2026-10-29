-- Memory directories: an OpenViking-style folder tree kept in Postgres.
--
-- A fixed catalogue of 9 directories, 3 per scope. Every memory lives in
-- exactly one directory. A directory instance is implicit: the owner's
-- (username, project_dir) plus dir_key, so no per-owner rows exist.
-- L0 is the static `l0` line below; L1 (top entries) is computed at read
-- time in memory-repo.ts; L2 is the memory body. `path` is the last segment
-- of dir_key.
CREATE TABLE memory_dirs (
  dir_key TEXT PRIMARY KEY,
  scope   TEXT NOT NULL CHECK (scope IN ('user', 'project', 'org')),
  path    TEXT NOT NULL,
  l0      TEXT NOT NULL,
  sort    INT  NOT NULL,
  UNIQUE (dir_key, scope)
);

INSERT INTO memory_dirs (dir_key, scope, path, l0, sort) VALUES
  ('project/entities',     'project', 'entities',     'Datasets, samples and pipelines used in this project',          10),
  ('project/trajectories', 'project', 'trajectories', 'Session summaries and execution trajectories for this project', 20),
  ('project/decisions',    'project', 'decisions',    'Decisions and findings, with dates and evidence',               30),
  ('org/entities',         'org',     'entities',     'Lab-standard entities: reference genomes, standard pipelines',  40),
  ('org/experience',       'org',     'experience',   'Reviewed, reusable lab practices',                              50),
  ('org/references',       'org',     'references',   'Papers, documentation and conventions',                         60),
  ('user/preferences',     'user',    'preferences',  'Working habits, preferences and corrections',                   70),
  ('user/experience',      'user',    'experience',   'Personal practices not yet reviewed for the lab',               80),
  ('user/notes',           'user',    'notes',        'Personal notes and references',                                 90);

-- Scope was re-derived by a CASE in every query; store it so the directory
-- FK below can require directory and memory to agree on scope.
ALTER TABLE memories ADD COLUMN scope TEXT GENERATED ALWAYS AS (
  CASE
    WHEN username = '__org__' THEN 'org'
    WHEN project_dir IS NULL  THEN 'user'
    ELSE 'project'
  END
) STORED;

ALTER TABLE memories ADD COLUMN dir_key TEXT;

-- Backfill every existing row, soft-deleted ones included. Must match
-- defaultDir() in src/memory-dirs.ts.
UPDATE memories SET dir_key = scope || '/' || CASE scope
  WHEN 'project' THEN CASE type
    WHEN 'reference'       THEN 'entities'
    WHEN 'session_summary' THEN 'trajectories'
    ELSE 'decisions' END
  WHEN 'user' THEN CASE type
    WHEN 'user'        THEN 'preferences'
    WHEN 'feedback'    THEN 'preferences'
    WHEN 'observation' THEN 'experience'
    ELSE 'notes' END
  ELSE CASE type
    WHEN 'project'         THEN 'entities'
    WHEN 'reference'       THEN 'references'
    WHEN 'session_summary' THEN 'references'
    ELSE 'experience' END
END;

ALTER TABLE memories ALTER COLUMN dir_key SET NOT NULL;
ALTER TABLE memories ADD CONSTRAINT memories_dir_fk
  FOREIGN KEY (dir_key, scope) REFERENCES memory_dirs (dir_key, scope);

CREATE INDEX memories_dir_idx
  ON memories (username, project_dir, dir_key) WHERE deleted_at IS NULL;

-- Merge-on-write folds a near-duplicate into an existing row; audit it as
-- 'merge' so merges count separately from edits.
ALTER TABLE memory_audit_log DROP CONSTRAINT memory_audit_log_action_check;
ALTER TABLE memory_audit_log ADD CONSTRAINT memory_audit_log_action_check
  CHECK (action IN ('write', 'update', 'forget', 'restore', 'merge'));

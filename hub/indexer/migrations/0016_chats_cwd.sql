-- The absolute cwd a chat's Claude Code session started in (e.g.
-- "/workspace/local_projects/foo-1a2b"). Claude Code files transcripts under
-- ~/.claude/projects/<encoded cwd>/, so resume and history reads must keep
-- using the cwd the session began with, even if project_dir changes later.
-- Written together with session_id on the first turn. NULL = a chat from
-- before this column, whose session ran in the default cwd (/workspace).

ALTER TABLE chats ADD COLUMN cwd TEXT;

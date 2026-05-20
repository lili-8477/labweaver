-- Bind a chat to its project directory (workspace-relative, e.g.
-- "local_projects/foo-1a2b"). Set explicitly at drop-to-project time, or
-- implicitly later when tick-bootstrap creates the dir for a typed-prompt
-- chat. Nullable: chats that never spawn a project stay free-floating.
--
-- Used for two things:
--   1. Agent cwd — runTurn() cd's here for project-bound chats so the
--      agent's relative paths resolve where the user expects.
--   2. progress.md lookup — get_harness_progress reads <project_dir>/progress.md
--      directly instead of guessing via chat-name heuristics. Cross-session
--      leakage from the "most-recently-modified" fallback goes away.

ALTER TABLE chats ADD COLUMN project_dir TEXT;

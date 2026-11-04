-- Memory domain (GLOSSARY.md): lab knowledge a scientist reads in the UI, or
-- technical know-how (code, tools, environment) only the agent uses. The
-- writer sets it. Backfill: Auto-mode review verdicts (type 'project' rows in
-- a trajectories directory) are the agent's own process records. Session
-- summaries there describe the science, so they stay lab.
ALTER TABLE memories
  ADD COLUMN domain TEXT NOT NULL DEFAULT 'lab' CHECK (domain IN ('lab', 'technical'));
UPDATE memories SET domain = 'technical' WHERE dir_key LIKE '%/trajectories' AND type = 'project';

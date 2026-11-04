-- Outcome loop (GLOSSARY.md): memories rank by how the tasks that used them
-- went. A task outcome credits the memories the agent opened for it.
ALTER TABLE memories
  ADD COLUMN success_count INT NOT NULL DEFAULT 0,
  ADD COLUMN failure_count INT NOT NULL DEFAULT 0;

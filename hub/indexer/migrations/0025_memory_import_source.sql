-- The memory builder (docs/superpowers/specs/2026-11-09-memory-builder-plugin-design.md):
-- imported rows carry source 'import', and each import category gets a
-- directory per scope (memory-import.ts importDir). The 'reference' category
-- files under each scope's existing reference directory.
ALTER TABLE memories DROP CONSTRAINT memories_source_check;
ALTER TABLE memories ADD CONSTRAINT memories_source_check CHECK (source IN ('user','distilled','import'));

-- Category directories are listed only once they hold entries, so members
-- who never import see the same nine directories as before.
ALTER TABLE memory_dirs ADD COLUMN hide_empty BOOLEAN NOT NULL DEFAULT false;

INSERT INTO memory_dirs (dir_key, scope, path, l0, sort, hide_empty) VALUES
  ('project/protocols',    'project', 'protocols',    'Protocols and SOPs imported into this project',              31, true),
  ('project/inventories',  'project', 'inventories',  'Reagents, lines and stocks imported into this project',      32, true),
  ('project/data-records', 'project', 'data-records', 'Sequencing orders and data records for this project',        33, true),
  ('project/pipelines',    'project', 'pipelines',    'Pipelines, QC and scripts imported into this project',       34, true),
  ('org/protocols',        'org',     'protocols',    'Lab protocols and SOPs',                                     61, true),
  ('org/inventories',      'org',     'inventories',  'Lab inventory: reagents, mouse lines, cell lines',           62, true),
  ('org/data-records',     'org',     'data-records', 'Lab sequencing orders and data records',                     63, true),
  ('org/pipelines',        'org',     'pipelines',    'Lab pipelines, QC and scripts',                              64, true),
  ('user/protocols',       'user',    'protocols',    'Protocols you imported',                                     91, true),
  ('user/inventories',     'user',    'inventories',  'Inventory lists you imported',                               92, true),
  ('user/data-records',    'user',    'data-records', 'Data records you imported',                                  93, true),
  ('user/pipelines',       'user',    'pipelines',    'Pipelines and scripts you imported',                         94, true);

-- Imported inventory rows and data records are found by keywords and exact
-- IDs only (memory-import.ts KEYWORD_ONLY): drop their embeddings and any
-- queued embedding, so they stop matching unrelated meaning searches. A later
-- re-embed migration (like 0026) must skip these rows.
UPDATE memory_chunks c SET embedding = NULL
  FROM memories m JOIN memory_facets f ON f.memory_id = m.memory_id
 WHERE c.memory_id = m.memory_id AND m.source = 'import'
   AND f.key = 'category' AND f.value IN ('inventory', 'data_record');
DELETE FROM embedder_queue q
 USING memory_chunks c, memories m, memory_facets f
 WHERE q.chunk_id = c.chunk_id AND c.memory_id = m.memory_id AND f.memory_id = m.memory_id
   AND m.source = 'import' AND f.key = 'category' AND f.value IN ('inventory', 'data_record');

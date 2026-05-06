# /forget — soft-delete a memory by id

Remove a memory the user no longer wants surfaced.

## Procedure

1. Treat `$ARGUMENTS` as a single `memory_id`. Trim whitespace.
2. Call the MCP tool `memory_forget` (server: `bioflow-memory`) with that id.
3. Print one line of confirmation: `forgot <memory_id>` on success, or the error verbatim on failure.

`memory_forget` is a soft-delete (sets `deleted_at`); the row is preserved server-side for audit but will not appear in future `memory_search` results.

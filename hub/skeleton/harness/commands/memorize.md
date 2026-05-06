# /memorize — pin a fact to long-term memory

Persist the user's text to long-term memory using the bioflow-memory MCP server.

## Procedure

1. Treat `$ARGUMENTS` (everything after `/memorize`) as the memory body verbatim.
2. Call the MCP tool `memory_write` (server: `bioflow-memory`) with:
   - `body` — the full `$ARGUMENTS` text.
   - `name` — derived from the first line of the body (≤80 chars; trim, drop trailing punctuation).
   - `description` — a one-sentence paraphrase of the body (≤200 chars). If the body is already short, reuse the first line.
   - `scope` — default `"user"`. Use `"project"` only if the user explicitly says "for this project" or the text obviously refers to the current working directory.
   - `type` — infer from context. Most often `"user"` (a fact the user wants remembered) or `"feedback"` (a correction or stylistic preference). Use `"decision"` only if the user is recording an architectural call.
3. Report back the returned `memory_id` in one line so the user can `/forget <id>` if needed.

Do not paraphrase or summarize the body before writing — the user picked the wording deliberately.

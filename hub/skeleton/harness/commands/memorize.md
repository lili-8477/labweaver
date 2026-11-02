# /memorize — pin a fact to long-term memory

Persist the user's text to long-term memory using the bioflow-memory MCP server.

## Procedure

1. Treat `$ARGUMENTS` (everything after `/memorize`) as the memory body verbatim.
2. Call the MCP tool `memory_write` (server: `bioflow-memory`) with:
   - `body` — the full `$ARGUMENTS` text.
   - `name` — derived from the first line of the body (≤80 chars; trim, drop trailing punctuation).
   - `description` — a one-sentence paraphrase of the body (≤200 chars). If the body is already short, reuse the first line.
   - `scope` — default `"user"`. Use `"project"` only if the user explicitly says "for this project" or the text obviously refers to the current working directory.
   - `type` — one of `"user"` (a fact the user wants remembered), `"feedback"` (a correction or stylistic preference), `"project"` or `"reference"`. Most often `"user"` or `"feedback"`.
   - `dir_key` — the directory it belongs in. For `scope: "user"`: `user/preferences` (habits, preferences, corrections), `user/experience` (personal practices), `user/notes` (notes and references). For `scope: "project"`: `project/decisions` (decisions and findings — e.g. an architectural call), `project/entities` (datasets, samples, pipelines), `project/trajectories` (session summaries). Omitted, it defaults from `type`.
3. Report back the returned `memory_id` in one line so the user can `/forget <id>` if needed. If the result says `merged: true`, say it updated an existing memory rather than adding a new one.

Keep the body under 4000 characters; the API rejects longer ones.

Do not paraphrase or summarize the body before writing — the user picked the wording deliberately.

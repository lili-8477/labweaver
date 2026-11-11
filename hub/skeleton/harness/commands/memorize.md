# /memorize — pin a fact to long-term memory

Persist the user's text to long-term memory using the bioflow-memory MCP server.

## Procedure

1. Treat `$ARGUMENTS` (everything after `/memorize`) as the memory body verbatim.
2. Call the MCP tool `memory_write` (server: `bioflow-memory`) with:
   - `body` — the full `$ARGUMENTS` text.
   - `name` — derived from the first line of the body (≤80 chars; trim, drop trailing punctuation).
   - `description` — a one-sentence paraphrase of the body (≤200 chars). If the body is already short, reuse the first line.
   - `scope` — default `"user"`. Use `"project"` only if the user explicitly says "for this project" or the text obviously refers to the current working directory.
   - `type` — infer from context: `"user"` (a fact the user wants remembered), `"feedback"` (a correction or stylistic preference), `"project"` (a project decision or finding), or `"reference"` (a pointer to a dataset, paper or doc).
   - `domain` — `"lab"` unless the text is purely about software (code, packages, environment, tool errors): then `"technical"`. Only lab memories appear in the user's memory panel.
   - `dir` — omit; the memory is filed by scope and type. Pass `"project/decisions"` (with `scope: "project"`) only when the user is recording a decision for this project.
3. If the result has a `memory_id`, report it in one line so the user can `/forget <id>` if needed.
4. If instead it has `similar` matches, a near-duplicate already exists. Show the user the closest match (name + body) and ask: merge or keep both? Merge → call `memory_merge` on that match with a body that keeps every fact from both. Keep both → re-call `memory_write` with `force_new: true`.

Do not paraphrase or summarize the body before writing — the user picked the wording deliberately.

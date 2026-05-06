# /recall — search long-term memory inline

Force a memory lookup before answering anything else.

## Procedure

1. Call the MCP tool `memory_search` (server: `bioflow-memory`) with `query = $ARGUMENTS`.
2. Take the top 5 results (the server already ranks by hybrid score).
3. Print each result on its own line as `- [<memory_id>] <name> — <description>`. Keep the list compact; no extra prose between entries.
4. If zero results come back, say "no matching memories" and stop.

This command is the user's "look at memory before responding" lever. Do not skip the tool call even if you think you already know the answer.

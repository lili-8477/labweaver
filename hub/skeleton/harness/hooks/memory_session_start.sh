#!/usr/bin/env bash
set -euo pipefail

# Skip if memory disabled (e.g. tests) or API unreachable
[ "${MEMORY_ENABLED:-1}" = "1" ] || exit 0
[ -n "${MEMORY_API_URL:-}" ] || exit 0

# Pass the raw project path; memory-api encodes it server-side using the
# helper from Phase 1 (hub/indexer/src/path-decode.ts), so the encoding
# scheme stays in one place. Never block session start on a hiccup.
curl -fsS --max-time 3 -G \
  --data-urlencode "username=${USERNAME}" \
  --data-urlencode "project_path=${CLAUDE_PROJECT_DIR:-/workspace}" \
  --data-urlencode "budget_tokens=2000" \
  "${MEMORY_API_URL}/memory/context" \
  | jq -r '.system_prompt' || true

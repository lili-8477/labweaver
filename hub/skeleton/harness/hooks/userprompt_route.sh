#!/usr/bin/env bash
# UserPromptSubmit hook. Two independent responsibilities:
#
#   1. Drain ~/.claude/.chpc_pending if non-empty: emit any CHPC job
#      terminal-state notifications as additional context so the agent sees
#      them prepended to the user's prompt this turn. Runs for every prompt,
#      slash commands included: the agent should never miss a job-status event.
#
#   2. Memory recall: for task-like prompts (not slash commands, not short
#      chat), search memory and inject the top hits' one-line summaries.
#
# Auto mode does not route through here: the adapter starts auto turns as
# /tick and drives them (adapter/src/auto-mode.ts), and /tick is a slash
# command, so recall skips it.
set -uo pipefail

LOG="$HOME/.claude/.harness_active.log"
log() { printf '%s userprompt_route %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

INBOX="${CHPC_INBOX:-$HOME/.claude/.chpc_pending}"

# Read the JSON envelope from stdin once; extract the prompt and the session's
# cwd (the adapter pins CLAUDE_PROJECT_DIR to /workspace even when a chat runs
# in a project dir).
INPUT="$(cat)"
field() { printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get(sys.argv[1],""), end="")
except Exception:
    pass' "$1" 2>/dev/null || true; }
PROMPT="$(field prompt)"
CWD="$(field cwd)"

# ── 1. Drain CHPC notifications ──────────────────────────────────────
# Atomic rotate: move to a tmpfile so a watcher writing right now doesn't
# race the read. Anything written after the rename lands in a fresh INBOX
# and surfaces on the *next* prompt.
if [[ -s "$INBOX" ]]; then
  drained="${INBOX}.draining.$$"
  if mv "$INBOX" "$drained" 2>/dev/null; then
    log "drain: $(wc -l < "$drained" | tr -d ' ') notification(s)"
    printf '[CHPC job watcher — events since your last prompt]\n\n'
    python3 - "$drained" <<'PY' || cat "$drained"
import json, sys, pathlib
p = pathlib.Path(sys.argv[1])
for raw in p.read_text().splitlines():
    raw = raw.strip()
    if not raw:
        continue
    try:
        d = json.loads(raw)
    except Exception:
        print(f"- {raw}")
        continue
    jid = d.get("jobid", "?")
    step = d.get("step", "?")
    state = d.get("state", "?")
    elapsed = d.get("elapsed", "?")
    exitc = d.get("exit", "?")
    ts = d.get("ts", "")
    note = d.get("note", "") or ""
    extra = f" ({note})" if note else ""
    print(f"- job {jid} [{step}] -> {state}  elapsed={elapsed} exit={exitc}  at {ts}{extra}")
PY
    printf '\n'
    printf 'Before continuing with the user message, check each job: read its log/output, '
    printf 'note success or failure, and surface anything the user should know. '
    printf 'If a job FAILED/TIMEOUT/OOM, name that explicitly in your reply.\n\n'
    rm -f "$drained"
  fi
fi

# ── 2. Memory recall ─────────────────────────────────────────────────
# Slash commands and short chat ("ok", "thanks", "继续") don't need memory.
# Anything else gets the top hits' L0 lines; the agent reads more with
# memory_get. Never blocks or fails the prompt.
if [[ "${MEMORY_ENABLED:-1}" = "1" && -n "${MEMORY_API_URL:-}" && "$PROMPT" != /* ]]; then
  python3 - "$PROMPT" "${CWD:-${CLAUDE_PROJECT_DIR:-/workspace}}" <<'PY' || true
import json, os, sys, urllib.request
prompt = sys.argv[1].strip()
if len(prompt) < 12:
    sys.exit(0)
body = json.dumps({
    "username": os.environ.get("USERNAME", ""),
    "project_path": sys.argv[2],
    "query": prompt[:500],
    "limit": 3,
}).encode()
req = urllib.request.Request(
    os.environ["MEMORY_API_URL"] + "/memory/search", data=body,
    headers={"content-type": "application/json",
             **({"authorization": "Bearer " + os.environ["SERVICE_ID"]} if os.environ.get("SERVICE_ID") else {})},
)
try:
    hits = json.load(urllib.request.urlopen(req, timeout=2))
except Exception:
    sys.exit(0)
if not hits:
    sys.exit(0)
print("[Memory recall — possibly relevant; read with memory_get(id) if useful]")
for h in hits:
    print(f"- [{h['dir_key']}] {h['name']}: {h['description']} ({h['memory_id']})")
print()
PY
fi

exit 0

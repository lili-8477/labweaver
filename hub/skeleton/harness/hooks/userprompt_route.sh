#!/usr/bin/env bash
# UserPromptSubmit hook. Drains ~/.claude/.chpc_pending if non-empty: emits
# any CHPC job terminal-state notifications as additional context so the
# agent sees them prepended to the user's prompt this turn. Runs for every
# prompt, slash commands included: the agent should never miss a job-status
# event. (Auto mode no longer routes through here: the adapter starts auto
# turns as /tick and drives them, see adapter/src/auto-mode.ts.)
set -uo pipefail

LOG="$HOME/.claude/.harness_active.log"
log() { printf '%s userprompt_route %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

INBOX="${CHPC_INBOX:-$HOME/.claude/.chpc_pending}"

# ── Drain CHPC notifications ──────────────────────────────────────
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

exit 0

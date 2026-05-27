#!/usr/bin/env bash
# UserPromptSubmit hook. Two independent responsibilities:
#
#   1. Drain ~/.claude/.chpc_pending if non-empty — emit any CHPC job
#      terminal-state notifications as additional context so the agent
#      sees them prepended to the user's prompt this turn. Always runs,
#      regardless of harness state or whether the prompt is a slash command:
#      the agent should never miss a job-status event.
#
#   2. When self-driving (tick) mode is on AND the user typed a normal
#      message (not a slash command), inject a directive that routes the
#      turn into the /tick orchestrator.
set -uo pipefail

LOG="$HOME/.claude/.harness_active.log"
log() { printf '%s userprompt_route %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

INBOX="${CHPC_INBOX:-$HOME/.claude/.chpc_pending}"

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

# ── 2. Optional: tick-harness routing ────────────────────────────────
# Harness toggle: stay quiet unless self-driving mode is enabled. The marker
# file is written/removed by the Mode panel in the frontend.
[[ -f "$HOME/.claude/.harness_active" ]] || { log "noop: marker absent"; exit 0; }

# Read the JSON envelope from stdin; extract the prompt field.
INPUT="$(cat)"
PROMPT="$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    print(d.get("prompt",""), end="")
except Exception:
    pass' 2>/dev/null || true)"

# User-initiated slash commands pass through untouched (drain above still ran).
case "$PROMPT" in
  /*) log "passthrough: slash command (${PROMPT:0:60})"; exit 0 ;;
esac

log "inject: routing to /tick (prompt=${PROMPT:0:80})"

# Inject orchestration context. Claude Code appends this stdout as additional
# context to the user prompt, so the agent sees the directive alongside the
# original message.
cat <<'EOF'
[Self-driving mode is ON. The harness gate marker ~/.claude/.harness_active is present.]

Your ONLY action for this turn: invoke the /tick slash command via the SlashCommand tool. The orchestrator will read the user's latest message and:
  - if no progress.md exists in cwd, dispatch tick-bootstrap (scaffolds a new project from the instruction),
  - otherwise dispatch the next subagent in the priority chain (planner / executor / reviewer).

Do not answer the user's request directly. Do not run other tools first. The Stop hook will keep re-prompting /tick after each turn until ## Status: complete is written or the user pauses (touch ~/.claude/.tick_paused) or toggles self-driving Off.
EOF

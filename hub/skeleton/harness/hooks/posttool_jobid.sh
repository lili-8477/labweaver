#!/usr/bin/env bash
# PostToolUse(Bash) — when the agent runs `sbatch` (typically via the CHPC
# bridge), capture the returned jobid and spawn a background watcher that
# polls SLURM until the job hits a terminal state. The watcher writes one
# NDJSON record to ~/.claude/.chpc_pending; userprompt_route.sh drains that
# inbox on the next user prompt so the agent learns the outcome.
#
# Runs in any mode (harness on or off). CHPC submissions can happen in
# interactive chats too, not just the self-driving tick harness.
#
# Note: no `set -e`. Several extraction steps below pipe into `grep -oE`;
# a no-match returns exit 1 which would kill the script even though the
# fall-through (`[[ -z ... ]]`) is exactly how we handle that case. pipefail
# stays on so a broken json parse still surfaces.
set -uo pipefail

HARNESS="${HARNESS_DIR:-$PWD}"
LOG="$HARNESS/.jobs.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

# Pull the command and its stdout out of the hook envelope. Tolerate any
# malformed JSON by collapsing to empty strings — we'd rather no-op than
# crash a tool call.
parsed="$(python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("\t__OUT__\t"); sys.exit(0)
cmd = (d.get("tool_input") or {}).get("command","") or ""
out = (d.get("tool_response") or {}).get("stdout","") or ""
print(f"{cmd}\t__OUT__\t{out}")
' 2>/dev/null || echo $'\t__OUT__\t')"

cmd="$(printf '%s' "$parsed" | awk -F'\t__OUT__\t' '{print $1}')"
out="$(printf '%s' "$parsed" | awk -F'\t__OUT__\t' '{print $2}')"

case "$cmd" in
  *sbatch*) ;;
  *) exit 0 ;;
esac

# ── Extract jobid ────────────────────────────────────────────────────
# Three known sbatch output shapes:
#   1. "Submitted batch job 13169761"      (default sbatch)
#   2. "Submitted 13169761"                 (the chpc-bridge skill's echo)
#   3. "13169761" or "13169761;clusterA"    (--parsable, alone)
jobid=""
jobid="$(printf '%s' "$out" | grep -oE 'Submitted batch job [0-9]+' | grep -oE '[0-9]+' | head -1)"
if [[ -z "$jobid" ]]; then
  jobid="$(printf '%s' "$out" | grep -oE 'Submitted [0-9]+' | grep -oE '[0-9]+' | head -1)"
fi
if [[ -z "$jobid" ]]; then
  jobid="$(printf '%s' "$out" | grep -E '^[0-9]+(;.*)?$' | head -1 | cut -d';' -f1)"
fi
[[ -z "$jobid" ]] && exit 0

# ── Derive a human step name (best effort) ───────────────────────────
# Prefer explicit --job-name=, fall back to the .slurm filename, then to a
# legacy local scripts/<name> path, then to "chpc-job".
step_id=""
step_id="$(printf '%s' "$cmd" | grep -oE -- '--job-name=[A-Za-z0-9_.-]+' | head -1 | cut -d= -f2)"
if [[ -z "$step_id" ]]; then
  step_id="$(printf '%s' "$cmd" | grep -oE '[A-Za-z0-9_.-]+\.slurm' | head -1 | sed 's/\.slurm$//')"
fi
if [[ -z "$step_id" ]]; then
  step_id="$(printf '%s' "$cmd" | grep -oE 'scripts/[a-z_]+' | head -1 | sed 's|scripts/||')"
fi
[[ -z "$step_id" ]] && step_id="chpc-job"

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s | %s | %s\n' "$step_id" "$jobid" "$ts" >> "$LOG"

# ── Spawn watcher (background, detached) ─────────────────────────────
# setsid + nohup + closed FDs so the watcher outlives this hook process and
# the parent Bash tool call. Best-effort: if the script is missing or not
# executable, just leave the jobid logged and move on.
WATCHER="${CHPC_WATCHER:-$HOME/.claude/hooks/chpc_job_watcher.sh}"
if [[ -x "$WATCHER" ]]; then
  setsid nohup "$WATCHER" "$jobid" "$step_id" >/dev/null 2>&1 < /dev/null &
  disown 2>/dev/null || true
fi

exit 0

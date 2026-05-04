#!/usr/bin/env bash
# PostToolUse hook (Bash) — capture SLURM jobids when sbatch is used.
# Local-container execution doesn't use sbatch, so this is a no-op.
# Kept in place for future SLURM integration.
set -euo pipefail

# Harness toggle: stay no-op unless self-driving mode is enabled.
# Enabled when ~/.claude/.harness_active exists (toggled from the frontend).
[[ -f "$HOME/.claude/.harness_active" ]] || exit 0

HARNESS="${HARNESS_DIR:-$PWD}"
LOG="$HARNESS/.jobs.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

parsed="$(python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("\t"); sys.exit(0)
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

step_id="$(printf '%s' "$cmd" | grep -oE 'scripts/[a-z_]+' | head -1 | sed 's|scripts/||')"
[[ -z "$step_id" ]] && step_id="unknown"

jobid="$(printf '%s' "$out" | grep -oE 'Submitted batch job [0-9]+' | grep -oE '[0-9]+' | head -1)"
[[ -z "$jobid" ]] && exit 0

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s | %s | %s\n' "$step_id" "$jobid" "$ts" >> "$LOG"
exit 0

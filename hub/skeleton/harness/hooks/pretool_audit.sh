#!/usr/bin/env bash
# PreToolUse hook — append every tool call to .audit.log
set -euo pipefail

# Harness toggle: stay no-op unless self-driving mode is enabled.
# Enabled when ~/.claude/.harness_active exists (toggled from the frontend).
[[ -f "$HOME/.claude/.harness_active" ]] || exit 0

HARNESS="${HARNESS_DIR:-$PWD}"
LOG="$HARNESS/.audit.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

parsed="$(python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("?\t?\t<parse-error>"); sys.exit(0)
agent = d.get("subagent_type") or d.get("agent") or "main"
tool = d.get("tool_name") or "?"
ti = d.get("tool_input") or {}
# Build a compact summary from common keys
parts = []
for k in ("command","file_path","path","prompt","description","content"):
    v = ti.get(k)
    if not v: continue
    s = str(v).replace("\n", " ")
    parts.append(f"{k}={s}")
    if len(" | ".join(parts)) >= 160:
        break
summary = " | ".join(parts)[:160]
print(f"{agent}\t{tool}\t{summary}")
' 2>/dev/null || echo $'?\t?\t<parse-error>')"

agent="$(printf '%s' "$parsed" | cut -f1)"
tool="$(printf '%s' "$parsed" | cut -f2)"
summary="$(printf '%s' "$parsed" | cut -f3-)"

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s | %s | %s | %s\n' "$ts" "$agent" "$tool" "$summary" >> "$LOG"
exit 0

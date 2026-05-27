#!/usr/bin/env bash
# Per-jobid CHPC SLURM poller. Spawned in the background by posttool_jobid.sh
# after `sbatch` returns a job ID. Polls `sacct` via the multiplexed SSH bridge
# every CHPC_POLL_INTERVAL seconds. When the job hits a terminal state, writes
# one NDJSON record to ~/.claude/.chpc_pending and exits.
#
# Passive contract: nothing wakes the agent. userprompt_route.sh drains the
# inbox the next time the user types anything, so the agent sees the result
# prepended as additional context on its next turn.
#
# Bounded by CHPC_MAX_HOURS (default 72h) so an orphaned watcher can't poll
# forever if the bridge goes down permanently or the job is misrouted.

set -uo pipefail

JOBID="${1:?usage: chpc_job_watcher.sh <jobid> [step_name]}"
STEP="${2:-chpc-job}"
HOST="${CHPC_HOST:-chpc-login}"
INBOX="${CHPC_INBOX:-$HOME/.claude/.chpc_pending}"
LOG="${CHPC_WATCHER_LOG:-$HOME/.claude/.chpc_watcher.log}"
POLL_INTERVAL="${CHPC_POLL_INTERVAL:-600}"
MAX_HOURS="${CHPC_MAX_HOURS:-72}"

mkdir -p "$(dirname "$INBOX")" "$(dirname "$LOG")" 2>/dev/null || true

log() { printf '%s watcher[%s] %s\n' "$(date -Iseconds)" "$JOBID" "$*" >> "$LOG"; }

# SLURM "completed" set per sacct(1). Anything outside this is still pending,
# running, or in a transient transition we should keep watching through.
terminal_re='^(COMPLETED|FAILED|CANCELLED|TIMEOUT|OUT_OF_MEMORY|NODE_FAIL|PREEMPTED|BOOT_FAIL|DEADLINE|REVOKED|SPECIAL_EXIT)$'

start_ts=$(date +%s)
deadline=$(( start_ts + MAX_HOURS * 3600 ))

log "start step=$STEP host=$HOST poll=${POLL_INTERVAL}s max=${MAX_HOURS}h pid=$$"

# Single-instance guard: avoid two watchers polling the same jobid (e.g. if
# the agent re-emits the same sbatch command). flock on a per-jobid file,
# release on exit. If we can't grab the lock, another watcher owns it.
LOCK_DIR="$HOME/.claude/.chpc_watch.locks"
mkdir -p "$LOCK_DIR" 2>/dev/null || true
LOCK_FILE="$LOCK_DIR/$JOBID.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another watcher already owns this jobid; exiting"
  exit 0
fi

emit() {
  # $1=state $2=elapsed $3=exitcode $4=note
  printf '{"ts":"%s","jobid":"%s","step":"%s","state":"%s","elapsed":"%s","exit":"%s","note":"%s"}\n' \
    "$(date -Iseconds)" "$JOBID" "$STEP" "$1" "$2" "$3" "$4" >> "$INBOX"
}

while :; do
  now=$(date +%s)
  if (( now > deadline )); then
    emit "WATCHER_TIMEOUT" "${MAX_HOURS}h+" "-" "exceeded CHPC_MAX_HOURS without terminal state"
    log "deadline reached, giving up"
    exit 0
  fi

  if ! ssh -O check "$HOST" >/dev/null 2>&1; then
    log "bridge down, sleeping ${POLL_INTERVAL}s"
    sleep "$POLL_INTERVAL"
    continue
  fi

  # -X: one row per job (skip .batch/.extern steps). -P: pipe-delimited.
  # -n: no header. -o: explicit field order.
  line="$(ssh "$HOST" "sacct -j ${JOBID} -X -P -n -o State,Elapsed,ExitCode" 2>/dev/null | head -1)"

  if [[ -z "$line" ]]; then
    log "no sacct row yet (job not registered or sacct empty)"
    sleep "$POLL_INTERVAL"
    continue
  fi

  state="$(printf '%s' "$line" | cut -d'|' -f1 | awk '{print $1}')"
  elapsed="$(printf '%s' "$line" | cut -d'|' -f2)"
  exitcode="$(printf '%s' "$line" | cut -d'|' -f3)"

  if [[ "$state" =~ $terminal_re ]]; then
    emit "$state" "$elapsed" "$exitcode" ""
    log "terminal state=$state elapsed=$elapsed exit=$exitcode"
    exit 0
  fi

  log "running state=$state elapsed=$elapsed"
  sleep "$POLL_INTERVAL"
done

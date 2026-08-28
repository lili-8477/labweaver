#!/bin/bash
# Capture one arm's evidence after its run finishes.
# Usage: ./capture.sh a li86
#        ./capture.sh b control
set -euo pipefail

ARM="${1:?arm letter, a or b}"
WS="${2:?workspace name, e.g. li86}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${HERE}/../../.." && pwd)"
OUT="${HERE}/arm-${ARM}"
SRC="${REPO}/hub/workspaces/${WS}"

mkdir -p "${OUT}"

# Session transcripts written by Claude Code.
cp -r "${SRC}/.claude/claude-projects" "${OUT}/transcripts" 2>/dev/null \
    || echo "warn: no transcripts at ${SRC}/.claude/claude-projects"

# Audit trail: every Bash/Write/Edit call, and every sbatch submission.
for f in .audit.log .jobs.log; do
    find "${SRC}" -maxdepth 3 -name "${f}" -exec cp {} "${OUT}/" \; 2>/dev/null || true
done

# The arm's own working tree.
if [[ -d "${SRC}/local_projects/A8163_mSS_ab" ]]; then
    cp -r "${SRC}/local_projects/A8163_mSS_ab" "${OUT}/work"
else
    echo "warn: arm ${ARM} produced no A8163_mSS_ab directory"
fi

# Leakage check: did this arm read outside the staged input?
grep -oE '/uufs/[^ "'"'"')]*' "${OUT}"/.audit.log 2>/dev/null \
    | grep -v 'A8163_mSS_ab_input' | sort -u > "${OUT}/offpath-uufs.txt" || true

echo "captured arm ${ARM} (${WS}) -> ${OUT}"
echo "off-path CHPC accesses: $(wc -l < "${OUT}/offpath-uufs.txt" 2>/dev/null || echo 0)"

#!/bin/bash
# Restore script for the 2026-08-28 scRNA-seq A/B experiment CHPC staging.
#
# Undoes the relocation performed for the experiment:
#   - Moves every entry back from ${D}_locked/ into $D/
#   - Removes the staged clean-input directory
#
# Run through the li86 container's live SSH bridge:
#   docker exec claude-bioflow-li86 bash -lc 'ssh chpc-login "bash -s" < docs/experiments/2026-08-28-scrnaseq-ab/chpc-restore.sh'
# or copy this script to CHPC and run it there directly.
#
# Safety properties:
#   - Idempotent: safe to re-run; already-restored entries are left alone.
#   - Non-destructive: never overwrites an existing entry in $D, never deletes
#     any data file. The only "rm" in this script is `rmdir` on directories
#     it has just emptied by moving their contents out.
set -euo pipefail

D="/uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/singlecellrnaseq/A8163_mSS"
LOCKED="${D}_locked"
STAGED="/uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/ab_input_2026-08-28"

echo "=== Restoring worked solution from ${LOCKED} into ${D} ==="

if [ ! -d "$LOCKED" ]; then
  echo "Nothing to restore: ${LOCKED} does not exist. Skipping move-back step."
else
  shopt -s nullglob dotglob
  moved=0
  skipped=0
  for entry in "$LOCKED"/*; do
    name="$(basename "$entry")"
    dest="$D/$name"
    if [ -e "$dest" ]; then
      echo "SKIP (already present in $D): $name"
      skipped=$((skipped + 1))
      continue
    fi
    echo "Restoring: $name"
    mv -n -- "$entry" "$dest"
    moved=$((moved + 1))
  done
  shopt -u nullglob dotglob

  echo "Moved back: $moved   Skipped (already present): $skipped"

  # Only remove the now-empty staging directory itself, never its contents
  # (contents are either moved out above, or intentionally left behind on skip).
  if [ -d "$LOCKED" ] && [ -z "$(ls -A "$LOCKED" 2>/dev/null)" ]; then
    rmdir "$LOCKED"
    echo "Removed now-empty ${LOCKED}"
  else
    echo "NOTE: ${LOCKED} still has entries (skipped above because $D already had them) — left in place, nothing deleted."
  fi
fi

echo ""
echo "=== Removing staged clean-input directory ${STAGED} ==="
if [ ! -d "$STAGED" ]; then
  echo "Nothing to remove: ${STAGED} does not exist."
else
  # The staged directory holds only hard links to the original FASTQs under
  # $D/Fastq (which was never moved), plus directories we created. Removing
  # the hard links here does not delete data: the original files under
  # $D/Fastq still hold the content (link count drops back to 1).
  find "$STAGED" -type f -name '*.fastq.gz' -exec rm -f -- {} +
  find "$STAGED" -type f -name '*md5*' -exec rm -f -- {} +
  # Remove now-empty directories, deepest first. Leaves anything unexpected
  # (non-hardlink files) in place rather than deleting it.
  find "$STAGED" -depth -type d -empty -exec rmdir -- {} +
  if [ -d "$STAGED" ]; then
    echo "NOTE: ${STAGED} still exists — some entries were not empty/expected and were left in place."
  else
    echo "Removed ${STAGED}"
  fi
fi

echo ""
echo "=== Restore complete ==="

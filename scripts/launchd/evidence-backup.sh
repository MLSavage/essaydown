#!/bin/sh
# Hourly copy of the host-owned evidence directory to iCloud Drive (launchd agent
# com.savagesystems.essaydown.evidence-backup). Additive: never deletes on the target.
set -eu
SRC="$HOME/Developer/essaydown/.evidence/"
DST="$HOME/Library/Mobile Documents/com~apple~CloudDocs/essaydown-evidence/"
mkdir -p "$DST"
if [ ! -d "$SRC" ]; then
  echo "$(date -u +%FT%TZ) skip: $SRC does not exist yet"
  exit 0
fi
rsync -a --exclude '.DS_Store' "$SRC" "$DST"
echo "$(date -u +%FT%TZ) ok: $(find "$DST" -type f | wc -l | tr -d ' ') files in essaydown-evidence"

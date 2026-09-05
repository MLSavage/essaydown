#!/usr/bin/env bash
# sync-state.sh — RUNNER-SPEC §6, run after every planning commit (ralph.sh does this itself after
# reconciliations and resolved plan requests; this wrapper is for a planning commit made by hand).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$HERE/ralph.sh" sync-state "$@"

#!/usr/bin/env bash
# gate.sh — human and CI gates on the host (RUNNER-SPEC §2, §3; PRD §9.10). Michael's gh login, never a container.
#   scripts/gate.sh <id> [--resume a<n>]                       CI gate <id>h: push ci ref, wait, fetch, accepted.json
#   scripts/gate.sh <id> --outcome ACCEPT|REJECT [--payload k=v]... (--note "text" | --file path)   observation/approval gate
#   scripts/gate.sh rerun <gate-id>                             new execution attempt a<n+1>, same SHA (transient failures only)
#   scripts/gate.sh abandon <id> a<n> --reason <text>           leave the attempt directory, mark it abandoned
#   scripts/gate.sh gc                                          delete remote ci/* refs of accepted/rejected/abandoned attempts
# Gates never commit. Evidence goes to .evidence/{ci,human}/<id>/.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${RALPH_ROOT:-$(cd "$HERE/.." && pwd)}"
export RALPH_ROOT="$ROOT" ESSAYDOWN_ROOT="$ROOT"
exec node "$ROOT/ralph/lib/cli.mjs" gate "$@"

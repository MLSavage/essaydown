#!/usr/bin/env bash
# ralph.sh — the runner (host; RUNNER-SPEC §11). Commands, byte for byte:
#   run [--phase N] | retry <id> | resume <id> | resolve-conflict <id> | abandon <id> --reason <text>
#   | plan <request-id> | plan-retry <request-id> | plan-abandon <request-id> --reason <text>
#   | rerun <gate-id> | close <N> | sync-state | status | doctor
#   | admin mark-integrated <id> | admin retry <id> | admin resolve-request <request-id> --state <s>
# Plus `run --dry-run` (prints the next task and branch; 0.0 acceptance). All state lives in
# .evidence/state/ and is written only here, under the one lock. The runner never pushes.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${RALPH_ROOT:-$(cd "$HERE/.." && pwd)}"
export RALPH_ROOT="$ROOT" ESSAYDOWN_ROOT="$ROOT"
exec node "$HERE/lib/cli.mjs" ralph "$@"

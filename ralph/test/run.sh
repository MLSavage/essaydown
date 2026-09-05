#!/usr/bin/env bash
# ralph/test/run.sh — the conformance suite (RUNNER-SPEC §12) against disposable fixture repositories.
# Plain Node test runner, no dependencies. Run by ralph/bootstrap.sh before state is initialised.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node --test --test-concurrency=1 "$HERE/validator.test.mjs" "$HERE/conformance.test.mjs" "$@"

#!/usr/bin/env bash
# check-agent-rules.sh — CLAUDE.md and AGENTS.md must be identical below line 1 (task 0.0 acceptance;
# tests/agent-rules.test.ts re-asserts this from task 0.1). Exit 0 when identical.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if cmp -s <(tail -n +2 "$ROOT/CLAUDE.md") <(tail -n +2 "$ROOT/AGENTS.md"); then
  echo "check-agent-rules: OK (CLAUDE.md ≡ AGENTS.md below line 1)"
else
  echo "check-agent-rules: FAIL — CLAUDE.md and AGENTS.md differ below line 1:" >&2
  diff <(tail -n +2 "$ROOT/CLAUDE.md") <(tail -n +2 "$ROOT/AGENTS.md") >&2 || true
  exit 1
fi

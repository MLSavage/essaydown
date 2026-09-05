#!/usr/bin/env bash
# stop-check.sh — the suite on a tree, inside the container (RUNNER-SPEC §4.3, PRD §9.3: from task 0.1 onward
# `pnpm lint && pnpm test && cargo test` must be green on the task branch and again on the squashed candidate).
# Usage: stop-check.sh <tree path inside the container>. Exit 0 = green.
set -euo pipefail
tree="${1:?tree path}"
cd "$tree"
if [ ! -f package.json ]; then echo "stop-check: no package.json in $tree (nothing to run before 0.1 lands)"; exit 1; fi
run() { echo "== $*"; "$@"; }
if [ ! -d node_modules ]; then run pnpm install --frozen-lockfile; fi
run pnpm lint
run pnpm test
if [ -f Cargo.toml ]; then run cargo test; else echo "== cargo test skipped: no root Cargo.toml"; fi
echo "stop-check: GREEN"

#!/usr/bin/env bash
# fetch-ci-logs.sh — host-side (Michael's gh login): fetch a workflow run's log and named artifacts into
# .evidence/ci/<id>/a<n>/ without touching state. scripts/gate.sh does this itself for every gate; this
# script is the manual fallback (RUNNER-SPEC §11, PRD §9.12), e.g. to pull extra artifacts for a reviewer.
#   scripts/fetch-ci-logs.sh <gate-id> <a<n>> <run-id> [artifact-name ...]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
id="${1:?gate id, e.g. 0.verifyh}"; attempt="${2:?attempt, e.g. a1}"; run="${3:?workflow run id}"; shift 3
dir="$ROOT/.evidence/ci/$id/$attempt"
mkdir -p "$dir"
gh run view "$run" --log > "$dir/workflow.log" || true
gh run view "$run" --json databaseId,url,headSha,workflowName,conclusion,status > "$dir/run-view.json"
for name in "$@"; do
  mkdir -p "$dir/$name"
  gh run download "$run" -n "$name" -D "$dir/$name"
  echo "fetched artifact $name → $dir/$name"
done
echo "fetch-ci-logs: run $run → $dir (state untouched; use scripts/gate.sh $id --resume $attempt to record it)"

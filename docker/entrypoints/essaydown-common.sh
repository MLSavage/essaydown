#!/usr/bin/env bash
# Shared helpers for the essaydown-dev entrypoints (sourced, not executed).
set -euo pipefail

: "${HOME:=/home/agent}"
export HOME CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 2; }

# Reviewer prompt (BUILD-DEFAULTS §6, RUNNER-SPEC §5). $1 = reviewer name, $2 = phase, $3 = attempt.
review_prompt() {
  local who="$1" phase="$2" attempt="$3" dir="/logs/reviews/$2/$3"
  local base impl verifier
  base=$(cat "$dir/phase_base_sha" 2>/dev/null || echo "<missing>")
  impl=$(cat "$dir/implementation_sha" 2>/dev/null || echo "<missing>")
  verifier=$(cat "$dir/verifier_id" 2>/dev/null || echo "$phase.verify")
  cat <<EOF
You are the independent reviewer "$who" for Essay Down phase $phase, review attempt $attempt. Your worktree at /snapshot is checked out read-only at implementation_sha $impl; the phase base SHA is $base (both recorded in $dir/). Read docs/PRD.md (§7 gate row for phase $phase, §8 tasks for phase $phase, §9), docs/RUNNER-SPEC.md, docs/lessons.md, then \`git diff $base...$impl\`, /logs/ci/$verifier/accepted/ (this attempt's verifier; verify artifact digests against accepted.json) and the phase's other /logs/ci/<id>/accepted/, /logs/human/<id>/accepted.json and /logs/tasks/<id>/ directories. Try to falsify every gate criterion. Reviewers never edit code; the only writable persistent path is /report/ (= $dir/$who/). Write your report to /report/report.md using docs/reviews/TEMPLATE.md exactly (gate table with evidence, test counts, coverage delta, at most 20 findings with severity blocker|should-fix|nit, file:line and a concrete fix, three riskiest things, class-level lessons), then write /report/status.json as {"reviewer":"$who","phase":"$phase","attempt":"$attempt","implementation_sha":"$impl","verdict":"PASS"|"FAIL","blockers":<n>,"should_fix":<n>,"nits":<n>}. No praise, no summary of the code.
EOF
}

# Reviewer output check: report.md must exist and carry the TEMPLATE.md headings; status.json must parse.
check_report() {
  local dir="$1" who="$2"
  [ -s "$dir/report.md" ] || die "$who wrote no /report/report.md"
  for h in "## Gate table" "## Test counts and coverage" "## Findings" "## Three riskiest things" "## Class-level lessons"; do
    grep -q "^$h" "$dir/report.md" || die "$who report.md lacks heading: $h"
  done
  [ -s "$dir/status.json" ] || die "$who wrote no /report/status.json"
  jq -e '.reviewer and .verdict and (.verdict=="PASS" or .verdict=="FAIL")' "$dir/status.json" >/dev/null || die "$who status.json invalid"
  log "$who report ok: verdict $(jq -r .verdict "$dir/status.json")"
}

# Fresh-clone cold build of implementation_sha into /scratch/<who> (Claude and Sol only).
cold_clone() {
  local who="$1" impl="$2" dst="/scratch/$1"
  rm -rf "$dst"
  git clone -q --no-checkout "$ESSAYDOWN_ROOT" "$dst"
  git -C "$dst" checkout -q "$impl"
  log "$who scratch clone at $impl in $dst"
}

scratch_must_be_clean() {
  local dst="/scratch/$1"
  local dirty
  dirty=$(git -C "$dst" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  [ "$dirty" = "0" ] || die "$1 scratch copy dirty at exit ($dirty entries)"
  rm -rf "$dst"
}

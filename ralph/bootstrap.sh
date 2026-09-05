#!/usr/bin/env bash
# bootstrap.sh — task 0.0 (RUNNER-SPEC §2 bootstrap row; PRD §8 0.0 acceptance). Host, once, on phase/0.
# Runs every 0.0 check, quotes each result into the 0.0 journal entry, and only when all pass makes the
# `task(0.0): bootstrap` commit on phase/0 and initialises .evidence/state/ with 0.0 passed.
# Reversal before Phase 0 runs: git branch -D phase/0 && rm -rf .evidence   (main is untouched)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export RALPH_ROOT="$ROOT" ESSAYDOWN_ROOT="$ROOT"
EXT_ID=build-defaults; EXT_PATH=/work/.ext/build-defaults; EXT_REF=refs/heads/main
JOURNAL="$ROOT/docs/progress/journal-main.md"
LOG="$(mktemp -t bootstrap-0.0)"
fail=0
step() { printf '\n== %s\n' "$*" | tee -a "$LOG"; }
quote() { sed 's/^/    /' | tee -a "$LOG"; }
check() { # check <label> <command...>: runs, quotes output, records PASS/FAIL
  local label="$1"; shift
  step "$label"
  local out rc=0
  out="$("$@" 2>&1)" || rc=$?
  printf '%s\n' "$out" | tail -n 40 | quote
  if [ $rc -eq 0 ]; then echo "PASS $label" | tee -a "$LOG"; else echo "FAIL $label (exit $rc)" | tee -a "$LOG"; fail=1; fi
}

[ "$(git rev-parse --abbrev-ref HEAD)" = "phase/0" ] || { echo "bootstrap: run on phase/0 (currently $(git rev-parse --abbrev-ref HEAD))" >&2; exit 2; }
[ -z "$(git status --porcelain)" ] || { echo "bootstrap: working tree not clean" >&2; git status --short >&2; exit 2; }
[ ! -d .evidence/state ] || { echo "bootstrap: .evidence/state exists; reversal is git branch -D phase/0 && rm -rf .evidence" >&2; exit 2; }
mkdir -p .evidence

check "docker compose build" docker compose build claude-task
check "docker compose run claude-task --version" docker compose run --rm claude-task --version
check "docker compose run codex-review --version" docker compose run --rm codex-review --version
check "docker compose run grok-review --version" docker compose run --rm grok-review --version
check "credential boundary (boundary-check → BOUNDARY-OK; includes pdfimages -v)" docker compose run --rm boundary-check
check "node ralph/validate-tasks.mjs (EXPECTED_COUNT $(cat ralph/EXPECTED_COUNT))" node ralph/validate-tasks.mjs
check "ralph/test/run.sh conformance suite (RUNNER-SPEC §12)" ralph/test/run.sh
check "ralph/check-agent-rules.sh" ralph/check-agent-rules.sh
union_test() {
  local d; d="$(mktemp -d -t union-test)"
  git -C "$d" init -q -b main && git -C "$d" config user.name t && git -C "$d" config user.email t@t
  mkdir -p "$d/docs" && printf 'docs/lessons.md merge=union\n' > "$d/.gitattributes" && printf '# lessons\n' > "$d/docs/lessons.md"
  git -C "$d" add -A && git -C "$d" commit -q -m seed
  git -C "$d" switch -q -c a && printf -- '- [a] LESSON: line from a\n' >> "$d/docs/lessons.md" && git -C "$d" commit -q -am a
  git -C "$d" switch -q main && git -C "$d" switch -q -c b && printf -- '- [b] LESSON: line from b\n' >> "$d/docs/lessons.md" && git -C "$d" commit -q -am b
  git -C "$d" merge -q --no-edit a
  grep -q 'line from a' "$d/docs/lessons.md" && grep -q 'line from b' "$d/docs/lessons.md" && [ -z "$(git -C "$d" status --porcelain)" ]
  echo "merge=union: both lines present after merging a into b"; cat "$d/docs/lessons.md"; rm -rf "$d"
}
check "merge=union lessons.md merges two branches cleanly (fixture repo)" union_test
external_test() {
  local repo="$ROOT/.ext/$EXT_ID"
  [ -d "$repo/.git" ] || { echo "no clone at $repo"; return 1; }
  [ -z "$(git -C "$repo" status --porcelain)" ] || { echo "external clone dirty"; git -C "$repo" status --short; return 1; }
  git -C "$repo" show-ref --verify --quiet "$EXT_REF" || { echo "$EXT_REF missing"; return 1; }
  (cd "$repo" && node scripts/validate-defaults.mjs)
  echo "external $EXT_ID at $(git -C "$repo" rev-parse "$EXT_REF") ($EXT_REF)"
}
check "external clone .ext/$EXT_ID (clean, $EXT_REF present, validate-defaults.mjs passes)" external_test

if [ $fail -ne 0 ]; then echo; echo "bootstrap: FAILED — fix and re-run; nothing was committed or initialised (log: $LOG)"; exit 1; fi

step "journal entry + task(0.0) commit"
ts="$(date -u +%FT%TZ)"
versions="$(grep -v '^#' docker/versions.env | tr '\n' ' ')"
{
  printf -- '- [0.0] %s Task: bootstrap — image, entrypoints, generator/validator, gate.sh, ralph.sh, conformance suite, bootstrap, agent rules. Status: Complete. Files: docker/, ralph/, scripts/, CLAUDE.md, AGENTS.md, .gitattributes, .gitignore. Tests: conformance suite %s; validator 122 tasks. Iterations used: 1 (interactive, principal + Michael). First attempt passed: y. Tool calls: n/a. Reviewer overturned: pending (Phase 0 review set). Notes: versions %s. Checks (quoted from ralph/bootstrap.sh):\n' "$ts" "$(grep -E '^# (pass|fail)' "$LOG" | tr '\n' ' ' | sed 's/# //g')" "$versions"
  sed 's/^/    /' "$LOG" | grep -vE '^\s*$' | sed 's/\t/  /g'
  printf '\n'
} >> "$JOURNAL"
git add -A
git commit -q -m "task(0.0): bootstrap

Essay Down runner bootstrap: essaydown-dev image and entrypoints, ralph/
(generate-tasks, validate-tasks, ralph.sh with every RUNNER-SPEC §11 command,
gate.sh, conformance suite, PROMPT.md, bootstrap), CLAUDE.md ≡ AGENTS.md,
merge=union on docs/lessons.md only. Tool versions: $versions
EXPECTED_COUNT: $(cat ralph/EXPECTED_COUNT). Every 0.0 check quoted in the
journal entry of this commit.

Depends-on: none
Reverse: git branch -D phase/0 && rm -rf .evidence (main untouched)"
sha="$(git rev-parse HEAD)"
echo "committed $sha" | tee -a "$LOG"

step "initialise .evidence/state (0.0 passed, Phase 0 base, external state)"
node ralph/lib/bootstrap-state.mjs "$sha" "$EXT_ID" "$EXT_PATH" "$EXT_REF" | tee -a "$LOG"
step "ralph.sh run --dry-run"
ralph/ralph.sh run --dry-run | tee -a "$LOG"
ralph/ralph.sh doctor | tee -a "$LOG"
echo
echo "BOOTSTRAP-OK task(0.0) $sha — next: docker compose run --rm claude-login | codex-login | grok-login (once each), then ralph/ralph.sh run --phase 0"

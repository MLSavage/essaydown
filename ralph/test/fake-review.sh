#!/usr/bin/env bash
# fake-review.sh <reviewer> <phase> <attempt> — stands in for the three reviewer services.
# Verdict from $RALPH_ROOT/.fake/review-<phase>-<attempt>.json {"verdict":"PASS","fail":["sol"]} (fail = reviewers that exit 1).
set -euo pipefail
who="$1"; phase="$2"; attempt="$3"; dir="$REVIEW_DIR/$who"; root="$RALPH_ROOT"
ctl="$root/.fake/review-$phase-$attempt.json"
verdict=PASS; failers=""
if [ -f "$ctl" ]; then verdict=$(node -e 'const c=require(process.argv[1]);process.stdout.write(c.verdict||"PASS")' "$ctl"); failers=$(node -e 'const c=require(process.argv[1]);process.stdout.write((c.fail||[]).join(" "))' "$ctl"); fi
case " $failers " in *" $who "*) echo "fake-review: $who fails"; exit 1;; esac
[ -d "$REVIEW_SNAPSHOT" ] || { echo "no snapshot"; exit 1; }
impl=$(cat "$REVIEW_DIR/implementation_sha")
mkdir -p "$dir"
cat > "$dir/report.md" <<MD
# Phase $phase review — $who

Reviewer: fake. Inputs: snapshot at $impl. Cold build: fake.

## Gate table

| Criterion | Result | Evidence |
|---|---|---|
| fake | pass | fake |

## Test counts and coverage

fake

## Findings (≤ 20, most severe first)

1. **nit** — none.

## Three riskiest things

1. none

## Class-level lessons (for docs/lessons.md)

- LESSON: none
MD
echo "{\"reviewer\":\"$who\",\"phase\":\"$phase\",\"attempt\":\"$attempt\",\"implementation_sha\":\"$impl\",\"verdict\":\"$verdict\",\"blockers\":0,\"should_fix\":0,\"nits\":1}" > "$dir/status.json"

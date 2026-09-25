#!/usr/bin/env bash
# fake-review.sh <reviewer> <phase> <attempt> — stands in for the three reviewer services.
# Verdict from $RALPH_ROOT/.fake/review-<phase>-<attempt>.json {"verdict":"PASS","fail":["sol"]} (fail = reviewers that exit 1).
# Further lists of reviewers (DECISIONS #025 tests): "read" — cats every sibling report.md present in the attempt directory
# (its path lands in transcript.log); "cite" — names every sibling's report path in transcript.log whether present or not;
# "failAfterReport" — writes report.md/status.json/transcript.log, then exits 1. Every run writes seen.txt (ls of the attempt dir).
set -euo pipefail
who="$1"; phase="$2"; attempt="$3"; dir="$REVIEW_DIR/$who"; root="$RALPH_ROOT"
ctl="$root/.fake/review-$phase-$attempt.json"
list() { if [ -f "$ctl" ]; then node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((c[process.argv[2]]||[]).join(" "))' "$ctl" "$1"; fi; }
in_list() { case " $(list "$1") " in *" $who "*) return 0;; esac; return 1; }
verdict=PASS
if [ -f "$ctl" ]; then verdict=$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(c.verdict||"PASS")' "$ctl"); fi
mkdir -p "$dir"
ls "$REVIEW_DIR" > "$dir/seen.txt"
: > "$dir/transcript.log"
if in_list read; then for sib in claude sol grok; do [ "$sib" = "$who" ] && continue; if [ -f "$REVIEW_DIR/$sib/report.md" ]; then echo "{\"type\":\"tool_use\",\"input\":{\"command\":\"cat /logs/reviews/$phase/$attempt/$sib/report.md\"}}" >> "$dir/transcript.log"; fi; done; fi
if in_list cite; then for sib in claude sol grok; do [ "$sib" = "$who" ] && continue; echo "{\"type\":\"tool_use\",\"input\":{\"file_path\":\"/logs/reviews/$phase/$attempt/$sib/report.md\"}}" >> "$dir/transcript.log"; done; fi
if in_list fail; then echo "fake-review: $who fails"; exit 1; fi
[ -d "$REVIEW_SNAPSHOT" ] || { echo "no snapshot"; exit 1; }
impl=$(cat "$REVIEW_DIR/implementation_sha")
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
if in_list failAfterReport; then echo "fake-review: $who fails after writing its report"; exit 1; fi
exit 0

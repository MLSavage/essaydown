#!/usr/bin/env bash
# fake-iteration.sh <id> — stands in for `docker compose run claude-task <id>` in the conformance suite.
# Behaviour per task from $RALPH_ROOT/.fake/<id>.json:
#   {"done":true,"journal":true,"commit":true,"failSuite":false,"failCandidate":false,"files":{"path":"content"},"rm":["path"]}
set -euo pipefail
id="$1"; wt="$RALPH_WORKTREE"; log="$RALPH_LOG"; root="$RALPH_ROOT"
ctl="$root/.fake/$id.json"
[ -f "$ctl" ] || ctl=""
get() { if [ -n "$ctl" ]; then node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=c[process.argv[2]];process.stdout.write(v===undefined?process.argv[3]:(typeof v==="string"?v:JSON.stringify(v)))' "$ctl" "$1" "$2"; else printf '%s' "$2"; fi; }
done_=$(get done true); journal=$(get journal true); commit=$(get commit true); failSuite=$(get failSuite false); failCandidate=$(get failCandidate false)
mkdir -p "$(dirname "$log")"
cd "$wt"
if [ "$journal" = "true" ]; then mkdir -p docs/progress; printf -- '- [%s] %s Task: fake iteration %s. Status: Complete. Files: work/%s.txt. Tests: 1/1. Iterations used: %s. First attempt passed: y. Tool calls: 3.\n' "$id" "$(date -u +%FT%TZ)" "$id" "$id" "${RALPH_ATTEMPT:-1}" >> docs/progress/journal-main.md; fi
if [ -n "$ctl" ]; then
  node -e '
const fs=require("fs"),p=require("path");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
for (const [f,content] of Object.entries(c.files||{})) { fs.mkdirSync(p.dirname(f),{recursive:true}); fs.writeFileSync(f,content); }
for (const f of c.rm||[]) fs.rmSync(f,{force:true});
' "$ctl"
fi
if [ "$commit" = "true" ]; then mkdir -p work; echo "work of $id attempt ${RALPH_ATTEMPT:-1}" >> "work/$id.txt"; [ "$failSuite" = "true" ] && touch FAIL_SUITE; [ "$failCandidate" = "true" ] && touch FAIL_CANDIDATE; git add -A; git commit -q -m "wip($id): fake work attempt ${RALPH_ATTEMPT:-1}"; fi
{ echo "{\"type\":\"system\",\"task\":\"$id\"}"; if [ "$done_" = "true" ]; then echo "{\"type\":\"result\",\"result\":\"<promise>DONE $id</promise>\"}"; else echo "{\"type\":\"result\",\"result\":\"not finished\"}"; fi; } > "$log"

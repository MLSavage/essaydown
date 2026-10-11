# Handoff 094: Phase 4, review r2 done, reconciliation 4.5.r2d pending (PRINCIPAL)

Written 2026-10-10 by the principal (Opus 5.5) that continued from 093. Supersedes `093-phase-4-verify-r2h-accepted-review-r2-next.md`. Committed on `handoff/094`, stacked on `handoff/093` (cut from `phase/4` at `2e4248a`). Neither handoff is in `phase/4` yet, so `phase/4..handoff/094` is two docs-only commits (093, then 094), which the reconciliation cherry-picks as one range. Read it with `git show handoff/094:docs/handoffs/094-phase-4-review-r2-reconciliation-pending.md`.

## Current State

- **Branches.**
  - `phase/4` is at `2e4248a` (`task(4.verify.r2)`).
  - `origin/phase/4` is at `2e4248a`, so 0 behind: Michael pushed this block.
  - `main` and `origin/main` are at `8aba511`.
- **Status at writing:** `Phase 4, 4.5.r2d principal-pending; last passed 4.5.r2b; gates open: none; plan requests: none; blocked: none`. `doctor` is clean, and the host checkout is clean.
- **Passed this block:**
  - `4.5.r2a` (Claude, attempt 1): verdict **FAIL**, with 1 blocker, 0 should-fix and 0 nits.
  - `4.5.r2b` (Sol): verdict **PASS**, with 0/0/0. Sol passed on the run after a single-reviewer retry (see Decisions).
  - Both reviewed `2e4248a`.
- **Runner:** stopped at `PRINCIPAL 4.5.r2d`. Pane `essaydown:runner` (pid 8940) is at zsh. The runner's own instruction reads: work in `.wt/4.5.r2d` on `task/4.5.r2d`, commit `wip(4.5.r2d)` with the promise in the commit message, then run it again:
  ```
  tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 4 2>&1 | tee -a .evidence/runner.log' Enter
  ```
- **Watcher:** stopped at rotation. The raw count is 90, and the last counted line is the `[ralph] 4.5.r2d: work in …` line. Re-arm after the restart, recounting `n` first:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=275135; n=K; W=/tmp/essaydown-watch.txt; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] " > "$W" 2>/dev/null; c=$(wc -l < "$W"); if [ "$c" -gt "$n" ]; then tail -n +"$((n+1))" "$W" | cut -c1-400; n=$c; fi; sleep 30; done
  ```
- **Expected next stop:**
  - If r2 passes: `4.close`, which is the idle boundary.
  - If Michael takes the blocker: a fix chain, written by the reconciliation's planning rows (r3 rows as `a`, `b`, `d`, #043).

## Corrections

- **093, "Current State":** `origin/phase/4` is no longer 3 behind. Michael pushed, and it is now 0 behind.
- **093, "Expected next stop":** this is where the runner stopped (`PRINCIPAL 4.5.r2d`), so that part is done.
- **`next-prompt.md` on `handoff/093`, constraints paragraph:** "`USAGE-LIMIT <id>` is a 429 that did not consume an attempt: after the reset, the same `ralph run`" holds for an implementation task (`ralph/lib/run.mjs:128`).
  - A **reviewer** usage limit leaves the reviewer `blocked`, and the runner's own line says `→ after the reset: ralph.sh retry <id>` (`run.mjs:430`).
  - That path is the single-reviewer `retry` (#043). It needs the reviewer's evidence directory moved aside first.
  - The new `next-prompt.md` says so.

## Decisions

- **No new DECISIONS entries this block.**
- **Runner deviation: none.** Sol's usage limit followed the runner's documented reviewer path:
  - Sol's a1 hit the Codex usage limit at 16:35 EEST. The transcript has one `"status":402` (Codex, not Grok), with "try again at 4:09 PM", which was 16:09 UTC.
  - The runner printed `USAGE-LIMIT 4.5.r2 sol (4.5.r2b) … → after the reset: ralph.sh retry 4.5.r2b`.
  - After 16:12 UTC, the principal moved `.evidence/reviews/4/r2/sol` aside to `.evidence/reviews/4/r2/sol.usage-limit-a1`, ran `ralph/ralph.sh retry 4.5.r2b` and restarted `ralph run`. This was the first retry of 4.5.r2b, so it needs no DECISIONS entry (#038).
  - Sol's retry then wrote the report in `.evidence/reviews/4/r2/sol/`.
- **WARN lines for the reconciliation to decide, read or mention (#025, #044):**
  - `WARN 4.5.r2a … (sol ×2)`.
  - `WARN 4.5.r2b … (claude ×1)`.
  - Both quote the tasks.json acceptance string ("…/logs/reviews/4/r2/<sibling>/report.md and status.json exist…"), which suggests a mention and not a read. The same pattern was judged a mention at #review-4-r1. Confirm it from the transcripts.

## Gotchas

- **Claude's r2 blocker (report `.evidence/reviews/4/r2/claude/report.md`, Findings §1):**
  - `hasPandocReadableTitle` (`packages/core/src/sidecar.ts:1384`, with :1315) returns `true` for every entry whose `value` is `null`. That includes the whole-block `malformed` entry that `readFrontMatter` returns when any other line falls outside the app's line grammar.
  - The commonest trigger is valid YAML: `tags:` followed by `- essay` at column 0. With it, `title:`, `title: ""` and `title: ~` send no stem, and the EPUB gets an empty `dc:title` (RSC-005) while export reports success.
  - Claude observed the predicate's output in scratch. The pandoc run on that exact document was read and not run, since r2 allowed no new probe.
  - A rarer second route is the quoted key `"title":` (an unsupported `""` falls through to `true`).
  - Claude proposes a fix and guards. This is r2 scope (1)'s own three spellings, not the backlogged block-scalar `|`/`>` member.
- **A blocker found in a late review attempt is Michael's before any fix chain** (#041 D1, 4.5.r2d's own text). Put it to him with the Fable brief's answer and the facts. Never plan the chain first.
- **Before taking it to Michael, consider a principal container probe** on the exact `title:` + `tags:\n- essay` document (pandoc + epubcheck in the container, the way #review-4-r1's probe was run). It turns Claude's "read, not run" into an observation.
- **Sol's a1 partial evidence** sits in `.evidence/reviews/4/r2/sol.usage-limit-a1/`. Its probes ran (`title-probe.*`, `confirmation-*`), but it wrote no report. Only `sol/` counts. Treat `sol.usage-limit-a1/` as context, not as a review.
- **Michael travels the week after 2026-10-10, and the Mini is powered off for the trip.** Never power off mid-gate. Rotate at an idle stop with the exact restart point.

## Next Steps

1. Run `status` and `doctor`. Check the unpushed count (0 at writing).
2. Reconcile `4.5.r2d` in `.wt/4.5.r2d` on `task/4.5.r2d`:
   - Run `git cherry-pick handoff/093 handoff/094`, in that order, or the range `phase/4..handoff/094`.
   - Write a Fable brief on `.evidence/reviews/4/r2/{claude,sol}/`. The one question: is Claude's finding 1 a blocker under #041 D1, and what is the minimal fix scope?
   - Optionally run the container probe first.
   - Take the blocker to Michael with options.
3. Commit `#review-4-r2` in DECISIONS.md. The same commit appends its own `- [4.5.r2d] ` journal line. If Michael takes the fix, the commit adds the fix rows (`4.33` → `4.verify.r3` (+h) → `4.5.r3a/b/d`), rewires `4.close`, and updates `EXPECTED_COUNT`. The promise goes only in the `wip(4.5.r2d)` commit message. Then restart `ralph run` and re-arm the watcher.
4. After `4.close`, at the idle boundary: run `git branch -D` on the `handoff/*` refs whose content is in `phase/4`, and rotate with the `pbcopy < docs/handoffs/next-prompt.md` relaunch line.

## Open Questions

- **For Michael, at the reconciliation:** take Claude's r2 blocker (malformed-block `title:` → empty EPUB title) as a fix chain, or backlog it with a trigger. The Fable brief and the optional probe come first.
- At the Phase 4 → 6 boundary: the `[review-4-r0, dispositions]` items with that trigger (G4–G12).

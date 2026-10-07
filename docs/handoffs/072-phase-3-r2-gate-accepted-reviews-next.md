# Handoff 072: Phase 3, r2 gate accepted → restart for `3.7.r2a`/`r2b`

Written 2026-10-06 by the principal, the Opus 5.5 session that continued from 071. It ran the r1 reconciliation, restarted the runner through 3.27 and 3.verify.r2, ran the `3.verify.r2h` gate (ACCEPT a1), and rotated at `ROTATE-PRINCIPAL`. This handoff supersedes `071-phase-3-r1-reconciliation-pending.md`.

This commit is on `handoff/072`, cut from `phase/3` at `b56c23c`. Handoffs 067–071 are already in `phase/3` (cherry-picked by the 3.7.r1d reconciliation), so the next reconciliation cherry-picks `phase/3..handoff/072` (one commit, `docs/handoffs/` only). Read this handoff with `git show handoff/072:docs/handoffs/072-phase-3-r2-gate-accepted-reviews-next.md`. The next handoff is `073-*.md`.

## Current State

- **Branches.**
  - `phase/3` is at `b56c23c` `task(3.verify.r2)`. Origin is at `4dfce92`, so `phase/3` is 3 ahead (`6aa21a9` 3.7.r1d, `85b4341` 3.27, `b56c23c` 3.verify.r2). Michael has not pushed them yet.
  - `main` is at `da7d07b`.
  - Handoff refs: `handoff/072` (this). `handoff/061`–`071` are stale (their content is in `phase/3`); delete them after `3.close`.
- **Status:** `Phase 3, idle; last passed 3.verify.r2h; gates open: none; plan requests: none; blocked: none`. `doctor` is clean.
- **Passed since 071:**
  - `3.7.r1d`: the r1 reconciliation, verdict FAIL on C14 (DECISIONS `#review-3-r1`). Michael chose "Fix as 3.27 + r2 (Recommended)".
  - `3.27`: opus, attempt 1, the C14 fix in `packages/core/src/format.ts` (branch (i) resource form, branch (ii) escaped text).
  - `3.verify.r2`: sonnet, attempt 1.
  - `3.verify.r2h`: `ACCEPT a1`, ci.yml run 37510720877, run by `scripts/gate.sh 3.verify.r2h` in this session.
- **Next tasks:** `3.7.r2a` (claude) and `3.7.r2b` (sol) run in parallel. Their scope is blockers only: confirm C14 is fixed, with one probe each, reading `/logs/ci/3.verify.r2h/accepted/`. Then `PRINCIPAL 3.7.r2d`, and `3.close` depends on `3.7.r2d`. `EXPECTED_COUNT` is 363.
- **Runner:** idle after `HUMAN_GATE 3.verify.r2h` and the gate's `ROTATE-PRINCIPAL`. Pane `essaydown:runner` (pid 8940) is at `zsh`, and `.locks/` is empty. runner.log has 261460 lines.
  - Restart: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 3 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher:** stopped at rotation. On restart, arm a persistent Monitor (30-minute cap) with `start=` set to `wc -l < .evidence/runner.log` + 1, read at restart:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=START; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  `START` is the number you compute. Write the digits in, never the word.
- **Expected next stop:** `PRINCIPAL 3.7.r2d` after both reviewers pass. A `WARN 3.7.r2b` naming the claude path is likely, from sol's own task text echoed, as at r0c and r1b.

## Corrections

- **`071`, Next Steps 4** said to run `ralph run` after the reconciliation commit, and the prompt said to follow #051. #051's manual `sync-state` does not apply to a reconciliation that the runner integrates: the runner refreshes its cached spec itself (`ralph/lib/run.mjs:202`). `next-prompt.md` now says so.
- **`071`'s "Unmerged handoff refs: 067–071"** is now stale: their content is in `phase/3` via `6aa21a9`.

## Decisions

- **DECISIONS `#review-3-r1`** (in `6aa21a9`):
  - Verdict FAIL. Claude FAIL 1/0/0, Sol PASS 0/0/0.
  - `WARN 3.7.r1b` is a mention: all 6 hits are the tasks.json acceptance string.
  - Fable traced C14 from the installed handlers. Its fix shape and its "no other container" enumeration were adopted.
  - Michael's answer was "Fix as 3.27 + r2 (Recommended)".
  - The graph adds 3.27, 3.verify.r2 (+h) and 3.7.r2a/b/d. `EXPECTED_COUNT` went 357 → 363.
  - Two lessons were recorded and none promoted.
  - Claude's two riskiest things are recorded for the Phase 3→4 boundary, not as findings: the source burst during an awaited flush (`document-sync.ts:239–272`), and the occurrence-shift between duplicate sentences (`sidecar.ts:221`, `:391`).
- No runner deviation this block.

## Gotchas

- `scripts/gate.sh` is backgrounded with its output in a scratchpad file. It took about 35 minutes this time.
- After a `HUMAN_GATE` stop and an ACCEPT, the runner is idle: it needs a plain `ralph run` restart. That is not a #051 case, because tasks.json did not change.
- Never quote the literal promise in any file an agent reads.

## Next Steps

1. Run `status` (expect `idle; last passed 3.verify.r2h`) and `doctor` (expect clean). Give Michael the one-line state and `git push origin phase/3` (3 ahead; recount first).
2. Restart the runner and arm the watcher as above.
3. At `PRINCIPAL 3.7.r2d`, a fresh session runs the reconciliation in `.wt/3.7.r2d` on `task/3.7.r2d`:
   - cherry-pick `phase/3..handoff/072` (or the newest handoff ref);
   - copy the two reports to `docs/reviews/phase-3-r2-{claude,sol}.md`;
   - brief Fable (a written brief) on the verdict;
   - decide any WARN as read or mention;
   - write DECISIONS `#review-3-r2` and regenerate progress.md's current state;
   - commit as `wip(3.7.r2d)`, with the promise only in the message and its own `- [3.7.r2d] ` journal line (check the last byte first).
   - On PASS, no planning rows; `3.close` follows. On a blocker, it goes to Michael before any planning commit (#041 D1).
4. At the Phase 3→4 boundary, raise the Open Questions below.

## Open Questions

- **Michael (Phase 3→4 boundary, carried from 067–071):**
  - Fable's both-legs rule for e2e/shell tasks.
  - Which re-pointed hard stops become tasks before `4.verify`: the coverage glob G7/U10/C12, `packages/modes` G1, the typescript range U26/G6.
  - Whether any line of 3.26's `[3.26, other single-it corpus sweeps on the default budget]` list should be taken before `4.verify`.
  - New from r1 (`#review-3-r1`, not findings): whether the source-view burst during an awaited flush, and the §6.2 occurrence-shift between duplicate sentences, become Phase 4 tasks or backlog lines.

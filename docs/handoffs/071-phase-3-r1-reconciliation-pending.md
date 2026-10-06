# Handoff 071: Phase 3, r1 reviews done → `PRINCIPAL 3.7.r1d` (claude FAIL, one blocker)

Written 2026-10-06 by the principal, the Opus 5.5 session that continued from 070. It restarted the runner, which ran `3.7.r1a` and `3.7.r1b`, and rotated at `PRINCIPAL 3.7.r1d`. This handoff supersedes `070-phase-3-r1-gate-accepted-reviews-next.md`.

This commit is on `handoff/071`, stacked on `handoff/070` → `069` → `068` → `067`. None of them is in `phase/3`, so the reconciliation cherry-picks `phase/3..handoff/071` (five commits, all `docs/handoffs/` only). Read this handoff with `git show handoff/071:docs/handoffs/071-phase-3-r1-reconciliation-pending.md`. The next handoff is `072-*.md`.

## Current State

- **Branches.**
  - `phase/3` is at `4dfce92` `task(3.verify.r1.g1)`, level with origin. Michael pushed it this block (`974febe..4dfce92`).
  - `main` is at `da7d07b`.
  - Unmerged handoff refs: `handoff/067`–`071`. `handoff/061`–`066` are stale; delete them after `3.close`.
- **Status:** `Phase 3, 3.7.r1d principal-pending; last passed 3.7.r1b; gates open: none; plan requests: none; blocked: none`. `doctor` is clean.
- **Passed since 070:** `3.7.r1a` (claude, attempt 1) and `3.7.r1b` (sol, attempt 1). The two ran in parallel.
- **Reviews, both at `implementation_sha` `4dfce92`, evidence `.evidence/reviews/3/r1/{claude,sol}/`:**

  | reviewer | verdict | blockers | should-fix | nits |
  |---|---|---|---|---|
  | claude | FAIL | 1 | 0 | 0 |
  | sol | PASS | 0 | 0 | 0 |

  - **Claude's one blocker is C14, reproduced** (report finding 1): `packages/core/src/format.ts:1293–1295`, `installAutolinkFallback`'s `link` wrapper, with `:1235` `autolinkCarriesUrl`.
    - The repro: a URL holding `|` typed into a table cell (` https://a.b/x|y` after `c`, through the input-rule route).
    - Save 2 writes `<https://a.b/x|y>`. The built-in `<…>` branch empties `state.stack`, so the gfm-table `|` unsafe pattern never fires and the row splits.
    - Save 3 widens the table to three columns, breaking invariant B through the writing surface.
    - The report proposes a fix and guards: take `asResourceLink` inside a `tableCell` when the value has `|`, make the bare-literal path agree, add a typed member, a hand-built member and astral members, and add the cell class to the URL corpus leg (M1).
- **Runner:** stopped at `PRINCIPAL 3.7.r1d`. Pane `essaydown:runner` (pid 8940) is at `zsh`, and `.locks/` is empty. runner.log has 257227 lines; the last `[ralph]` line (257227) names `.wt/3.7.r1d` on `task/3.7.r1d`.
  - `.wt/3.7.r1d` exists at `4dfce92`, clean.
  - Restart (after the reconciliation commit): `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 3 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher:** stopped at rotation. On restart, arm a persistent Monitor (30-minute cap) with `start=` set to `wc -l < .evidence/runner.log` + 1, read at restart:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=START; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  `START` is the number you compute. Write the digits in, never the word.
- **Expected next stop:** none until the reconciliation is committed. The task stays principal-pending until Michael answers on the blocker.

## Corrections

- **`070`, Current State "Branches":** it says "`9de2027` was the last pushed". Wrong: origin was at `974febe` (3.24), and the push went `974febe..4dfce92`. The count of 5 ahead was right.

## Decisions

- No DECISIONS entries and no runner deviation this block.
- **`WARN 3.7.r1b` (runner.log:257225):** sol's transcript names the claude report path twice. The quoted text is sol's own task text echoed ("read no sibling directory of this attempt"), not a read of the sibling report. Under #025/#044 the reconciliation decides read or mention; the evidence so far points to mention.

## Gotchas

- **C14 was already filed as the r0 disposition** that Claude's gate-table row (4) flags ("pass, except C14"). r1 now reproduces it with wrong bytes reaching the file, which is #041 D1's blocking class. Because it was found in a late review attempt, it is Michael's before any fix chain.
- **Mark-edge/delimiter rule:** a fix touches `format.ts`'s link handler, so the fix task reads the installed `mdast-util-to-markdown` link/autolink handler and `mdast-util-gfm-table`'s unsafe patterns first (CLAUDE.md, #review-1-r4 J1, #review-1-r7 M1).
- **Never quote the literal promise** in any file an agent reads.

## Next Steps

1. In a fresh session, run `status` (expect `3.7.r1d principal-pending`) and `doctor` (expect clean).
2. In `.wt/3.7.r1d` on `task/3.7.r1d`:
   - cherry-pick `phase/3..handoff/071`;
   - copy the reports to `docs/reviews/phase-3-r1-{claude,sol}.md`;
   - read both reports (they read `/logs/ci/3.verify.r1.g1h/accepted/`);
   - brief Fable (written brief, PRINCIPAL.md) on the verdict: is C14 blocking under #041 D1, and the shape of the fix task (scope, guards, which gate follows);
   - decide the `WARN 3.7.r1b` read-or-mention.
3. Bring the C14 blocker and Fable's answer to Michael before any planning commit. The task stays principal-pending until he answers.
4. On his answer:
   - the planning rows (a fix task, a `3.verify.r2`/gate pair, and `3.7.r2a`/`r2b`/`r2d`, written as `a`, `b`, `d` per #043) go in the reconciliation commit with `EXPECTED_COUNT`;
   - commit as `wip(3.7.r1d)` with the promise only in the message and its own `- [3.7.r1d] ` journal line (check the journal's last byte first);
   - then `ralph run`, and arm the watcher.
5. Raise the Phase 3→4 boundary questions below when the phase closes.

## Open Questions

- **Michael (now):** C14. Fix it in Phase 3 as one task plus an r2 review, or take another route he names. The reconciliation needs his answer.
- **Michael (Phase 3→4 boundary, carried from 067–070):**
  - Fable's both-legs rule for e2e/shell tasks.
  - Which re-pointed hard stops become tasks before `4.verify`: the coverage glob G7/U10/C12, `packages/modes` G1, the typescript range U26/G6.
  - Whether any line of 3.26's `[3.26, other single-it corpus sweeps on the default budget]` list should be taken before `4.verify`.

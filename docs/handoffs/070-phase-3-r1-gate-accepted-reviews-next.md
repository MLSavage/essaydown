# Handoff 070: Phase 3, `3.verify.r1.g1h` ACCEPT → r1 reviews next

Written 2026-10-06 by the principal, the Opus 5.5 session that continued from 069. It resolved `PLAN-GATE plan.3.verify.r1h.r1`, ran the runner through 3.25, 3.26 and `3.verify.r1.g1`, and saw the gate accept. This handoff supersedes `069-phase-3-verify-r1-gate-failed-a2.md`.

This commit is on `handoff/070`, stacked on `handoff/069` → `068` → `067`. None of them is in `phase/3`, so the reconciliation cherry-picks `phase/3..handoff/070` (four commits, all `docs/handoffs/` only). Read this handoff with `git show handoff/070:docs/handoffs/070-phase-3-r1-gate-accepted-reviews-next.md`. The next handoff is `071-*.md`.

## Current State

- **Branches.**
  - `phase/3` is at `4dfce92` `task(3.verify.r1.g1)`, 5 commits ahead of origin (`9de2027` was the last pushed).
  - `main` is at `da7d07b`.
  - Unmerged handoff refs: `handoff/067`–`070`. `handoff/061`–`066` are stale; delete them after `3.close`.
- **Status:** `Phase 3, idle; last passed 3.verify.r1.g1h; gates open: none; plan requests: none; blocked: none`. `doctor` is clean.
- **Passed since 069:**
  - `plan.3.verify.r1h.r1` → `53388aa`;
  - 3.25 → `7cab8d7` (attempt 2; attempt 1 capped at 81 turns);
  - 3.26 → `c819626` (attempt 1);
  - `3.verify.r1.g1` → `4dfce92` (attempt 1);
  - `3.verify.r1.g1h` ACCEPT at a1.
- **Gate `3.verify.r1.g1h` a1, run `37470253060`, evidence `.evidence/ci/3.verify.r1.g1h/a1/`:**

  | | Vitest | cargo | e2e-shell |
  |---|---|---|---|
  | ubuntu | 7236/7236 | 78/0 | 79 ✓ / 0 ✖ |
  | macOS | 7236/7236 | 78/0 | 79 ✓ / 0 ✖ |
  | Windows | 7236/7236 | 75/0 | 79 ✓ / 0 ✖ |

  - source-toggle (1) is green on ubuntu.
  - macOS `autosave.spec.ts:92` is green, as is the `:44` "an edit is on disk…" case on all three OSes.
  - Windows C16 (`autosave.spec.ts:192`) did not recur.
- **Runner:** stopped. Pane `essaydown:runner` (pid 8940) is at `zsh`, `.locks/` is empty. `ralph run` stopped at `HUMAN_GATE 3.verify.r1.g1h`. `gate.sh` printed `ROTATE-PRINCIPAL` after the ACCEPT, in its own output, not in runner.log. runner.log has 257224 lines.
  - `ralph/ralph.sh run --phase 3 --dry-run` names `next: 3.7.r1a (reviewer, claude-opus) on (snapshot worktree .wt/review-claude) from phase/3`.
  - Restart: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 3 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher:** none is running. At restart, arm it as a persistent Monitor (30-minute cap) with `start=` set to `wc -l < .evidence/runner.log` + 1, read at restart:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=START; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  `START` is the number you compute. Write the digits in, never the word.
- **Expected next stops:** `3.7.r1a` (claude), then `3.7.r1b` (sol), then `PRINCIPAL 3.7.r1d`.

## Corrections

- **`069`, Gotchas "The planning commit" and the 069 `next-prompt.md` step 3:**
  - "If it appends to DECISIONS.md, rebase `handoff/067`–`069`": no rebase was needed. #039's condition is that the *stack* carries a DECISIONS.md tail, and 067–069 touch only `docs/handoffs/`. `phase/3..handoff/070` selects exactly the four handoff commits.
  - "Then `sync-state`": a plan request integrated by the runner runs `syncState(…, allowSupersede)` itself (`ralph/lib/run.mjs:250`). #051's manual `sync-state` applies only to planning commits made outside the runner. The dry run naming `plan request plan.3.verify.r1h.r1` was the restart condition.
- **`069`, Next Steps 2–4:** done (below).

## Decisions

- **DECISIONS #055** (in `53388aa`, on `phase/3`): the a1→a2 rerun in #046's shape; Fable's answer on `.r1`; Michael's fold-in of autosave `:92`.
  - **Graph:** 3.25, 3.26, `3.verify.r1.g1`/`g1h`; `3.7.r1a`/`r1b` rewired to `3.verify.r1.g1h`; `EXPECTED_COUNT` 353 → 357.
  - **Fable:**
    - source-toggle (1) gets a caret-and-focus precondition before the first chord, plus two named waits in `toggleTo`. Fable revised its r0 premise: case (6) makes the same unconfirmed click and stays green, so the cause is the first click after the reload.
    - 3.24 is not implicated in autosave `:92`.
    - The #039 pair is taken now as 3.26, because it did time out on Windows at a1.
  - **Michael:** "1" (fold autosave `:92` into 3.25) and "confirm the PRD's 600 ms requirement covers only :91's subject, not the sidecar." Confirmed and recorded: PRD 2.5's acceptance times only the `.md`. `:92` now polls for a parseable sidecar under the spec's 3000 ms file-state bound.
- **Backlog lines appended by the tasks:**
  - `[3.25, source-toggle (6) keeps the unconfirmed click]`;
  - `[3.26, other single-it corpus sweeps on the default budget]`.
  - Handoff 069's two drafted lines were superseded by 3.25/3.26 and not appended.
- **No runner deviation this block.**

## Gotchas

- **3.25 a1's recovery commit carried a mutation** (the `project-recovery-commit-can-carry-a-mutation` memory). Attempt 1 hit the turn cap mid-mutation. `wip(3.25): recovery of uncommitted changes` (`ed8bc51`) left case (1) on a bare `caretAtText` with `caretAtHeading()` unused. Attempt 2 noticed it in its first turns and restored it. Verified on `phase/3`: `source-toggle.spec.ts:312` calls `caretAtHeading()`, and `:428` (case 6) keeps the unconfirmed click.
- **The r1 reviewers read `/logs/ci/3.verify.r1.g1h/accepted/`.** `3.verify.r1h` is superseded; its a1/a2 directories are both rejected.
- **A note for the r1 reconciliation (#055), not a finding:** `apply-move-block.test.ts` slowed after 3.22.
- **Never quote the literal promise** in any file an agent reads.

## Next Steps

1. Run `status` (expect idle, last passed `3.verify.r1.g1h`), `doctor` (clean), `git status --short` (empty, on `phase/3`) and the dry run (expect `3.7.r1a`). Give Michael the one-line state.
2. Restart the runner with the command above and arm the watcher. On every expiry: re-arm, run `status`, run a catch-up grep from the same start, and report only lines not already reported. Expect `3.7.r1a` (claude) and `3.7.r1b` (sol).
   - A single-reviewer failure is `ralph/ralph.sh retry <id>` of that reviewer alone (#043).
   - `USAGE-LIMIT` → after the reset, the same `ralph run`.
3. At `PRINCIPAL 3.7.r1d`, rotate. A fresh session runs the reconciliation in `.wt/3.7.r1d` on `task/3.7.r1d`:
   - cherry-pick `phase/3..handoff/070` (or the newest unmerged handoff ref);
   - copy the reports to `docs/reviews/phase-3-r1-{claude,sol}.md`;
   - brief Fable on the verdict;
   - under #041 D1, an r1 blocker (C14's table-cell probe included) goes to Michael before any planning commit.
   - On PASS the next stop is `3.close`.
4. Hand Michael `git push origin phase/3` when convenient (5 commits ahead now).

## Open Questions

- **Michael (Phase 3→4 boundary, carried from 067–069):**
  - Fable's both-legs rule for e2e/shell tasks.
  - Which re-pointed hard stops become tasks before `4.verify`: the coverage glob G7/U10/C12, `packages/modes` G1, the typescript range U26/G6.
  - Whether any line of 3.26's `[3.26, other single-it corpus sweeps on the default budget]` list should be taken before `4.verify`, rather than waiting for its 80% trigger.
- The #039 pair and macOS autosave `:92` are resolved by 3.26/3.25. They are no longer open.

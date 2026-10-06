# Handoff 068: Phase 3, `3.verify.r1h` GATE-FAILED → `PLAN-GATE plan.3.verify.r1h.r0`

Written 2026-10-06 by the principal, the Opus 5.5 session that continued from 067. That session ran the gate once. It failed, and the session rotated right away, as 067 says to: the next session briefs Fable. This handoff supersedes `067-phase-3-verify-r1-gate.md`.

This commit is on `handoff/068`, stacked on `handoff/067`. Neither ref is in `phase/3` yet, so the next reconciliation cherry-picks `phase/3..handoff/068`. Read this handoff with `git show handoff/068:docs/handoffs/068-phase-3-verify-r1-gate-failed.md`. The next handoff is `069-*.md`.

## Current State

- **Branches.**
  - `phase/3` is at `9de2027` `task(3.verify.r1)`, 1 commit ahead of origin.
  - `main` is at `da7d07b`.
  - Unmerged handoff refs: `handoff/067` (`97babfb`) and `handoff/068` (this commit). `handoff/061`–`066` are integrated by cherry-pick and stale; delete them after `3.close`.
- **Status:** `Phase 3, idle; last passed 3.verify.r1; gates open: none; plan requests: plan.3.verify.r1h.r0:pending; blocked: 3.verify.r1h:blocked`. `doctor` is clean.
- **Gate `3.verify.r1h` attempt 1: GATE-FAILED.**
  - Run `37450257728` at `9de2027`. Evidence is in `.evidence/ci/3.verify.r1h/a1/`: `workflow.log`, `test-logs/`, `e2e-shell/`, `run.json`.
  - **Vitest:** ubuntu 7170/7170 and macOS 7170/7170 passed. Windows had 2 failed, 7168 passed, both timeouts:
    - `packages/core/test/rewrite.test.ts:143`, "applyUseVariant > the no-op variant re-serialises byte-identically for every fixture (corpus identity)". It timed out at **30000 ms**, and the file took 39.8 s.
    - `packages/core/test/sentences-zero-width.test.ts:247`, "corpus-wide identity invariant … runs over every fixture the index lists". It timed out at **5000 ms**, Vitest's default, so this test has no block-local 30 s budget (#039).
  - **cargo test:** green on all three OSes (78 passed in the main crate).
  - **e2e-shell:** macOS 15/15 and Windows 15/15 spec files passed. Windows `autosave.spec.ts` passed, so C16 did not recur. Ubuntu had 14/15: `source-toggle.spec.ts` test (1), "Cmd/Ctrl+/ shows the source view …", failed with `Cmd/Ctrl+/ never showed the source view focused` at `toggleTo` (`source-toggle.spec.ts:88`, called from `:268`). Tests (2)–(6) and both guards in the same file passed.
  - **None of the three test files changed since the last accepted gate** (`3.verify.g1h`, success). Their last commits are `rewrite.test.ts` at `14e7a71` (3.4), `sentences-zero-width.test.ts` at `b86edca` (0.14) and `source-toggle.spec.ts` at `10225bf` (3.19). The code under them did change in 3.22–3.24.
- **Runner:** stopped. Pane `essaydown:runner` (pid 8940) is at `zsh`, with no `ralph run` and an empty `.locks/`. runner.log has 251698 lines, the last two being `HUMAN_GATE 3.verify.r1h` and `ROTATE-PRINCIPAL` from the previous block. `gate.sh` printed its signals to its own output, not to runner.log. Restart only after the plan request resolves: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 3 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher:** none is running. After a restart, arm it as a persistent Monitor (30-minute cap) with `start=` set to `wc -l < .evidence/runner.log` + 1, read at restart:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=START; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  `START` is the number you compute. Write the digits in, never the word.
- **Expected next stop:**
  - On a `.g1` repair: the runner runs `3.verify.r1.g1`, then `HUMAN_GATE 3.verify.r1.g1h`.
  - On a same-SHA rerun that passes: the runner restarts into `3.7.r1a`/`3.7.r1b`, then `PRINCIPAL 3.7.r1d`.

## Corrections

- `067` Next Steps 2 and `next-prompt.md` (067's version): the gate ran and failed, so the ACCEPT branch did not happen. The restart and watcher steps wait for the plan request.
- `067` Current State, the "on failure" stop: `gate.sh` printed `GATE-FAILED 3.verify.r1h a1`, `PLAN-GATE plan.3.verify.r1h.r0` and `ROTATE-PRINCIPAL` to its own output. They are not in runner.log, so a catch-up grep of runner.log will not show them.

## Decisions

- No DECISIONS entry and no runner deviation this block. The gate was run once, and nothing was retried or planned.

## Gotchas

- **Transient or code?**
  - **For a rerun:** none of the three failing tests changed since the last accepted gate. Windows Vitest timeouts and a first-test e2e focus miss are timing-shaped, and macOS and ubuntu ran the same Vitest files green. A same-SHA rerun (RUNNER-SPEC §2) is allowed only if the failure is transient.
  - **Against a rerun:** `sentences-zero-width.test.ts:247` runs a corpus loop under the default 5 s budget. That is a latent #039 violation (the family budget is 30 s with a block-local oracle), and it can fail again on any slow Windows runner. `rewrite.test.ts:143` exceeded even 30 s, so check whether 3.22's sidecar re-anchor made the no-op variant path slower per fixture.
  - **Ubuntu source-toggle (1):** the first toggle in the spec never saw the source view focused. 3.24 changed the source window and watcher, so check whether 3.24 touched focus or the toggle path before calling it transient.
  - **Fable decides** this on the `PLAN-GATE` brief. A tree change, even a test budget alone, is a `.g1` repair scoped to what failed. Everything else is filed with a revisit trigger.
- **The planning commit** goes only on `plan/3.verify.r1h/r0` in `.wt/plan.3.verify.r1h.r0` via `ralph/ralph.sh plan`. If it appends to DECISIONS.md and lands on `phase/3` before the reconciliation, rebase `handoff/067`+`068` onto the new tip (#039) from a temporary worktree.
- **A rerun's evidence goes to `a2/`.** Read `.evidence/ci/3.verify.r1h/a1/` before rerunning.
- **Never quote the literal promise** in any file an agent reads.

## Next Steps

1. Run `status` (expect `plan.3.verify.r1h.r0:pending`, `3.verify.r1h:blocked`), `doctor` (clean) and `git status --short` (empty, on `phase/3`). Give Michael the one-line state.
2. Brief Fable (`PLAN-GATE plan.3.verify.r1h.r0`), as a written brief. It covers:
   - the signal;
   - the evidence paths (above);
   - the three failures, with their timeouts and the unchanged-test facts;
   - the 3.22–3.24 diffs touching rewrite, sidecar and the source toggle (`git diff e21d6f8..9de2027 --stat`);
   - the one question, "same-SHA rerun or `.g1` repair, and if a repair, its exact scope";
   - the answer format: decision, reasons, confidence, commands.
3. Act on the answer:
   - **Rerun:** follow RUNNER-SPEC §2's same-SHA rerun.
   - **Repair:** plan it via `ralph/ralph.sh plan`. The repair scopes to the failing tests and their cause, and if a test budget changes, gives a block-local 30 s per #039. Then `sync-state` and `run --phase 3 --dry-run` (#051) and restart only when the dry run names `3.verify.r1.g1`.
4. Arm the watcher at restart. Expect 3.7.r1a/b after an accepted gate, then `PRINCIPAL 3.7.r1d`, which is a rotation followed by a fresh-session reconciliation:
   - cherry-pick `phase/3..handoff/068`;
   - copy the reports to `phase-3-r1-{claude,sol}.md`;
   - D1: an r1 blocker (C14 included) goes to Michael first.
5. Hand Michael `git push origin phase/3` when convenient (1 commit ahead now).

## Open Questions

- **Michael (Phase 3→4 boundary, carried from 067):**
  - Fable's both-legs rule for e2e/shell tasks.
  - Which re-pointed hard stops become tasks before `4.verify`: the coverage glob G7/U10/C12, `packages/modes` G1, and the typescript range U26/G6.
- **Michael, if Fable calls a rerun:** whether the default-budget corpus test at `sentences-zero-width.test.ts:247` goes to the backlog with a trigger (its next Windows timeout) or becomes a task before `4.verify`.

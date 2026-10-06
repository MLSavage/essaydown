# Handoff 065: Phase 3, `3.verify.g1h` ACCEPT → review set `3.7` r0 running

Written 2026-10-06 by the principal, the Opus 5.5 session that continued from 064. That session briefed Fable on `PLAN-GATE plan.3.verifyh.r0` and made the planning commit. It watched 3.21 (a2), 3.verify.g1 (a1) and the gate `3.verify.g1h` (ACCEPT a1). It restarted the runner into the review set and rotated at `ROTATE-PRINCIPAL`. This handoff supersedes `064-phase-3-verify-gate-failed.md`.

This commit is on `handoff/065`, stacked on `handoff/064` → `handoff/063` → `handoff/062` → `handoff/061` (none is in `phase/3`). It was made from a temporary worktree. Read it with `git show handoff/065:docs/handoffs/065-phase-3-review-r0-running.md`. The next handoff is `066-*.md`.

## Current State

- **Branches.**
  - `phase/3` is at `552f186` `task(3.verify.g1)`, 6 commits ahead of origin `phase/3` (`git rev-list --count origin/phase/3..phase/3`): 3.19, 3.20, 3.verify, the plan `fe8d333`, 3.21 `d4fddeb`, and 3.verify.g1 `552f186`.
  - `main` is at `da7d07b`.
  - The stack `handoff/061` → `handoff/062` → `handoff/063` → `handoff/064` → `handoff/065` (this commit) is what the `3.7.r0d` reconciliation cherry-picks: `phase/3..handoff/065`.
  - Kept as evidence: `abandoned/3.6`, `abandoned/3.10`, `abandoned/3.13`, `attic/3.1-pre051`.
- **Status:** `Phase 3, 3.7.r0a running attempt 1, 3.7.r0b running attempt 1, 3.7.r0c running attempt 1; last passed 3.verify.g1h; gates open: none; plan requests: none; blocked: none`. `doctor` is clean. `EXPECTED_COUNT` is 345.
- **This block (attempts):**
  - **Plan `plan.3.verifyh.r0`:** `c7d98ba` on `plan/3.verifyh/r0`, integrated by the runner as `fe8d333`. It adds 3.21, 3.verify.g1 and 3.verify.g1h, and rewires `3.7` → `3.verify.g1` (so r0a/b/c depend on `3.verify.g1h`). No DECISIONS.md change, so the stack was not rebased.
  - **3.21, a2 (`d4fddeb`):** a test-only repair of three embedded-provider route defects in `e2e/shell/test/routes.ts`:
    - (a) named-key chords carried no modifier;
    - (b) offsets were read over reveal-widget text;
    - (c) `reloadPage` returned before the old document was gone.
  - **3.21 a1** stopped at a clean break on a fourth defect. Rewrite's Cmd/Ctrl+Z case was red on embedded because `clickCentreOf` focused a variant radio at a stale point. a2 fixed it in routes.ts (focus resolved before the press). There is no `apps/` change. The container showed embedded 15/15 and external 15/15.
  - **3.verify.g1, a1 (`552f186`).**
- **The gate: `3.verify.g1h` ACCEPT a1.** CI run 37435569464; evidence in `.evidence/ci/3.verify.g1h/a1/`.

  | OS | unit | cargo | e2e-shell |
  |---|---|---|---|
  | ubuntu | 6910 | 78 | 15/15 |
  | macOS (required, #047) | 6910 | 78 | 15/15 |
  | Windows (recorded) | 6910 | 75 | 14/15 |

  - The Windows failure is `autosave.spec.ts` "a truncate then a rewrite 300 ms later is one reload, not two" ("the rewritten file never showed"). That case passed at `3.verifyh` a1, so it is a different failure from a1's.
- **Fable's diagnosis** (PLAN-GATE trigger, written brief): no app defect, no product call. Fable read the plugin source from the `tauri-plugin-wdio-webdriver` 1.4.0 crate.
- **Runner:** `ralph run --phase 3` is live in tmux pane `essaydown:runner` (pid 8940, `node`). It restarted at runner.log line 244188. The dry run named `3.7.r0a`. If the runner exits, restart with `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 3 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher:** stopped at rotation. Arm it at `start=244189` as a persistent Monitor (30-minute cap):
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=244189; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  - No `[ralph]` line had been printed since line 244189 at rotation; the reviewers run in parallel.
  - On every expiry, re-arm with each already-reported line in a `grep -v -F -e …` list. Never add a free-text term to its filter.
- **Expected next stop signal:** `PRINCIPAL 3.7.r0d`, after 3.7.r0a (claude-opus), r0b (sol) and r0c (grok). Possible earlier signals: `USAGE-LIMIT` for a reviewer, or `WARN` (sibling-report mention, #044).

## Corrections

- `064` Current State, "Expected next stop signal … `HUMAN_GATE` on the new gate (`3.verify.g1h`, or the id the protocol gives)": the gate id was `3.verify.g1h` and it accepted at a1.
- `064` Gotchas, the suspected typing/chord class: two of the three causes were the embedded provider's named-key events (no modifiers) and its non-blocking refresh. The third was widget text in offsets. A fourth, the stale focus point in `clickCentreOf`, was found by 3.21 itself.
- `064` Next Steps 3, "`sync-state` … before the restart": a plan request is integrated by the runner, which runs `syncState` with the gate superseded (`ralph/lib/run.mjs:252`). The manual `sync-state` (#051) applies only to planning commits made outside the runner. This session skipped it, and the dry run named the plan request.

## Decisions

- **No DECISIONS.md entry** and no runner deviation this block.
- **The planning commit** (`fe8d333`) took Fable's rows with two principal edits to 3.21's description:
  - If the pre-fix repro of (a) or (b) fails, the agent stops and journals.
  - The `refresh`/`execute*` command-log check in guard (c) was dropped (it was not in the acceptance).

## Gotchas

- **Backlog item to file at the reconciliation (not filed yet).** `apps/desktop/src/modes/undo-keys.ts:18` returns early for every `INPUT` target. So Cmd/Ctrl+Z after picking a Rewrite variant by its radio does nothing on Windows and Linux, where a click focuses a radio. The handler's own doc comment says only a text field keeps native undo. It is not a D1 blocker (no lost text).
  - Michael was asked whether to take "fix 2" (exempt only text-entry inputs) and has not answered. 3.21 landed the test-side fix, so this goes to `docs/V1.1-BACKLOG.md` with the trigger "the Phase 3 review set or a user report", unless a reviewer raises it.
- **Container external-leg ordering leak.** 3.21's journal records `settings.spec.ts` leaving `typewriterScroll` true in the container's config. Earlier full external runs went 14/15 twice and 13/15 once. CI's legs were green, so nothing is filed. If an ubuntu e2e-shell leg later fails on a spec after `settings`, it is this leak, not a transient (a `.g<n>` repair, not a rerun).
- **3.21's `.skip(` acceptance grep** prints `robustness.spec.ts:272` `this.skip()`, a runtime budget skip that 3.17 added before 3.21. The agent named it in the journal as out of scope. The reconciliation can note it; it is not a 3.21 defect.
- **Fable's process-gap proposal (boundary decision, Michael's).** Every e2e/shell task should run both container legs (external and `ESSAYDOWN_E2E_DRIVER=embedded`) before it ends. 2.12's acceptance said so; 3.2–3.5, 3.19 and 3.20's did not, so the gate was their first embedded run. 3.21 appended the same lesson. Raise it at the Phase 3→4 boundary planning.
- **Windows autosave failure at g1h** (recorded, #047): "a truncate then a rewrite 300 ms later is one reload, not two". If a reviewer or Phase 4 sees it again, it is a watcher-timing case on Windows, not a 3.21 regression.
- **Never write the literal promise** into any file an agent reads.

## Next Steps

1. Run `status` (expect the three reviewers running, or `PRINCIPAL 3.7.r0d` pending), `doctor` (clean) and `git status --short` (empty, on `phase/3`). Give Michael the one-line state.
2. Arm the watcher (Current State).
   - On `USAGE-LIMIT` for Sol, wait for the reset, then retry that reviewer alone. A Grok 402 is Michael's call.
   - On `WARN`, read the excerpts at the reconciliation.
3. At `PRINCIPAL 3.7.r0d`, rotate. A fresh session runs the reconciliation in `.wt/3.7.r0d` on `task/3.7.r0d`:
   - cherry-picks `phase/3..handoff/065` (the stack 061–065);
   - briefs Fable (reconciliation trigger);
   - applies #041 D1;
   - files the undo-keys backlog line (Gotchas) unless a reviewer made it a finding;
   - takes the untaken `3.verify` hard stops from 3.verify's journal entry (`grep -- '^- \[3\.verify\]' docs/progress/journal-main.md`);
   - touches only `docs/**`, `ralph/tasks.json` and `ralph/EXPECTED_COUNT`;
   - puts the DONE promise only in its `wip(3.7.r0d)` commit message;
   - appends its own `- [3.7.r0d] ` journal line in that commit.
4. Hand Michael `git push origin phase/3` when convenient (6 commits ahead now).

## Open Questions

- **Michael:** fix 2 for undo-keys (text-entry-only exemption). It is now backlog unless he wants it in Phase 3. He was asked in the 064→065 session and has not answered.
- **Michael (boundary):** Fable's both-legs rule for e2e/shell tasks (Gotchas).

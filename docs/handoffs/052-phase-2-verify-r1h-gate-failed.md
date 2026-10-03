# Handoff 052: Phase 2, `GATE-FAILED 2.verify.r1h` → `PLAN-GATE plan.2.verify.r1h.r0`

Written 2026-09-30 by the principal: the Opus 5.5 session that continued from 051, ran the CI gate `2.verify.r1h` and rotated at its failure. It ran in Claude Code on the Mac Mini. It supersedes `051-phase-2-verify-r1-gate.md`.

This commit is on `handoff/052`, **stacked on `handoff/051`** (`7b81124`), which is stacked on `handoff/050` (`b6ad9d2`). None of the three is in `phase/2` yet. The next reconciliation (`2.10.r1d`) cherry-picks `phase/2..handoff/052`, which covers all three commits. The next handoff is `053-*.md`.

## Current State

- **Branches.**
  - `phase/2` is at `fbce99e` `task(2.verify.r1): …`. It has 237 commits and is not on origin (`ls-remote` is empty). Nothing is new since 051.
  - `main` is at `92a2ec1`, unchanged.
  - `handoff/050` → `051` → `052` are stacked and not in `phase/2`. `handoff/040`–`049` are integrated. Delete all of them after `2.close`.
- **Gate.** `scripts/gate.sh 2.verify.r1h` pushed `ci/2.verify.r1/a1` at `fbce99e` and waited for CI run `36690847581`. It printed:
  - `GATE-FAILED 2.verify.r1h a1: workflow ci.yml concluded failure`
  - `PLAN-GATE plan.2.verify.r1h.r0`
  - `ROTATE-PRINCIPAL`

  The evidence is in `.evidence/ci/2.verify.r1h/a1/` (`workflow.log`, `test-logs/`, `e2e-shell/`, `macos-debug-dmg/`, `result.json`). To see only the failing steps, run `gh run view 36690847581 --log-failed`.
- **Jobs.**
  - Passed: `macos-debug-dmg`, `test (ubuntu-latest)`, `test (macos-latest)`, `e2e-shell (ubuntu-latest)`, `merge-logs`.
  - Failed: `test (windows-latest)`, `e2e-shell (macos-latest)`, `e2e-shell (windows-latest)`.
- **Failures.** These are facts from the logs, not a diagnosis:
  1. **`test (windows-latest)`**: one Rust test failed and 66 passed. The test is `workspace::tests::new_file_on_u64_max_existing_name_is_io_error_not_panic`, which was added by 2.20.
     - It panics in its own setup: `std::fs::write(format!("{}/Untitled-{}.md", root.display(), u64::MAX), …).unwrap()` at `apps/desktop/src-tauri/src/workspace.rs:956:10`.
     - The error is `Os { code: 123, kind: InvalidFilename, message: "The filename, directory name, or volume label syntax is incorrect." }`.
     - The product assertion never runs.
  2. **`e2e-shell (macos-latest)`**:
     - `file-tree.spec.ts:214`, "clicking a cloudOnly entry shows the tooltip and does not error", fails `true !== false`. It fails after a long run of `Tauri core.invoke not available after 5s timeout` warnings.
     - `close.spec.ts` shows `FAILED in undefined` at session launch: `Script execution timed out`, then `ECONNREFUSED 127.0.0.1:4445`, which means the driver was gone.
  3. **`e2e-shell (windows-latest)`**:
     - `close.spec.ts` shows `FAILED in undefined` (endSession or driver).
     - `file-tree.spec.ts` has 2 failing: "renames a.md to b.md via F2, moving the sidecar and assets together" and the same cloudOnly tooltip case.
     - The other specs pass: 9, 4, 3, 6, 2 and 2 passing.
  - Across platforms: the cloudOnly case fails on macOS **and** Windows and passes on ubuntu. `close.spec.ts` fails at the session level on both macOS and Windows.
- **Status:** `Phase 2, idle; last passed 2.verify.r1; gates open: none; plan requests: plan.2.verify.r1h.r0:pending; blocked: 2.verify.r1h:blocked`. `doctor` is clean. The host checkout is clean on `phase/2`. `EXPECTED_COUNT` is 309.
- **Dependencies.** `2.10.r1a` and `2.10.r1b` depend on `2.verify.r1h`, and `2.verify.r1h` depends on `2.verify.r1`. The planning commit rewires both reviewers to the repair's new CI gate.
- **Runner.** It has exited and has not been restarted. The tmux pane `essaydown:runner` (pid 8940) is at `zsh`. The restart command is `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 2 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher.** None is armed. runner.log has 189,144 lines. Arm the watcher only after the planning commit and the restart, at `wc -l` + 1:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=<wc -l + 1>; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  On every expiry, re-arm from the same start, run `status` and a catch-up grep, and filter out the task-start lines already reported.
- **Expected next stop signal:** none until the planning commit lands. After the restart: the repair task's `[ralph]` line, then its verify, then `HUMAN_GATE` on the new CI gate.

## Corrections

- `051` Current State expected `2.verify.r1h human-pending`. That is superseded: the gate failed, so status is now `idle`, `plan.2.verify.r1h.r0:pending` and `2.verify.r1h:blocked`.
- `051` Open Questions lists "whether 2.21's 15-file scope gap is backlog at r1d or a fix task" as pending. **Michael answered on 2026-09-30: backlog.** The r1d writes it as a backlog line with a revisit trigger. It is not a fix task.

## Decisions

- No DECISIONS entries, no runner deviation and no Fable consultation this block.
- Michael decided the 2.21 scope gap goes to the backlog (see Corrections).

## Gotchas

- **Windows keeps failing.** This is the fifth Windows-only gate failure this phase. Add it to the #045 (drop Windows) evidence list for the boundary question. It does not change the rule that a gate repair scopes to what failed.
- **A test's own setup can be the failure.** The Rust failure is an `unwrap()` in the test's setup, not the product assertion. Fable should judge whether the absurd filename needs a platform-neutral construction, or whether the product path has the same Windows problem.
- **Failures that may be transient.** `close.spec.ts` died at the driver or session level on two OSes. Sessions `[0-1]` and `[0-2]` show `Script execution timed out` and `core.invoke not available` warnings. A same-SHA rerun is only for a transient failure (RUNNER-SPEC §2, #023), and the failing Rust test is deterministic, so a tree change (`.g<n>`) is needed regardless. The question is which e2e cases go in the same repair.
- **cloudOnly fails on two OSes.** It fails on macOS and Windows and passes on ubuntu, so it is not a Windows-only failure. Check whether 2.18 (rename rewrite), 2.19 (sidecar re-read) or 2.20 (`new_file` with `create_new`) touched the file-tree or the cloudOnly path.
- **Scratchpad logs are session-local.** The last session's `ci-failed.log` is gone. Regenerate it with `gh run view 36690847581 --log-failed > <scratchpad>/ci-failed.log`.
- **Test-side limit.** `2.17`'s close e2e drives IPC, not a native close. At the next human gate that installs a build, add one manual check: type, close the window at once, relaunch, and confirm the text is on disk.
- **Worktree toolchain.** Never run pnpm, vitest or Playwright on the Mac inside `.wt/<id>`. Reproduce in a detached scratch worktree.

## Next Steps

1. Run `status` (expected: idle, `plan.2.verify.r1h.r0:pending`), `doctor` (clean) and `git status --short` (empty).
2. **Fable brief** (trigger: `PLAN-GATE`). Include:
   - **Signal:** `GATE-FAILED 2.verify.r1h a1`.
   - **Evidence paths:**
     - `.evidence/ci/2.verify.r1h/a1/`, and `gh run view 36690847581 --log-failed` saved to a scratchpad file
     - `apps/desktop/src-tauri/src/workspace.rs` (the test at about line 950, `scratch_dir` at 577, `new_file_at`)
     - `e2e/shell/test/file-tree.spec.ts` (the cloudOnly case at 214 and the F2 rename case)
     - `e2e/shell/test/close.spec.ts`
     - the 2.18, 2.19 and 2.20 diffs (`3d691ac`, `2f48205`, `406f664`)
   - **What was tried:** nothing; this is gate attempt 1.
   - **One question:** of the three failures, which are defects (product or test) and which are transient or platform-only? What is the minimal `.g<n>` repair that makes the gate green without widening scope, and which parts are filed with a revisit trigger?
   - **Answer format:** decision, reasons, confidence, task text.
3. Run `ralph/ralph.sh plan plan.2.verify.r1h.r0`, then make the planning commit in `.wt/plan.2.verify.r1h.r0`:
   - Add the sonnet repair task, depending on `2.verify.r1`.
   - Add the next verify and its CI gate, in the 048 pattern (`2.verify.g2h` → `2.15` + `2.verify.g3`). Use the ids the planning protocol gives.
   - Rewire `2.10.r1a` and `2.10.r1b` to the new CI gate.
   - Update `EXPECTED_COUNT`, read from the tasks you add (309 now).
   - The promise goes only in the `wip(plan…)` message. The reversal is `ralph/ralph.sh plan-abandon plan.2.verify.r1h.r0 --reason "planning change for 2.verify.r1h withdrawn"`.
   - If the planning commit appends to DECISIONS.md, rebase `handoff/050..052` onto the new tip (#039).
4. Restart the runner and arm the watcher at `wc -l` + 1.
5. At the new CI gate's `HUMAN_GATE`, run `scripts/gate.sh <gate>` in the background. On ACCEPT, restart the runner and watch `2.10.r1a` (claude) and `2.10.r1b` (sol). On GATE-FAILED, rotate first, then brief Fable again.
6. At `PRINCIPAL 2.10.r1d`, rotate. The fresh session:
   - cherry-picks `phase/2..handoff/NNN` (the newest handoff) into `task/2.10.r1d`;
   - applies #041 D1: a blocker reported in r1 goes to Michael before any planning commit;
   - writes the 2.21 gap as a backlog line (Michael, 2026-09-30).
7. At `2.close`, bring Michael the Open Questions.

## Open Questions

- **For Michael (Phase 2 / 3 boundary), unchanged from 051:**
  - #045's PRD and CLAUDE.md diff (drop Windows). The evidence is now five Windows-only gate failures, counting `2.verify.r1h`'s `test (windows-latest)`.
  - Register `tauri-plugin-wdio`, or correct PRD §4's row (U25).
  - The U9 robustness test-only task.
  - Which of the 35 re-pointed hard stops become Phase 3 tasks before `3.verify`.
  - The settings directory name (U16).
  - Shift+Enter.
  - Re-read #045's "macOS required e2e runner on the embedded plugin".
  - The background-and-wait pattern at three occurrences, with 2.19 a2's transcript as evidence.
- **Closed:** the 2.21 scope gap is backlog (Michael, 2026-09-30).

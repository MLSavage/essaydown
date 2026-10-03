# Handoff 054: Phase 2, review r1 done (both FAIL) → `PRINCIPAL 2.10.r1d` reconciliation

Written 2026-10-01 by the principal: the Opus 5.5 session that continued from 053. It restarted the runner, watched the r1 reviewers `2.10.r1a` (claude) and `2.10.r1b` (sol) run to completion, and rotated at `PRINCIPAL 2.10.r1d`. It supersedes `053-phase-2-verify-r1-g1h-accepted.md`.

This commit is on `handoff/054`, **stacked on `handoff/053`** → `052` → `051` → `050`. None of the five is in `phase/2`. The reconciliation `2.10.r1d` cherry-picks `phase/2..handoff/054`, which covers all five commits. The next handoff is `055-*.md`.

## Current State

- **Branches.**
  - `phase/2` is at `637efd2` `task(2.verify.r1.g1): …`, unchanged since 053. It has 240 commits and is not on origin (`ls-remote` is empty).
  - `main` is at `92a2ec1`, unchanged.
  - `handoff/050` → `051` → `052` → `053` → `054` are stacked and not in `phase/2`. Delete all of them after `2.close`.
- **Tasks.**
  - `2.10.r1a` (claude) and `2.10.r1b` (sol) both passed as tasks, each at its first run, with no retry spent. Both reviewed implementation SHA `637efd2`.
  - Both reports say **FAIL, 2 blockers, 0 should-fix, 0 nits**. The evidence is in `.evidence/reviews/2/r1/{claude,sol}/` (`report.md`, `status.json`).
  - `2.10.r1d` is **principal-pending**. Its worktree `.wt/2.10.r1d` is on `task/2.10.r1d` and has no commits from the principal yet.
- **The two blockers.** Both reviewers report the same two findings independently:
  1. **U5 sidecar, second save.** In `apps/desktop/src/workspace/DocumentPane.tsx:131–150` and `sidecar-sync.ts:50`, `chooseSidecarForWrite` takes the disk's sidecar on the first save and advances `sidecarKnownRaw` to it. It never updates the in-memory sidecar, so the next autosave writes the stale store sidecar over the externally synced one. That is silent loss of metadata. Sol gives a native reproduction.
  2. **U2 quit, macOS.** In `apps/desktop/src-tauri/src/lib.rs:71–76` with `App.tsx:100–126`, tauri's default menu Quit (Cmd+Q) is muda's predefined `terminate:`. Tao implements no `applicationShouldTerminate:`, so quitting skips the pending-edit flush and the save-conflict check. Both reports cite installed sources: tauri 2.11.5 `app.rs:2245`, muda 0.19.3 `macos/mod.rs:994`.
- **Status:** `Phase 2, 2.10.r1d principal-pending; last passed 2.10.r1b; gates open: none; plan requests: none; blocked: none`. `doctor` is clean. The host checkout is clean on `phase/2`.
- **Runner.** It is not running; it exited at `PRINCIPAL 2.10.r1d`. The tmux pane `essaydown:runner` (pid 8940) is at `zsh`. After the reconciliation's wip commit is made, restart it with `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 2 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher.** It is stopped. runner.log has 192,826 lines. After the restart, take `wc -l` + 1 and arm 053's watcher command at that start, unchanged.
- **Expected next stop signal:** none until Michael rules on the blockers. After that it is the reconciliation's own outcome: a planning request or fix chain, or a backlog-only close.

## Corrections

- `053` Current State says the runner is idle with next tasks `2.10.r1a`/`2.10.r1b`. That is superseded: both ran, and `2.10.r1d` is principal-pending.
- `053` Next Steps 4 names `phase/2..handoff/NNN`. The range is now **`phase/2..handoff/054`**.

## Decisions

- No DECISIONS entries, no runner deviation and no retries this block.
- **WARN 2.10.r1b** (#025, #044): "transcript names a sibling's report of this attempt (claude ×2)". The matched text is the `acceptance` string of `2.10.r1a`'s entry in `ralph/tasks.json` (`/logs/reviews/2/r1/claude/report.md and status.json exist …`), which sol read as part of the task list. It does not look like a read of the sibling directory. The reconciliation decides read or mention and records it. Check sol's inputs line and its transcript for any `cat`/`Read` of `/logs/reviews/2/r1/claude/`.

## Gotchas

- **#041 D1 applies.** Both blockers were reported in r1, a late review attempt. They go to Michael **before any planning commit or fix chain**. Give him the one-line state, the two findings, and a fix-or-backlog ask for each. Both meet the blocking bar on their face: U5 is silent loss of user data, and U2 loses pending edits on Cmd+Q.
- **Agreement is not independence by default.** The two reports converge on the same two findings with the same file:line and source citations. Before counting them as two independent confirmations, settle the WARN (above).
- **U2 likely touches Rust and the menu.** A fix may need a custom menu or a `RunEvent::ExitRequested` hook. Check PRD §4 before any dependency, because #045's Windows question and the macOS e2e gap (handoff 053 Gotchas, the manual close check) are adjacent. The container is Linux, so the macOS Quit path cannot be e2e-verified there; that needs a manual check at a human gate.
- **Manual check still owed** (from 053): at the next human gate that installs a build, type, close the window at once, relaunch, and confirm the text is on disk. Add Cmd+Q to it.
- **Never write the literal DONE promise** into the reconciliation's docs. It goes only in the `wip(2.10.r1d)` commit message.

## Next Steps

1. Run `status` (expected: `2.10.r1d principal-pending`), `doctor` (clean) and `git status --short` (empty).
2. In `.wt/2.10.r1d`, `git cherry-pick phase/2..handoff/054` (docs/** only, inside the RUNNER-SPEC §8.1 allowlist).
3. Read both r1 reports in full and settle the WARN 2.10.r1b.
4. Brief Fable in writing, since the reconciliation is its trigger. The brief covers the two blockers, both reports' paths, the WARN, and #041 D1. Ask for a decision per finding (fix task vs backlog with a trigger), reasons, confidence, and the task text if it says fix.
5. Take the blockers to Michael (#041 D1) with Fable's recommendation. Commit no plan until he answers.
6. Write the reconciliation in `.wt/2.10.r1d` (docs/**, `ralph/tasks.json`, `ralph/EXPECTED_COUNT` only):
   - a `#review-2-r1` DECISIONS entry;
   - 2.21's 15-file mount-wait gap as a backlog line with a revisit trigger (Michael, 2026-09-30);
   - any fix tasks and the `r2` rows (`a`, `b`, `d`; no Grok, #043) per Michael's ruling.
   Then commit `wip(2.10.r1d)` with the promise in the message, restart the runner and arm the watcher.
7. Rotate at the next stop signal that ends a working block.

## Open Questions

- **For Michael, now (#041 D1):** fix or backlog for each r1 blocker: (1) U5's second-save sidecar loss, (2) U2's macOS Cmd+Q bypassing flush and conflict.
- **For Michael (Phase 2 / 3 boundary), carried from 053 unchanged:**
  - #045's drop-Windows diff, with this phase's Windows-only gate failures as evidence.
  - `tauri-plugin-wdio` (U25).
  - The U9 robustness test-only task.
  - Which of the 35 re-pointed hard stops become Phase 3 tasks.
  - The settings directory (U16).
  - Shift+Enter.
  - #045's "macOS required e2e runner on the embedded plugin".
  - The background-and-wait pattern at four occurrences (evidence: 2.19 a2, 2.22 a2's `.evidence/tasks/2.22/2.log`).

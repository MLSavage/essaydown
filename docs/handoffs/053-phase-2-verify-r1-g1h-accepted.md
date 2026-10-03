# Handoff 053: Phase 2, `ACCEPT 2.verify.r1.g1h` → review attempt r1 next

Written 2026-09-30 by the principal: the Opus 5.5 session that continued from 052. It ran the `PLAN-GATE plan.2.verify.r1h.r0` consult, made the planning commit, watched `2.22` and `2.verify.r1.g1` and ran the CI gate `2.verify.r1.g1h` to ACCEPT. It ran in Claude Code on the Mac Mini and rotated at the gate's `ROTATE-PRINCIPAL`. It supersedes `052-phase-2-verify-r1h-gate-failed.md`.

This commit is on `handoff/053`, **stacked on `handoff/052`** → `051` → `050`. None of the four is in `phase/2`. The next reconciliation (`2.10.r1d`) cherry-picks `phase/2..handoff/053`, which covers all four commits. The next handoff is `054-*.md`.

## Current State

- **Branches.**
  - `phase/2` is at `637efd2` `task(2.verify.r1.g1): …`. It has 240 commits and is not on origin (`ls-remote` is empty). New since 052:
    - `6d87fdd` `plan(plan.2.verify.r1h.r0)`
    - `d65c674` `task(2.22)`
    - `637efd2` `task(2.verify.r1.g1)`
  - `main` is at `92a2ec1`, unchanged.
  - `handoff/050` → `051` → `052` → `053` are stacked and not in `phase/2`. Delete all of them after `2.close`.
- **Tasks.**
  - `2.22` (four test-side repairs) passed at **attempt 3**. Attempt 1 capped at 80 turns after implementing everything. Attempt 2 recovered the dirty tree in `d6968c0`, with no mutation swept (checked), then ended waiting on a backgrounded command. Attempt 3 re-verified and integrated.
  - `2.verify.r1.g1` passed at attempt 1.
  - `2.verify.r1.g1h` gave `ACCEPT` at a1: CI run 36705083079. Accepted evidence is in `.evidence/ci/2.verify.r1.g1h/`.
- **Status:** `Phase 2, idle; last passed 2.verify.r1.g1h; gates open: none; plan requests: none; blocked: none`. `doctor` is clean. The host checkout is clean on `phase/2`. `EXPECTED_COUNT` is 312.
- **Next tasks.** `2.10.r1a` (claude) and `2.10.r1b` (sol) now depend on `2.verify.r1.g1h` and read `/logs/ci/2.verify.r1.g1h/accepted/`. `2.10.r1d` depends on both.
- **Runner.** It is not running; it exited at `HUMAN_GATE 2.verify.r1.g1h`. The tmux pane `essaydown:runner` (pid 8940) is at `zsh`. The restart command is `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 2 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher.** None is armed. runner.log has 192,823 lines. After the restart, arm the watcher at `wc -l` + 1:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=<wc -l + 1>; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  On every expiry, re-arm from the same start, run `status` and a catch-up grep, and filter out the task-start lines already reported.
- **Expected next stop signal:** `[ralph] 2.10.r1a` and `2.10.r1b` start lines, then `PRINCIPAL 2.10.r1d`.

## Corrections

- `052` Current State says `idle, plan.2.verify.r1h.r0:pending, 2.verify.r1h:blocked`. That is superseded: the plan integrated as `6d87fdd`, and the repair chain passed through `2.verify.r1.g1h`.
- `052` Current State says `EXPECTED_COUNT` is 309. It is now **312**: 249 raw + 21 review-set + 42 CI gates.
- `052` Open Questions counts the background-and-wait pattern at three occurrences. It is now **four**, with 2.22 attempt 2 (`.evidence/tasks/2.22/2.log`) as the new evidence.

## Decisions

- No DECISIONS entries and no runner deviation this block.
- **Fable consult** (trigger `PLAN-GATE`), recorded in the planning commit's message (`a7c05ae` on `plan/2.verify.r1h/r0`, integrated as `6d87fdd`). All four failures were deterministic test-side defects; none was transient or in the product:
  - (a) the Rust fixture was built with a `/` join over a verbatim `\\?\` Windows root;
  - (b) `file-tree.spec` seeded an invalid sidecar, which raised 2.19's error banner, and an embedded `reloadSession` does not clear it;
  - (c) the F2 image-src check encoded `/`;
  - (d) close.spec's relaunch leg cannot connect on the embedded provider.
  - Filed, not fixed: the embedded `reloadSession` is not a restart. 2.22 wrote the backlog line; its hard stop is `3.verify`.
- The runner held `2.22` through three attempts with no retry, so no `retry` was spent.

## Gotchas

- **Background-and-wait, fourth occurrence (2.22 a2).**
  - The command was `timeout 540 bash -c 'Xvfb :99 -ac & …' 2>&1 | tail -150`.
  - When `timeout` kills bash, the orphaned Xvfb keeps the pipe to `tail` open. The call overran its 560 s tool timeout and Claude Code moved it to the background. The agent then scheduled a wakeup and ended its turn, and a headless attempt that ends its turn is over.
  - Attempt 1 redirected to a file instead and did not hang.
  - Any lesson or task text that runs an e2e spec should say to redirect output to a file, never pipe it through `tail`, and to kill the Xvfb it started.
- **e2e turn cost.** 2.22 a1 spent 26 of its 80 tool calls on single-spec e2e runs and capped. Budget e2e-heavy tasks accordingly.
- **Manual check still owed.** `2.17`'s close e2e drives IPC, not a native close, and the embedded leg now also skips the relaunch read-back. At the next human gate that installs a build, add one manual check: type, close the window at once, relaunch, and confirm the text is on disk.
- **Worktree toolchain.** Never run pnpm, vitest or Playwright on the Mac inside `.wt/<id>`. Reproduce in a detached scratch worktree.

## Next Steps

1. Run `status` (expected: idle, last passed `2.verify.r1.g1h`), `doctor` (clean) and `git status --short` (empty).
2. Restart the runner, take `wc -l < .evidence/runner.log`, and arm the watcher at that count + 1.
3. Watch `2.10.r1a` (claude) and `2.10.r1b` (sol).
   - A single-reviewer failure is `ralph/ralph.sh retry <id>` of that reviewer alone (#043). Move its `.evidence/tasks/<id>/<n>.log` aside first (#027).
   - `USAGE-LIMIT` is the same `ralph run` after the reset.
4. At `PRINCIPAL 2.10.r1d`, rotate. The fresh session:
   - cherry-picks `phase/2..handoff/NNN` (the newest handoff) into `task/2.10.r1d`;
   - consults Fable (its trigger is the reconciliation);
   - applies #041 D1: a blocker reported in r1 goes to Michael before any planning commit;
   - writes 2.21's 15-file mount-wait gap as a backlog line with a revisit trigger (Michael, 2026-09-30).
5. At `2.close`, bring Michael the Open Questions.

## Open Questions

- **For Michael (Phase 2 / 3 boundary):**
  - #045's PRD and CLAUDE.md diff (drop Windows). The evidence is five Windows-only gate failures. `2.verify.r1h` also had two Windows-only convention defects out of four failures; with Windows dropped, that gate would have passed, with macOS non-blocking.
  - Register `tauri-plugin-wdio`, or correct PRD §4's row (U25).
  - The U9 robustness test-only task.
  - Which of the 35 re-pointed hard stops become Phase 3 tasks before `3.verify`.
  - The settings directory name (U16).
  - Shift+Enter.
  - Re-read #045's "macOS required e2e runner on the embedded plugin".
  - The background-and-wait pattern, now at **four** occurrences. The evidence is 2.19 a2's transcript and 2.22 a2's (`.evidence/tasks/2.22/2.log`), where the cause was the Xvfb pipe; runner parameter changes need transcript evidence and Michael's OK.

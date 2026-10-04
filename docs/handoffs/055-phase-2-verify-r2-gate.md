# Handoff 055: Phase 2, r2 chain passed → `HUMAN_GATE 2.verify.r2h` (CI gate)

Written 2026-10-03 by the principal: the Opus 5.5 session that continued from 054. It ran the r1 reconciliation and restarted the runner, which then ran the r2 fix chain to the CI gate. It supersedes `054-phase-2-review-r1-reconciliation.md`.

This commit is on `handoff/055`, based on `phase/2` at `2ebde0c`. The content of `handoff/050`–`054` is already in `phase/2` through r1d's cherry-pick; those refs are not ancestors only because the integration squashed them. The next reconciliation (`2.10.r2d`) cherry-picks `phase/2..handoff/055`, or a newer stacked handoff. The next handoff is `056-*.md`.

## Current State

- **Branches.**
  - `phase/2` is at `2ebde0c` `task(2.verify.r2): …`. It has 244 commits and is not on origin (`ls-remote` is empty).
  - `main` is at `92a2ec1`, unchanged.
  - `handoff/040`–`055` all exist. Delete them all after `2.close`.
- **Tasks this block, each at attempt 1 with no retry spent.**
  - `2.10.r1d`, the reconciliation, integrated as `d34515a`. Verdict FAIL, recorded in `#review-2-r1`.
  - `2.23` (sidecar baseline, opus) passed as `ec6828e`.
  - `2.24` (macOS menu Quit, opus) passed as `b543604`.
  - `2.verify.r2` (sonnet) passed as `2ebde0c`. It promoted the `#review-2-r1 U5` rule into CLAUDE.md and AGENTS.md (line 61).
- **Status:** `Phase 2, 2.verify.r2h human-pending; last passed 2.verify.r2; gates open: 2.verify.r2h; plan requests: none; blocked: none`. `doctor` is clean. The host checkout is clean on `phase/2`.
- **Runner.** It exited at `HUMAN_GATE 2.verify.r2h`. The tmux pane `essaydown:runner` (pid 8940) is at `zsh`. Restart it with `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 2 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher.** It is stopped. runner.log has 197,747 lines. After the restart, take `wc -l < .evidence/runner.log` + 1 and arm this watcher as a persistent Monitor (30-minute cap). Use `setopt nullglob`.
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=START; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  Replace `START` with the number before arming. On every expiry, re-arm from the same start, run `status` and a catch-up grep, and filter out the task-start lines already reported.
- **Expected next stop signal:** the CI gate's outcome from `scripts/gate.sh 2.verify.r2h`. After ACCEPT and the restart, the next is `HUMAN_GATE 2.25`, Michael's macOS quit check.

## Corrections

- `054` Current State says `2.10.r1d` is principal-pending, and its Next Steps describe the reconciliation. Both are superseded: r1d integrated, and the r2 chain ran through `2.verify.r2`.
- `054` says the stack 050–054 is "not in `phase/2`". Its content is now in `phase/2` (`d34515a`). Do not stack on `handoff/054`, and do not cherry-pick it again.
- `054` Gotchas puts the owed manual check (type, close at once and Cmd+Q, relaunch) at "the next human gate". It is now **gate 2.25**, a task of its own; it is no longer a boundary question.
- `053` and `054` say `EXPECTED_COUNT` is 312. It is now **320** (r1d added seven rows plus the generated `2.verify.r2h`).

## Decisions

- **`#review-2-r1`** (task 2.10.r1d) has verdict FAIL.
  - Claude reported 2/0/0 and Sol 2/0/0. The two reports were independent: WARN 2.10.r1b was settled as a mention of the tasks.json acceptance string, not a read of the sibling report.
  - The 4 raw findings are 2 unique, both shared, with no severity disagreement.
  - There was one Fable brief. Michael's answers, verbatim: V1 "Fix as 2.23 (Recommended)", V2 "Fix as 2.24 (Recommended)".
  - New backlog lines: `[review-2-r1, 2.21 mount-wait gap — Michael]` (from r1d); `[review-2-r1, sidecar baseline vs store]` (from 2.23); and `[review-2-r1, U2 terminate: routes]` (from 2.24) for Dock, logout and shutdown, with hard stop `6.verify`.
  - Three `[2.10.r1d]` lessons were added. The entry also corrects the principal record: 2.17 had handed the Quit gap to the principal, so the missing disposition was the principal's.
- **Human observation gate 2.25** (record target `010-mac-quit-check`) is new. It depends on `2.verify.r2h`, and `2.10.r2a`/`r2b` depend on it.
  - Michael installs the r2 dmg and records its sha256.
  - Checks: (1) close the window at once, then relaunch; (2) Cmd+Q within half a second, then relaunch; (3) conflict plus Cmd+Q keeps the window, then Keep mine and Cmd+Q quits with the text saved; (4) Cmd+C/V/X/Z/A still work; (5) Dock Quit is recorded only.
  - ACCEPT when (1)–(4) hold.
- No runner deviation, no retries, no new DECISIONS entry since r1d.

## Gotchas

- **The CI gate is the principal's to run.** It runs on the host with Michael's gh login. `scripts/gate.sh 2.verify.r2h` outruns the 120 s foreground limit, so background it with output to a scratchpad file and read that file.
- **2.25 is Michael's, and only on a Mac.** Give him the dmg path from `.evidence/ci/2.verify.r2h/accepted/macos-debug-dmg/` (or the latest repair's) and the five checks verbatim from the 2.25 row in PRD §8. His record command is `scripts/gate.sh 2.25 --outcome ACCEPT|REJECT --payload …`. Read the row for the payload fields (dmg sha256, the outcome of each check) and hand him the finished command with his real values, never a placeholder (#019).
- **2.24's macOS behaviour is unproven until 2.25.** The container is Linux. Check (4) catches a dropped Edit submenu, which would silently break copy and paste.
- **A GATE-FAILED on 2.verify.r2h** goes through `ralph/ralph.sh plan` (`plan.2.verify.r2h.r0`). Rotate first, then brief Fable (the PLAN-GATE trigger). A Windows-only failure is evidence for #045.
- **r2 reviewers read `/logs/human/2.25/accepted.json`.** If 2.25 is REJECTed, the reviewers do not run; that is a planning decision.
- **Never write the literal DONE promise** into any file an agent reads.

## Next Steps

1. Run `status` (expected: `2.verify.r2h human-pending`), `doctor` (clean) and `git status --short` (empty). Give Michael the one-line state.
2. Run `scripts/gate.sh 2.verify.r2h` in the background, redirected to a scratchpad file, and read that file. It pushes `ci/2.verify.r2/a1` at `2ebde0c`, waits for `ci.yml` and fetches `test-logs`, `e2e-shell` and `macos-debug-dmg`.
3. On ACCEPT, restart the runner and arm the watcher. The runner should stop right away at `HUMAN_GATE 2.25`. Give Michael the dmg path, the five checks and the finished `gate.sh 2.25` command.
4. After 2.25 ACCEPT, restart the runner and watch `2.10.r2a` (claude) and `2.10.r2b` (sol).
   - A single-reviewer failure is `ralph/ralph.sh retry <id>` of that reviewer alone, after moving its logs aside (#027, #043).
5. At `PRINCIPAL 2.10.r2d`, rotate. The fresh session:
   - cherry-picks `phase/2..handoff/NNN`;
   - briefs Fable;
   - appends 2.25's accepted record as DECISIONS `#010-mac-quit-check`;
   - applies #041 D1: any r2 blocker goes to Michael before planning.
6. At `2.close` / the Phase 2→3 boundary, bring Michael the Open Questions below.
7. Rotate at every stop signal that ends a working block.

## Open Questions

- **For Michael, at 2.25:** the five manual checks on the r2 dmg.
- **For Michael (Phase 2 / 3 boundary), carried from 054:**
  - #045's drop-Windows diff, with this phase's Windows-only gate failures as evidence.
  - `tauri-plugin-wdio` (U25).
  - The U9 robustness test-only task.
  - Which of the 35 re-pointed hard stops become Phase 3 tasks.
  - The settings directory (U16).
  - Shift+Enter.
  - #045's "macOS required e2e runner on the embedded plugin".
  - The background-and-wait pattern at four occurrences (evidence: 2.19 a2, 2.22 a2's `.evidence/tasks/2.22/2.log`).

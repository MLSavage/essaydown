# Handoff 045: Phase 2, `HUMAN_GATE 2.verifyh`

Written 2026-09-26 by the principal, the Opus 5.5 session that took `2.7`'s `NO-JOURNAL` through to `HUMAN_GATE 2.verifyh`, in Claude Code on the Mac Mini. Supersedes `044-phase-2-2.7-no-journal.md` (on `handoff/044`, not in the tree). This commit is on `handoff/045`, **stacked on `handoff/044`** → `043` → `042` → `041` → `040`, none of them in `phase/2`. `2.10.r0d` cherry-picks `phase/2..handoff/045` as one range. The next handoff is `046-*.md`.

## Current State

- **Branches.**
  - `phase/2` is at `5c086c6` `task(2.verify)`, 218 commits, not on origin. `git ls-remote` lists `phase/0`, `phase/1`, `ci/2.1/a1`, and `main` at `92a2ec1`.
  - `main` is at `92a2ec1`, unchanged.
- **Status.** `Phase 2, 2.verifyh human-pending; last passed 2.verify; gates open: 2.verifyh; plan requests: none; blocked: none`. `doctor` clean; host checkout clean on `phase/2`.
- **Phase 2 progress this block.**
  - `2.7` passed at attempt 3 (`29a5760`), after the principal lesson `4ef9be2` on `task/2.7`.
  - `2.8` passed at attempt 3 (`84ba8c0`). a1 capped (81 turns, exit 1). a2 ran 26 turns and exited 0 after the agent put the 10-minute robustness e2e in the background and ended its turn to wait for it: the 2.4 r0 a3 shape. a3 passed.
  - `2.verify` passed at attempt 1 (`5c086c6`).
  - **Open: `2.verifyh`**, the CI gate for `2.verify` (`ci.yml`, artifacts `test-logs`, `e2e-shell`, `macos-debug-dmg`; acceptance: suite, shell smoke and robustness specs green on ubuntu **and windows**, macOS recorded, `.dmg` fetched to `/logs/ci/2.verify/accepted/`).
  - Pending after it: `2.9` (Michael's observation gate, depends on `2.verifyh`), `2.10.r0a/b/c`, `2.10.r0d`, `2.close`.
- **Runner.** It stopped at `HUMAN_GATE 2.verifyh` + `ROTATE-PRINCIPAL` (runner.log lines 165,378–165,379; 165,379 lines total). tmux `essaydown:runner` (pane pid 8940) is at its zsh prompt, and `.locks/` is empty. Restart after the gate records ACCEPT: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 2 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher.** Stopped at rotation. After the restart, read `wc -l < .evidence/runner.log` and set `start` to that count + 1:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=<count+1>; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  - `<count+1>` is a placeholder in this file only. The command you run carries the actual number. Use a persistent `Monitor` with a 30-minute cap. On every expiry, re-arm it and run `status` plus a catch-up grep. After a re-arm, add a `grep -v` for markers already delivered so they are not reported twice.
  - Last marker: `[ralph] 2.verify attempt 1 (loop, sonnet, max-turns 80)`.
- **Expected next stop signal** after the gate and restart: `HUMAN_GATE 2.9` (Michael's observation gate). The review set `2.10.r0a/b/c` then runs, then `PRINCIPAL 2.10.r0d`.

## Corrections

- `044` (on `handoff/044`) expected `HUMAN_GATE 2.9` next. The runner orders `2.verify` → `2.verifyh` → `2.9`, so the next stop was `HUMAN_GATE 2.verifyh`.
- `044`'s `phase/2` tip (`ccd5ad1`, 215 commits), its runner.log count and its watcher `start` are stale.

## Decisions

- No DECISIONS entry this block. DECISIONS.md on `phase/2` still ends at #043; #044–#045 are on the stack.
- `NO-JOURNAL 2.7` was handled as `2.2`'s was: the principal lesson `4ef9be2` `chore(2.7): principal lesson after NO-JOURNAL at attempt 2` on `task/2.7`, then a runner restart. There was no `retry` and no log move.
- DECISIONS #015: this session rotates at `HUMAN_GATE 2.verifyh`, and the fresh session runs the gate.

## Gotchas

- **Background-and-wait is now two occurrences** (`2.4` r0 a3 and `2.8` a2). An attempt that runs a long e2e with `run_in_background` and ends its turn is over. It cost `2.8` one attempt, and `2.8` passed at its last attempt. Any lesson for an e2e-heavy task says one foreground call bounded by `timeout`. Count a third occurrence before proposing a CLAUDE.md or runner change, which would be Michael's call at the boundary.
- **The stub-skip after a capped attempt is still two occurrences** (`2.2`, `2.7`). `2.8` a2 and a3 each ran `stub` themselves.
- **The gate still requires Windows.** #045 (drop Windows) takes effect only at the Phase 2 / Phase 3 boundary after Michael sees the diff, so `2.verifyh` acceptance includes windows. A windows-only failure is still `GATE-FAILED` → `PLAN-GATE`, which is a Fable trigger. Do not waive it by pointing to #045; that is Michael's call.
- `gate.sh` pushes `ci/2.verify/a1` to origin and waits for a three-OS run, so it outruns the 120 s foreground limit: run it in the background and read its output file. A stale remote `ci/2.1/a1` is still listed on origin.
- `status` shows a task's finished attempts while the next attempt runs.

## Next Steps

1. At session start, run `status` (expected: `2.verifyh human-pending`), `doctor` (clean), and `git status --short` (empty). Check that the runner pane is at its prompt.
2. Run the gate: `cd /Users/mlsavage/Developer/essaydown && scripts/gate.sh 2.verifyh`, in the background, reading its output file. It pushes `ci/2.verify/a1` at `5c086c6`, waits for `ci.yml`, fetches the three artifacts into `.evidence/ci/2.verifyh/a1/`, and writes `accepted.json` on ACCEPT. The `ROTATE-PRINCIPAL` it prints afterwards is already satisfied by this rotation.
3. **ACCEPT:** restart the runner and arm the watcher at count + 1. **GATE-FAILED + PLAN-GATE:** write a Fable brief, then the plan request `plan.2.verifyh.r1` via `ralph/ralph.sh plan`, then a planning commit adding `2.verify.g1` + its gate. Scope the repair to what failed (#021 … #039).
4. At `HUMAN_GATE 2.9`, hand Michael `scripts/gate.sh 2.9`. It installs the `.dmg` from `/logs/ci/2.verify/accepted/` and runs the Typora round-trip on his synced folder.
5. Rotate before `PRINCIPAL 2.10.r0d`. A fresh session runs the reconciliation (Fable on the decisions) and cherry-picks `phase/2..handoff/NNN`.

## Open Questions

- **For Michael (Phase 2 boundary, with #045's Windows change):** register `tauri-plugin-wdio` so shell e2e stops paying about 6 s per command. Unchanged from 043/044.
- **For the boundary, only if a third occurs:** the stub-skip after a capped attempt (candidate: the runner writes the attempt's stub itself). Also background-and-wait on a long e2e (candidate: a CLAUDE.md line, since task agents never see the principal's lesson rule). Neither is proposed yet: each has two occurrences.

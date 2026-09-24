# Handoff 039: Phase 1 closed (`CLOSED 1`, `main` at `92a2ec1`); the runner is idle at the Phase 2 boundary; the boundary items wait on Michael's word

Written 2026-09-24 by the principal: the Opus 5.5 session under #041 D2 that ran `1.10.r10d` and watched `1.close`, in Claude Code on the Mac Mini. Supersedes `038-phase-1-review-r10-reconciliation-pending.md`, which is in the tree since `92a2ec1`. This commit is on the host checkout on `phase/2`: the runner is idle at the boundary (#017). The next handoff is `040-*.md`.

## Current State

- **Phase 1 closed.** `CLOSED 1 main 92a2ec1 next phase/2` in `.evidence/runner.log` (146,950 lines), followed by the runner's `COMPLETE`. `phase/1`, `phase/2` and `main` are all at `92a2ec1` (`task(1.10.r10d)`); this handoff commit sits on `phase/2` above it. On origin, `main` is at `052e206` and `phase/1` at `4590b8d`: Michael pushes by hand (#010), and nothing is pushed.
- `status`: `Phase 2, idle; last passed 1.close`. Phase 0 has 47 passed and 1 superseded; Phase 1 has 143 passed and 8 superseded; Phase 2 has 17 pending (`2.1`, `2.1h`, `2.2`–`2.9`, `2.verify`, `2.verifyh`, `2.10.r0a/b/c/d`, `2.close`). `doctor` is clean.
- **This block's chain.**
  - `1.10.r10d` integrated as `92a2ec1` with verdict PASS (#review-1-r10; `.evidence/reviews/1/r10/verdict` reads PASS).
  - `1.close` passed.
  - The reconciliation cherry-picked `handoff/038`'s two commits (#042, handoff 038), so both are in `main`.
- **Runner**: tmux `essaydown`, window `runner`, pane pid 8940, at the zsh prompt after `CLOSED 1`. `.locks/` is empty, no `ralph run` process is running, `.wt/` is empty, and no `task/*` or `plan/*` branch is left.
  - **Do not restart it until the boundary items below are done or deferred by Michael.**
  - The Phase 2 restart command: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 2 2>&1 | tee -a .evidence/runner.log' Enter`
- **Watcher**: this session's watcher is stopped. After any restart, start a fresh one (`Monitor`, persistent, 30 s poll, 30 min cap). Take `wc -l < .evidence/runner.log` before the restart and hard-code `start` to that count + 1; `status` on every expiry.
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=<count+1>; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  The `<count+1>` above is the instruction for this file only. The command you run carries the number.
- **Expected next stop signal after a Phase 2 restart**: `[ralph] 2.1 attempt 1`, then `HUMAN_GATE 2.1h`. That is a CI gate: `scripts/gate.sh 2.1h` pushes `ci/2.1/a{n}` and fetches `test-logs` and `e2e-shell`. Background it (`gate.sh` outruns the 120 s limit), and read `2.1`'s PRD §8 row first.

## Corrections

- `038`'s Next Steps 3 lists "Michael's own `git worktree remove /Users/mlsavage/Developer/essaydown-1.9.r1`". `git worktree list` no longer shows it and `../essaydown-1.9.r1` is gone, so it is already done.
- `038` and `next-prompt.md` (038's): the relaunch line in `docs/handoffs/rotate.md` step 7 still lacks `--model claude-opus-5-5`. Under D2 the relaunch line includes it, and this rotation printed it with `--model`. The `chore(0.0)` fix to rotate.md is still pending (Next Steps).
- `038`'s Gotchas says "the `[1.46]` line's sixth instance". It was written as a new backlog line, `[1.46, evidence — sixth instance of the class, second on macOS]`; the old line is not edited.

## Decisions

- **#review-1-r10** (in `92a2ec1`): verdict PASS; three independent reviewers at 0/0/0.
  - One Fable brief, on the verdict question (PASS, high confidence). Its reading: the `287c884` human tree was prescribed by `1.9.r1`'s own text, the closing delta is 1.67's `format.ts` rule, and the machine evidences it; this is the #review-1-r8 N4 disposition.
  - No promotion into `2.verify`, so `2.verify`'s text is unchanged. The nine lesson candidates are recorded in the entry.
  - Seven backlog lines: `[1.46, evidence — sixth instance …]`, `[review-1-r10, leg (b)]`, `[review-1-r10, 1.9.r1 editing feedback]`, `[review-1-r10, pnpm dev]`, `[review-1-r10, Sol usage-limit retry]`, `[review-1-r10, turn budget]`, `[review-1-r10, reviewer record]`.
  - Two principal lessons lines, `[1.10.r10d]`: a human gate's tree follows the queued fixes, and a transient-rerun record restates each clause against its own diff.
- **#002-outline-feel**: `1.9.r1`'s record is appended with four deviations: tree `287c884`, ~250 words, VS Code for Typora, and the `pnpm --filter` command.
- **Runner deviations this block**: none new. The Sol #025 retry and #042 are recorded in #review-1-r10. There was no `fix(runner)`, no `admin`, no `docker/` change and no reviewer reconfiguration.

## Gotchas

- The host checkout is now on `phase/2`. Commit on it only while the runner is idle (#017). Once `ralph run --phase 2` starts, principal commits go on `handoff/NNN` from a temporary worktree again, as 038 describes.
- Phase 2 is the first phase with Rust commands. The `WorkspaceRoot` contract (PRD §6.4) and the Tauri e2e under WebdriverIO + tauri-driver (CLAUDE.md) start binding here. D3 (the container CLI bump and Opus 5.5 in the image) is a `docker/` change: rebuild the image before the first container task that can observe it (F17).
- `[review-1-r10, pnpm dev]`: `2.9`'s text must name `pnpm --filter @essaydown/desktop dev` at its planning. It is a pending task's PRD §8 text, so the edit is allowed, but only through a planning or boundary commit with `generate-tasks --check`, `validate-tasks` and the `EXPECTED_COUNT` check.
- `[review-1-r10, leg (b)]` has a `2.verify` hard stop: the separator-deletion corpus leg has 0 members over 65 fixtures.
- The zsh and ugrep quirks, the backgrounded `gate.sh`, and the rule never to quote the promise literal are all unchanged; see `next-prompt.md`'s constraints.

## Next Steps

1. **The boundary idle window.** The host is on `phase/2` and the runner is idle. Each item is its own atomic commit with a reversal line, and a DECISIONS entry where it decides something:
   - D3–D5 of `docs/proposals/001-token-efficiency.md`, on Michael's word only.
   - The boundary `fix(runner)` list:
     - #025's sibling hold-out inside `retry` (instances now include Sol at r10), plus a reviewer usage-limit signal beside #027's 429, on Michael's OK.
     - #023's doctor clause and remedy (three instances: #023, #029, #042).
     - H7.
     - #review-1-r7 M3 (b): `transcriptHasDone` reads only the assistant's own text blocks.
     - The recovery-commit guard.
     - Gate fetch-on-failure I7 (three instances, counting #042).
     - Claude r8 nit 3: `ci.yml` `if: always()`.
   - `chore(0.0)` for `docs/handoffs/rotate.md`:
     - step 5's `worktree add -b` fails when `handoff/NNN` already exists;
     - step 7's relaunch lines need `--model claude-opus-5-5`.
   - PRINCIPAL.md:
     - the doctor sentence;
     - the r4–r10 principal lessons, including #review-1-r10's two;
     - #025's procedure text, with Sol's usage-limit case.
   - React 19's ratification and the `check-deps` major-version comparison.
   - Cleanup:
     - `git branch -D` for `handoff/010`–`handoff/030` and `handoff/033`–`handoff/038`; all are merged into `main` via their reconciliations, so check `git branch --merged main` first.
     - `git worktree remove --force` the scratch worktree at `970bb5c` under `/private/tmp/.../b6d390f4-…/scratchpad/970bb5c`.
2. **Michael's asks** (one line each, a command without placeholders):
   - `scripts/gate.sh gc`, after `git ls-remote origin 'refs/heads/ci/*'`.
   - Pushing `phase/1` and `main`, #010: origin is at `4590b8d` and `052e206`, local at `92a2ec1`.
   - The turn-budget raise: evidence in `[review-1-r10, turn budget]`, where opus fix tasks capped at a1 in 14 of 15 over r7–r10.
   - The 429 and reviewer usage-limit signal.
   - Grok's read-only mode: unique findings r7–r10 were 0, 0, 0, 0, PASS 0/0/0 four times in a row, no build, test or browser.
3. **Then restart for Phase 2** with the command above, and start a fresh watcher. Rotate at the first stop signal that ends a working block, and before context passes about 150k.

## Open Questions

- D3–D5 of proposal 001: Michael's calls.
- Whether Grok stays in read-only mode for Phase 2's review set: Michael's call, to be set before `2.10.r0a/b/c` are generated or run, never inside a set.
- The `[1.67, found outside scope]` adjacent-`delete` member, and leg (b)'s empty corpus: both are `2.verify`'s questions.

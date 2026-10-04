# Handoff 059: Phase 2, `PRINCIPAL 2.10.r3d` (review r3 reconciliation pending)

Written 2026-10-04 by the principal: the Opus 5.5 session that continued from 058. It resolved the `2.verify.r3h` a1 GATE-FAILED with a same-SHA transient rerun (#046) and restarted the runner. The r3 reviewers then ran, and this session rotated at `PRINCIPAL 2.10.r3d`. It supersedes `058-phase-2-verify-r3h-gate-failed.md`.

This commit is on `handoff/059`, stacked on `handoff/058` (`09acb37`) and on `b271fcb` (#046), based on `phase/2` at `5522dbb`. The content of `handoff/040`–`057` is already in `phase/2` through the r0d, r1d and r2d cherry-picks; never stack on them or re-pick them. `2.10.r3d` cherry-picks `phase/2..handoff/059`: three commits (058, #046, this one). The next handoff is `060-*.md`.

## Current State

- **Branches.**
  - `phase/2` is at `5522dbb` `task(2.verify.r3)`, unchanged since 058. Not on origin.
  - `main` is at `92a2ec1`, unchanged.
  - `handoff/040`–`059` exist. Delete them all after `2.close`.
- **Status:** `Phase 2, 2.10.r3d principal-pending; last passed 2.10.r3b; gates open: none; plan requests: none; blocked: none`. `doctor` is clean. The host checkout is clean on `phase/2`.
- **Since 058:**
  - `2.verify.r3h`: a1 GATE-FAILED (macOS Playwright, the `[1.46]` caret race). Fable was briefed and answered "rerun", high confidence. a2 (run 37215729303, same SHA `5522dbb`) **ACCEPT**:
    - Playwright 102/102 on all three OSes.
    - cargo: ubuntu 78, macOS 78, windows 75.
    - No #023 abandon: #043's doctor clause made it unnecessary, and `doctor` was clean afterwards. Recorded as **#046** on `handoff/059`.
  - `2.10.r3a` (claude) and `2.10.r3b` (sol) ran in parallel at `5522dbb`. Their `status.json`:
    - claude **PASS** 0/0/0;
    - sol **PASS** 0/0/0.
  - **WARN** `2.10.r3b`: "transcript names a sibling's report of this attempt (claude ×3)". The excerpt is Claude's task text (`"acceptance":"/logs/reviews/2/r3/claude/report.md …"`), so it looks like a mention, not a read. The reconciliation decides (#025, #044).
- **Runner:** stopped at `PRINCIPAL 2.10.r3d`. The tmux pane `essaydown:runner` (pid 8940) is at `zsh`. After the reconciliation commit with the DONE promise in its message, restart with `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 2 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher:** stopped by this rotation. runner.log has 204,817 lines. After the restart, arm this as a persistent Monitor at `wc -l` + 1 (30-minute cap):
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=START; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  Never add a free-text term to its filter.
- **Expected next stop signal:** after `2.10.r3d` passes, `2.close`, then the Phase 2→3 boundary (`CLOSED` or the close's own signal; read `ralph/tasks.json` for `2.close`'s kind).

## Corrections

- `058` Next Steps 3 and the session prompt: "On ACCEPT … `abandon` a1 per #023". This is stale. #043's boundary `fix(runner)` landed the doctor clause (`ralph/lib/doctor.mjs`, a rejected attempt on a gate passed through a later attempt is recorded) and the `--resume` refusal (`ralph/lib/gate.mjs`). After an accepting rerun, `doctor` is clean and no abandon is run. #046 records this.
- `058` Gotchas: "The spec has passed in 27 of 29 gate workflow logs". That count double-counted the `accepted/` links. The true figure is 19 of 21 distinct attempt logs, and 16 of 18 on macOS (#046, from Fable's count).
- `058` Gotchas/Open Questions: whether the `[1.46]` hard stop binds at `2.verify`. It does not. `docs/V1.1-BACKLOG.md:137` (`[review-2-r0, hard stops re-pointed]`) moved it to `3.verify`.
- `058` Current State: "runner.log has 204,814 lines". It now has 204,817.
- `next-prompt.md` at `handoff/058`: superseded by this commit's version.

## Decisions

- **#046** (on `handoff/059`, `b271fcb`): gate `2.verify.r3h` transient rerun, the fourth instance of #023, and the first to need no abandon.
  - The `[1.46]` class's **seventh** gate instance, the third on macOS, the second on this exact step.
  - Hard stop `3.verify`.
  - For `2.10.r3d`: append this instance to the backlog beside the sixth-instance line, and carry the test-only Phase 3 task question to the boundary.
- No `retry`, no planning commit, no `admin` command, and no runner deviation this block.

## Gotchas

- **Cherry-pick range.** `2.10.r3d` cherry-picks `phase/2..handoff/059`: 058's handoff, #046, and this handoff. All of it is under `docs/**`. `next-prompt.md` conflicts resolve to the incoming version, as in earlier reconciliations.
- **The WARN.** Read `/logs/reviews/2/r3/sol/` transcript lines around the three hits before deciding read or mention. Both earlier #025 WARNs this phase were mentions of the task text.
- **A two-PASS verdict at r3** means `2.close` → `2.10.r3d` is the remaining edge. Check the generator's graph in `ralph/tasks.json` before writing anything that changes it. A PASS reconciliation normally adds no tasks, and `EXPECTED_COUNT` stays as it is; read it, never carry it.
- **Container login expiry.** A task that dies in seconds with `Failed to authenticate: OAuth session expired` needs Michael's `cd /Users/mlsavage/Developer/essaydown && docker compose run --rm claude-login`, then a plain `ralph run`.
- **Never write the literal DONE promise** into any file an agent reads. It goes only in the `wip(2.10.r3d)` commit message.

## Next Steps

1. Run `status` (expected: `2.10.r3d principal-pending`) and `doctor` (clean). Give Michael the one-line state.
2. **`2.10.r3d`** in `.wt/2.10.r3d` on `task/2.10.r3d`:
   - Cherry-pick `phase/2..handoff/059`.
   - Reconcile r3: PASS/PASS 0/0/0. Fable is briefed on the verdict (a trigger). Settle the WARN as read or mention.
   - Copy the reports byte-identically into `docs/reviews/`.
   - Write `#review-2-r3`, with the #046 backlog instance line.
   - Commit `wip(2.10.r3d)` with the promise in the message, then restart the runner and arm the watcher.
3. At `2.close` / the Phase 2→3 boundary, bring Michael the Open Questions.
4. Rotate at every stop signal that ends a working block and before context passes about 150k.

## Open Questions

- **For Michael (Phase 2 / 3 boundary), unchanged from 058:**
  - #045's drop-Windows diff, with this phase's Windows-only gate failures as evidence. The r2h and r3h macOS failures do not count.
  - `tauri-plugin-wdio` (U25).
  - The U9 robustness test-only task.
  - Which of the 35 re-pointed hard stops become Phase 3 tasks.
  - The settings directory (U16).
  - Shift+Enter.
  - #045's "macOS required e2e runner on the embedded plugin".
  - The background-and-wait pattern at four occurrences (2.19 a2, 2.22 a2).
  - The `cfg(target_os)` question (one occurrence, r2h).
  - 2.25 check 5 not run: `[review-2-r2, 2.25 check 5 not run]`.
  - The `[1.46]` caret-race class: seven gate instances, three on macOS, two on `editor-astral-between-runs.spec.ts:161`'s Backspace. Should a test-only Phase 3 task route that step around the race (1.56's precedent)?

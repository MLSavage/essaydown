# Handoff 050: Phase 2, r1 fix chain → `NO-JOURNAL 2.19` (attempt 2 of 3)

Written 2026-09-29 by the principal: the Opus 5.5 session that ran the `2.10.r0d` reconciliation (Fable brief on the #041 D1 triage; Michael approved the list) and watched `2.16`–`2.19`. It ran in Claude Code on the Mac Mini, and it supersedes `049-phase-2-review-r0-reconciliation.md`.

This commit is on `handoff/050`, **based on `phase/2`** (`3d691ac`), not stacked on `handoff/049`. The r0d cherry-picked `handoff/040`–`049` into `phase/2`, so their content is integrated under new SHAs, even though `git merge-base --is-ancestor` still reports them as "not in". The next reconciliation (`2.10.r1d`) cherry-picks `phase/2..handoff/050` only. The next handoff is `051-*.md`.

## Current State

- **Branches.**
  - `phase/2` is at `3d691ac` `task(2.18): …`, 233 commits, not on origin. New since 049:
    - `b05af14` 2.10.r0d
    - `a70c4e4` 2.16
    - `18efe0a` 2.17
    - `3d691ac` 2.18
  - `main` is at `92a2ec1`, unchanged.
- **Tasks.**
  - `2.10.r0d` passed. It recorded verdict FAIL, #review-2-r0 and #006-mac-sync-smoke.
  - `2.16` (save lifecycle, opus) passed at a1.
  - `2.17` (close barrier, opus) passed at a1. It appended a backlog line: WebKitWebDriver's Close Window destroys the webview without raising CloseRequested (wry 0.55.1 `webkitgtk/mod.rs:460`), so `close.spec.ts` emits `tauri://close-requested` through IPC instead. A real title-bar or Alt+F4 close is unproven, with hard stop `3.verify`.
  - `2.18` (rename splice and rollback, opus) passed at a1. `content.replace` and `read_to_string(&new_doc)` both grep to 0.
  - **`2.19`** (sidecar re-read, sonnet) stopped at **`NO-JOURNAL 2.19` after attempt 2**:
    - **a1** capped at 81 turns (`error_max_turns`) with every deliverable built. Its commits are `f2a8d31` journal stub, `b556b71` journal complete, and the runner's `290a40e` recovery commit: `DocumentPane.tsx`, a new `sidecar-sync.ts`, a new `tests/sidecar-sync.test.ts`, `autosave.spec.ts` and one lessons line. I read the recovery diff: it is a coherent implementation, not a half-applied mutation.
    - **a2** made 22 tool calls and 2 result turns. It backgrounded the `autosave.spec.ts` e2e run and ended its turn to wait ("Waiting for the background e2e run … rather than re-polling"). It committed nothing and appended no journal line. The journal holds one `- [2.19]` line (a1's, completed).
  - Pending: `2.20` (new_file `create_new`, sonnet), `2.21` (dev-route mount wait, sonnet, Michael's F6), `2.verify.r1` (sonnet, needsCI), `2.verify.r1h`, `2.10.r1a` (claude), `2.10.r1b` (sol), `2.10.r1d`, `2.close`.
- **Status:** `Phase 2, 2.19 running attempt 2; last passed 2.18; gates open: none; plan requests: none; blocked: none`. `doctor` is clean. The host checkout is clean on `phase/2`.
- **Runner.** It has exited after NO-JOURNAL: `pgrep` is empty, and the tmux pane `essaydown:runner` (pid 8940) is at `zsh`. The restart command is `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 2 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher.** Stopped at rotation. runner.log has 183,722 lines, and the last lines are `[ralph] 2.19 attempt 2 …` and then `NO-JOURNAL 2.19`. Re-arm only after the restart, at `wc -l` + 1:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=<wc -l + 1>; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  On every expiry the session re-arms from the same start, runs `status` and a catch-up grep, and filters out the task-start lines already reported (`grep -v -E '^\[ralph\] 2\.19 attempt 3 '` and so on), so a re-arm does not replay them.
- **Expected next stop signal:** after the lesson commit and the restart, `[ralph] 2.19 attempt 3`. Then either 2.20 starts or `STUCK 2.19` (a3 is the last of `MAX_ATTEMPTS` 3).

## Corrections

- `049` (on `handoff/049`) says the next handoff stacks on `handoff/049`. It does not: `handoff/040`–`049` are integrated by cherry-pick (`b05af14`), and `handoff/050` is based on `phase/2`. Delete `handoff/040`–`049` after `2.close`, as 049 planned.
- `049`'s watcher start (177,702) is stale; see Current State.

## Decisions

- **#review-2-r0** (in `b05af14`):
  - Verdict FAIL.
  - 39 raw findings, 30 unique, 10 shared.
  - Five blocking under #041 D1: U1/U6/U20 → 2.16, U2 → 2.17, U3/U4 → 2.18, U5 → 2.19, U14 → 2.20.
  - 2.21 was added on Michael's word.
  - The robustness 6-round cut is backlogged with a test-only task at the Phase 3 boundary (Michael).
  - 22 backlog lines.
  - 35 fired `2.verify` hard stops re-pointed to `3.verify`, whose text now makes its journal account for them.
  - 2.verify.r1 (a) promotes the checked-outcome rule (U1).
  - EXPECTED_COUNT 298 → 309.
- **#006-mac-sync-smoke** was appended from 2.9's accepted record.
- **Michael's answers** (verbatim option labels, recorded in #review-2-r0):
  - "Approve F1–F5 (Recommended)"
  - "Yes, add F6"
  - "Backlog, task at Phase 3 boundary (Recommended)"
- **Fable** was consulted once (the r0d D1 triage). The brief was `fable-brief-2.10.r0d.md` in the session scratchpad; its content is summarised in #review-2-r0.
- **No runner deviation this block.**

## Gotchas

- **Background-and-wait on a long e2e: third occurrence** (2.19 a2). 049 set a threshold of "only if a third occurs", and this is the third, so it is now a boundary item (below). 2.19's own task text already said to run e2e "as one foreground call bounded by `timeout` (never `run_in_background` or a wakeup)", and the agent did it anyway.
- **The stub-skip after a capped attempt** did not recur at a2: a2 never reached the journal step.
- **Attempt 3 is the last.** If it caps or skips again → `STUCK 2.19`. A `retry` is then a DECISIONS entry on `handoff/050` first (#038), and a third retry is Michael's.
- `2.17`'s close e2e drives IPC, not a native close. At the next human gate that installs a build, add one manual check: type, close the window at once, relaunch, and confirm the text is on disk.
- **Worktree toolchain.** Never run pnpm, vitest or Playwright on the Mac inside `.wt/2.19`.

## Next Steps

1. `status` (expected: `2.19 running attempt 2`, runner exited), `doctor` (clean), `git status --short` (empty).
2. Write a **principal lesson** for 2.19 on `task/2.19` in `.wt/2.19`, as `chore(2.19): principal lesson …`, touching `docs/lessons.md` only, with the reversal `git -C .wt/2.19 reset --hard HEAD~1` in the message. Check the file's last byte first. The lesson says, in its own words and without the promise string:
   - Attempt 1 capped at 81 turns with every deliverable committed (`290a40e`).
   - Attempt 2 backgrounded the autosave e2e and ended its turn, so it appended no journal line.
   - Attempt 3 does no new implementation. Its first command is `node ralph/journal.mjs stub 2.19` (grep `-c -- '^- \[2.19\]'` then prints 2). It runs `scripts/check` once. It runs `autosave.spec.ts` once, as a **single foreground Bash call** of the form `timeout 900 sh -c 'Xvfb :99 -ac & DISPLAY=:99 pnpm --filter @essaydown/e2e-shell test -- --spec test/autosave.spec.ts' > /tmp/e2e.log 2>&1; grep -E 'passing|failing' /tmp/e2e.log`, never `run_in_background`, a Monitor or a wakeup ("a headless attempt that ends its turn to wait is over").
   - Then it completes its own stub with the guard names and the spec outcome, and commits.
   - Per #038, it also names the turn cost of each part as read from the a1 transcript. Read a1's `.evidence/tasks/2.19/1.log` for where its 81 turns went before writing that clause.
3. No `retry`. Restart the runner with the command above; it runs attempt 3 and writes `3.log`. Arm the watcher at `wc -l` + 1.
4. Handle 2.20 → 2.21 → `2.verify.r1` → `2.verify.r1h` (the CI gate; `scripts/gate.sh` outruns 120 s, so background it and read its file) → `2.10.r1a/b` → `PRINCIPAL 2.10.r1d`. That reconciliation is run by a **fresh session**, cherry-picks `phase/2..handoff/050`, and follows D1: a blocker in r1 goes to Michael before any planning commit.
5. At `2.close` / the Phase 2→3 boundary, bring Michael the boundary list (Open Questions).

## Open Questions

- **For Michael (Phase 2 / 3 boundary):**
  - #045's PRD and CLAUDE.md diff (drop Windows). The evidence is four Windows-only gate failures this phase: compile, the harness manifest, the rename rollback and the page-load transient.
  - Register `tauri-plugin-wdio`, or correct PRD §4's row (U25).
  - The U9 robustness test-only task.
  - Which of the 35 re-pointed hard stops become Phase 3 tasks before `3.verify`.
  - The settings directory name (U16).
  - Shift+Enter.
  - Re-read #045's "macOS required e2e runner on the embedded plugin" in light of the embedded provider's synthetic input.
- **Boundary, now at three occurrences:** background-and-wait on a long e2e (2.4 r0 a3, one earlier, 2.19 a2). The candidate fix is runner-side: the loop prompt, or a turn-end check that treats an assistant "waiting for background" end as capped. It needs transcript evidence and Michael's OK (#review-1-r1). The stub-skip after a capped attempt is still at two.

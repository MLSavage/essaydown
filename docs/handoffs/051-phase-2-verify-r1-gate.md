# Handoff 051: Phase 2, r1 fix chain passed → `HUMAN_GATE 2.verify.r1h`

Written 2026-09-29 by the principal: the Opus 5.5 session that continued from 050, wrote 2.19's attempt-3 lesson, restarted the runner and watched `2.19`–`2.verify.r1`. It ran in Claude Code on the Mac Mini, and it supersedes `050-phase-2-r1-chain-2.19-no-journal.md`.

This commit is on `handoff/051`, **stacked on `handoff/050`** (`b6ad9d2`), which is not yet in `phase/2`. The next reconciliation (`2.10.r1d`) cherry-picks `phase/2..handoff/051`, which is 050's commit and this one. The next handoff is `052-*.md`.

## Current State

- **Branches.**
  - `phase/2` is at `fbce99e` `task(2.verify.r1): …`, 237 commits, not on origin. New since 050:
    - `2f48205` 2.19
    - `406f664` 2.20
    - `2c892d6` 2.21
    - `fbce99e` 2.verify.r1
  - `main` is at `92a2ec1`, unchanged.
  - `handoff/050` → `handoff/051` are stacked and not yet in `phase/2`. `handoff/040`–`049` are integrated by cherry-pick; delete all of them after `2.close`.
- **Tasks.**
  - `2.19` passed at **a3**, after the principal lesson `033c002` on `task/2.19`. a3 made 9 tool calls: it wrote the stub, ran the suite, did one build and one foreground e2e run (`autosave.spec.ts` 9 passing), and completed the journal.
  - `2.20` passed at a1.
  - `2.21` passed at **a2**:
    - a1 capped at 81 turns while trimming its journal notes to the 800-character cap, after the work was built. Its recovery commit is `cf759c2`, which I read: coherent, not a mutation.
    - a2 only verified: suite green, and `e2e/web` 102 passed.
  - `2.verify.r1` passed at a1. `CLAUDE.md` gained the U1 checked-outcome rule ("A helper that must finish before state is dropped …").
  - Pending: `2.verify.r1h` (CI gate, **open**), `2.10.r1a` (claude), `2.10.r1b` (sol), `2.10.r1d`, `2.close`.
- **Status:** `Phase 2, 2.verify.r1h human-pending; last passed 2.verify.r1; gates open: 2.verify.r1h; plan requests: none; blocked: none`. Phase 2 counts: 41 tasks, of which 32 passed, 4 superseded, 1 human-pending and 4 pending. `doctor` is clean. The host checkout is clean on `phase/2`.
- **Runner.** It has exited at the gate: the tmux pane `essaydown:runner` (pid 8940) is at `zsh`. The restart command is `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 2 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher.** Stopped at rotation. runner.log has 189,144 lines, and the last lines are `HUMAN_GATE 2.verify.r1h` and then `ROTATE-PRINCIPAL`. Re-arm only after the gate and the restart, at `wc -l` + 1:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=<wc -l + 1>; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  On every expiry, re-arm from the same start, run `status` and a catch-up grep, and filter out the task-start lines already reported (for example `| grep -v -E '^\[ralph\] (2\.10\.r1a attempt 1|2\.10\.r1b attempt 1) '`).
- **Expected next stop signal:** the gate outcome (ACCEPT or GATE-FAILED) from `scripts/gate.sh 2.verify.r1h`. After ACCEPT and the restart: `[ralph] 2.10.r1a …` and `[ralph] 2.10.r1b …`, then `PRINCIPAL 2.10.r1d`.

## Corrections

- `050` Next Steps 2 gave the attempt-3 e2e template as `timeout 900 sh -c '…'`. That is wrong: 900 s is over the Bash tool's 600 s ceiling per call. That ceiling is what moved 2.19 a2's call to the background (a2's transcript says "exceeded the 10-minute foreground limit and was moved to background automatically"). The lesson `033c002` used a1's working form instead: the inner bound is `timeout 540` and the tool timeout is 600000. A lesson's long-command bound is at most 540 s.
- `050` says the watcher start is 183,723 on restart. That was correct for this block, and it is superseded by the count above.

## Decisions

- No DECISIONS entries this block. No runner deviation. No Fable consultation.
- **Principal lesson** `033c002` on `task/2.19` (`docs/lessons.md` only; integrated with 2.19). a1's 94 tool calls split as:
  - orientation and code reading: 40
  - implementation and unit test: 15
  - suite: 4
  - e2e edits: 9
  - build plus two e2e runs: 14
  - suite rerun: 1
  - journal and commit: 11
- **2.21 scope gap: carry to the r1d, not acted on.**
  - What happened: 2.21 added the mount wait (`getByTestId("editor").waitFor()`) after every dev-route `goto` in the 16 `e2e/web` files that use `openEditor`/`load()`. Its guard is `tests/dev-route-mount-wait-in-e2e.test.ts`.
  - What was left out: 15 other `e2e/web` files reach a dev route through `openRendered`, `openBlankEditor`, `openSource`, `tokenColors` or an inline `goto`, and they have no wait:
    - `editor-astral-neighbour`, `editor-break-in-mark`, `editor-cursor`, `editor-input`, `editor-link-edge`
    - `editor-list-paste`, `editor-mark-edge`, `editor-reveal`, `editor-soft-line-breaks`, `editor-source`
    - `editor-table-empty-cell`, `editor-trailing-break`, `editor-trailing-space`, `editor-undo`, `outline-produce`
  - Why it falls short: the acceptance says "Every e2e/web `goto` of a dev route is followed by the mount wait", and the acceptance binds. a1 recorded its narrower reading in lessons and in a backlog line with "revisit on a third instance".
  - Status: test-only, so not blocking under #041 D1. Michael was told that the r1d gets it as a backlog candidate unless he says otherwise. He has not answered yet.

## Gotchas

- **Rotation at the gate.** The runner printed `ROTATE-PRINCIPAL` with `HUMAN_GATE 2.verify.r1h` (PRINCIPAL.md "Handoff cadence", #015). The session that runs `2.10.r1d` must be one that did not run the phase's tasks, so the session that runs this gate and watches r1a/b rotates again at `PRINCIPAL 2.10.r1d`.
- **A capped attempt with the work done.** 2.21 a1 capped while trimming its journal notes to the 800-character cap (`journal.mjs` refuses more). a2 recovered without a principal lesson. This is the ordinary capped path, not NO-JOURNAL.
- **Background-and-wait** stays at three occurrences (none this block). The stub-skip stays at two.
- `2.17`'s close e2e drives IPC, not a native close. At the next human gate that installs a build, add one manual check: type, close the window at once, relaunch, and confirm the text is on disk.
- **Worktree toolchain.** Never run pnpm, vitest or Playwright on the Mac inside `.wt/<id>`.

## Next Steps

1. Run `status` (expected: `2.verify.r1h human-pending`), `doctor` (clean) and `git status --short` (empty).
2. Run `scripts/gate.sh 2.verify.r1h` in the background, redirected to a file in the scratchpad, and read that file. It pushes `ci/2.verify.r1/a1` at the integrated SHA, waits for `ci.yml` and fetches the three artifacts.
   - **ACCEPT:** restart the runner (the command in Current State), arm the watcher at `wc -l` + 1, and watch `2.10.r1a` (claude) and `2.10.r1b` (sol).
   - **GATE-FAILED:** rotate first, then brief Fable (PLAN-GATE trigger) → a `.g<n>` repair. The repair scopes to what failed. A transient with the same signature on an unchanged file gets a same-SHA rerun (RUNNER-SPEC §2, #023).
3. Handle each reviewer's signal. A single-reviewer failure → `ralph/ralph.sh retry <id>` of that reviewer alone (#043). `USAGE-LIMIT` → the same `ralph run` after the reset.
4. At `PRINCIPAL 2.10.r1d`, rotate. The fresh session cherry-picks `phase/2..handoff/051` (or the newest handoff) into `task/2.10.r1d` first, applies #041 D1 (a blocker in r1 goes to Michael before any planning commit), and weighs the 2.21 scope gap above as a backlog line.
5. At `2.close` / the Phase 2→3 boundary, bring Michael the Open Questions.

## Open Questions

- **For Michael (Phase 2 / 3 boundary), unchanged from 050:**
  - #045's PRD and CLAUDE.md diff (drop Windows). The evidence is four Windows-only gate failures this phase: compile, the harness manifest, the rename rollback and the page-load transient (2.21's instance was also windows-latest).
  - Register `tauri-plugin-wdio`, or correct PRD §4's row (U25).
  - The U9 robustness test-only task.
  - Which of the 35 re-pointed hard stops become Phase 3 tasks before `3.verify`.
  - The settings directory name (U16).
  - Shift+Enter.
  - Re-read #045's "macOS required e2e runner on the embedded plugin".
  - The background-and-wait pattern at three occurrences. The candidate runner-side fix needs transcript evidence and his OK (#review-1-r1). 2.19 a2's transcript is that evidence: the tool auto-backgrounded a call bounded over 600 s.
- **For Michael now (pending):** whether 2.21's 15-file scope gap is backlog at r1d (the default) or a fix task.

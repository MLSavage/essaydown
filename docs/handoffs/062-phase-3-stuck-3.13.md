# Handoff 062: Phase 3 running, `STUCK 3.13`

Written 2026-10-05 by the principal, the Opus 5.5 session that continued from 061. That session resolved `STUCK 3.10` (#052), restarted the runner, and watched 3.17, 3.11 and 3.12 pass and 3.13 stick. This handoff supersedes `061-phase-3-stuck-3.10.md`.

This commit is on `handoff/062`, stacked on `handoff/061` (which carries handoff 061 and proposal 002, no DECISIONS.md tail), from a temporary worktree. Read it with `git show handoff/062:docs/handoffs/062-phase-3-stuck-3.13.md`. The next handoff is `063-*.md`.

## Current State

- **Branches.**
  - `phase/3` is at `27656ef` `task(3.12)`. Origin `phase/3` is at `81fb70a` `task(3.17)`, so 3.11 and 3.12 are not pushed.
  - `main` and `phase/2` are at `da7d07b`.
  - `handoff/061` → `handoff/062` (this commit) is the stack the `3.7.r0d` reconciliation cherry-picks.
  - `abandoned/3.10` (tip `89ad5f5`, #052) and `attic/3.1-pre051` are kept as evidence.
- **Status:** `Phase 3, idle; last passed 3.12; gates open: none; plan requests: none; blocked: 3.13:blocked`. `doctor` is clean. The host checkout is clean on `phase/3`.
- **Tasks this block:**
  - **3.17** (the replacement for 3.10, #052) passed at attempt 2 (`81fb70a`; attempt 1 capped at 81 turns with sound work). The `essaydown: backend started` line reaches the backend capture on Linux too, so the presence case is real everywhere.
  - **3.11** (rename read-then-write) passed at attempt 1 (`6671bef`). It reproduced at base, and the fix moves the rewrite into the sync's serialised owner.
  - **3.12** (the mark a typed character takes at a mark's edge) passed at attempt 1 (`27656ef`).
  - **3.13** (adjacent same-kind runs) is **STUCK after 3 attempts**:
    - a1 (51 turns) did the work and recorded the conflict;
    - a2 (15 turns) and a3 (9 turns) changed no code and restated the conflict.
    - `task/3.13` in `.wt/3.13`, at `b1c2e19`, changes 4 files: `packages/core/src/format.ts`, `packages/core/test/adjacent-same-kind.test.ts`, lessons and journal. Suite green. Logs are `.evidence/tasks/3.13/{1,2,3}.log`.
- **The conflict (3.13).** The text is internally inconsistent:
  - No Markdown parses to two adjacent `delete` siblings. (b)'s character-reference separator leaves `~~~~` adjacent, so GFM reads one run, and "parse has the tree's node count" cannot hold for `delete`.
  - ProseMirror merges adjacent same-mark runs, so the required fixture (`*x.*_y_` etc.) fails 11 editor corpus legs while core keeps the runs apart.
  - a1 kept emphasis and strong apart with separated delimiters (green), merged delete pairs in `handleRoot`, and left the fixture out.
- **Runner:** idle after `STUCK`; the tmux pane `essaydown:runner` (pid 8940) is at `zsh`. Restart: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 3 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher:** stopped. runner.log has 216,918 lines. After the restart, arm this as a persistent Monitor at `wc -l` + 1 (30-minute cap). On every expiry, run `status` and a catch-up grep from the same start, and add each already-reported `[ralph] <id> attempt <n> (loop` line to the `grep -v -F` list:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=START; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  Never add a free-text term to its filter.
- **Expected next stop signal:** none until 3.13 is replaced. After that, the chain runs 3.18 → 3.14 → 3.15 → 3.16 → 3.1 … 3.6 → `3.verify` → `HUMAN_GATE 3.verifyh`.

## Corrections

- `061` Current State: "Origin `phase/3` is at `3791f74`". Michael pushed through `81fb70a`.
- `061` Open Questions, option A's line `essaydown: debug build started`: the installed `@wdio/tauri-service` 1.3.0 classes a line by a level word in its first 60 characters, so it would be dropped as debug. The line that landed is `essaydown: backend started` (Michael, #052).
- `061` Gotchas: "A planning commit follows whatever route…" and `next-prompt.md` at `061` step 4 ("a principal commit goes on `handoff/062`"). A planning commit that replaces a loop task must land on `phase/3` (#052), because the task's worktree is cut from `phase/3` and `sync-state` reads the host tree. Only handoff commits go on `handoff/NNN`.

## Decisions

- **#052** (on `phase/3`, `e95c83f`): 3.10 abandoned and replaced by 3.17.
  - **Route:** `abandon` first, then a planning commit on `phase/3` from the host while idle. The replacement depends on the abandoned task's own dependency, and its dependent is rewired to it. The abandoned row stays byte-identical, since `sync-state` refuses to mutate or delete an `abandoned` task. The replacement's text checks out the abandoned branch tip's files by SHA. Lessons lines are carried and journal lines are not.
  - **Why manual:** this is the documented manual procedure for "a STUCK loop task has no replacement vehicle" (§4.5 names the outcome; plan requests exist only for gates). Fable confirmed the route against the code.
- **Michael (2026-10-05), conditional on 3.13 stopping, which it has.** The replacement takes this acceptance:
  - Emphasis and strong keep two runs (separated delimiters, node count kept; a1's work).
  - Delete pairs merge before serialising. The node-count clause reads "the merged tree's node count and text" for delete, and the journal says why no separation exists: any separator leaves `~~~~` adjacent.
  - The fixture is dropped; the hand-built trees over kind × edge class are the guards.
  - The rest of the acceptance is unchanged.
  - **Plus a backlog line:** a file holding `*a*_b_` is rewritten to `*ab*` when its paragraph is edited in the rendered view, because ProseMirror merges adjacent same-mark runs while core keeps them. Trigger: the next task that touches mark handling in mdast↔ProseMirror conversion, or a reviewer reproducing it. The replacement's journal names that line, so the fixture's removal is recorded, not silent.
- No `retry`, no Fable brief on 3.13 yet, no planning commit since #052.

## Gotchas

- **STUCK is a Fable trigger.** Write the brief to the scratchpad (signal and id, evidence paths, what was tried, Michael's answer as a binding constraint, the one question, the answer format).
  - The route question is mostly settled by #052, so the one question is narrower. Is #052's route right for 3.13 too, and exactly which files does 3.18 check out from `b1c2e19`? Probably `packages/core/src/format.ts` and `packages/core/test/adjacent-same-kind.test.ts`; Fable should confirm that a1's delete merge in `handleRoot` and its tests match Michael's option 1.
  - Also: does the position map (K2) need anything for the delete merge?
- **#052's route, step by step:**
  1. `ralph/ralph.sh abandon 3.13 --reason "…"`. `.wt/3.13` must be clean first: check `git -C .wt/3.13 status --porcelain`.
  2. PRD §8 gets `3.18` (deps `["3.12"]`) inserted after 3.13's row, and 3.14's deps change from `["3.13"]` to `["3.18"]` (check the line first). 3.13's row stays byte-identical. Use a node script, as #052 did, to keep the JSON escaping exact.
  3. `node ralph/generate-tasks.mjs`; `printf '340\n' > ralph/EXPECTED_COUNT`; `node ralph/validate-tasks.mjs` must print OK 340.
  4. Carry the `[3.13]` lessons lines from `b1c2e19` (`git diff phase/3...b1c2e19 -- docs/lessons.md`; check the trailing newline first).
  5. Add the backlog line above and DECISIONS #053, with a reversal.
  6. Commit on `phase/3` from the host (`doctor` clean first).
  7. `sync-state`, `doctor`, and `run --phase 3 --dry-run`, which must name `3.18`; then restart.
- **Never write the literal promise** in the task text, the lessons, DECISIONS, or the backlog. Check `git diff | grep -c '<promise>'` = 0 before committing.
- **A recovery commit can carry a mutation.** Before any retry, diff `packages/*/src` against the branch base. 3.13's a2 and a3 made no code change, so `b1c2e19`'s `format.ts` is a1's final state.
- **settings.spec.ts flake (3.17's journal).** One container full-suite run failed `settings.spec.ts` on settings left over in `~/.config/com.savagesystems.essaydown/` from earlier runs. That is U16's dev-machine hazard, re-pointed to `5.verify` (#048). Not acted on.
- **Proposal 002** lands at the Phase 3→4 boundary, after `3.close`, never during Phase 3 (handoff 061 addendum).

## Next Steps

1. One-line state to Michael.
2. Fable brief on `STUCK 3.13` with Michael's conditional answer as the constraint.
3. Do the planning change by #052's route (Gotchas), then `sync-state`, the dry run (naming 3.18), the restart, and a fresh watcher at `wc -l` + 1.
4. Hand Michael `git push origin phase/3` when convenient (3.11, 3.12 and the #053 commit).
5. Rotate at the next stop signal that ends a working block.

## Open Questions

- None open with Michael. His 3.13 answer is recorded under Decisions; ask him again only if Fable's reading contradicts it.

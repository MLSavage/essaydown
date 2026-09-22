# Handoff 027 — Phase 1 in the r7 chain: 1.49 and 1.50 passed, `STUCK 1.51` on a task-text conflict decided at DECISIONS #030, the retry procedure pending

Written 2026-09-21 by the principal (the fresh session that ran the `1.10.r6d` reconciliation and watched the r7 chain to `STUCK 1.51`; Claude Code on the Mac Mini), at the `STUCK 1.51` stop signal, before the repair (the handoff is the durable copy of the plan). Role, reading order and rules: `docs/PRINCIPAL.md`. Supersedes `026-phase-1-review-r6-reconciliation-pending.md` (in the tree since `695fb0f`). This commit is on `handoff/027`, cut from `phase/1` at `faf6103` (handoff 026 is already in the tree, so nothing is stacked — rotate.md step 5's third case); `git log --oneline phase/1..handoff/027` shows two commits (DECISIONS #030 at `97aa2c3`, this one) and the `1.10.r7d` reconciliation cherry-picks that one range. Next: `028-*.md`.

## Current State

- **`phase/1` tip `faf6103`** (`task(1.50)`); `main` at `052e206`; `origin/phase/1` at `4590b8d` (Michael pushes by hand, #010). Host checkout on `phase/1`, tree clean.
- **Reconciliation `1.10.r6d`: passed**, integrated as `695fb0f` (verdict FAIL, `.evidence/reviews/1/r6/verdict`; DECISIONS #review-1-r6; the r7 chain 1.49–1.54, `1.verify.r7`, `1.10.r7a/b/c/d` appended; `EXPECTED_COUNT` 244).
- **1.49: passed** at attempt 1 (38 turns), `6d78458`. **1.50: passed** at attempt 2 (a1 `error_max_turns` at 51 with the work complete and its journal line marked Complete; a2 25 turns), `faf6103`.
- **1.51: `blocked` — `STUCK 1.51`** after a1 (51, capped, the work mostly built), a2 (43, exit 0, DONE withheld on two task-text conflicts, journal `Status: Blocked`, two lessons) and a3 (9, re-confirmed). Branch `task/1.51` in `.wt/1.51`: 7 commits, tree clean; logs `.evidence/tasks/1.51/{1,2,3}.log`. Decided at **DECISIONS #030** (on this branch, `97aa2c3`): the fixture yields (inline html without a soft break before it), the two inverse cases name the trailing-atom block end as 1.52's member.
- **Tasks** (`ralph/ralph.sh status`): "Phase 1, idle; last passed 1.50; gates open: none; plan requests: none; blocked: 1.51:blocked." Graph 244 tasks.
- **Runner**: tmux `essaydown`, window `runner`, `zsh` at the prompt after `STUCK 1.51`. `.locks/` empty, no `ralph run` process, no containers. Restart: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 1 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher** (`Monitor` tool, persistent, 30 s poll):
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=$(($(wc -l < .evidence/runner.log)+1)); while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  Current marker: `STUCK 1.51`. **Arm a fresh watcher after every `retry`**: the `awk` dedup has already seen `[ralph] 1.51 attempt 1 …` and would swallow the retry's identical line.
- **Expected next stops**: the retry's `1.51` → `1.52` → `1.53` → `1.54` → `1.verify.r7` → `HUMAN_GATE 1.verify.r7h` (rotate there, #015).

## Corrections

- **`STUCK 1.54`** after attempt 3 capped at 51 mid-mutation: the helpers carry #034's differs-per-step form, the first mutation is recorded in the transcript (the location assertion red, offset 4 received for 5), and the runner's recovery commit `b175e87` swept the still-mutated `packages/core/src/format.ts` (1.49's third `SPLIT_PAIR` form disabled, 3 lines) onto `task/1.54` — the retry restores it from the branch base `b01c7fe` FIRST, then the suite once, journal, DONE (the `chore(1.54): principal lesson` on the branch says so); logs moved aside as `{1.a1-capped,2.a2-capped-nostub,3.a3-capped}.log`. The range `phase/1..handoff/027` is fourteen commits after this one.

- **`1.54` (after `#034`)**: two sonnet attempts capped at 51 (the second stubbed nothing — `NO-JOURNAL 1.54`), the work on the branch; DECISIONS #034 on this branch reads the helper's two forms and lists the remainder; the plain restart runs attempt 3 (the last); at `STUCK 1.54` the lesson-and-retry shape with the logs as `{1.a1-capped,2.a2-capped-nostub,3.a3-<word>}.log`. The range `phase/1..handoff/027` is thirteen commits after this one.

- **`1.53` passed** at the retry's attempt 1 (13 turns), integrated as `b01c7fe` with #033's one-line pin change and nothing else; its logs `.evidence/tasks/1.53/{1.a1-429,2.a2-429,3.a3-blocked}.log` plus the retry's `1.log`. `1.54` (sonnet, test-only) is running. The range `phase/1..handoff/027` is eleven commits after this one.

- **`1.53` (after `#033`)**: attempts 1 and 2 lost to the session limit (#027's third and fourth instances; Michael named the reset, the plain restart followed), attempt 3 stopped correctly on the 1.46 pin at `position-map-editor-leg.test.ts:712`; DECISIONS #033 on this branch decides the pin yields (one line); the lesson-and-retry shape follows with the logs as `{1.a1-429,2.a2-429,3.a3-blocked}.log`. The range `phase/1..handoff/027` is ten commits after this one.

- **`1.52` passed** at attempt 3 (23 turns), integrated as `c902965`: the agent read #032 from `git show handoff/027:docs/DECISIONS.md` and applied steps (i)–(iv) — no `it.fails` in the tree, `pnpm test` 3,736 passed with no expected fail; no lesson commit, no retry; its logs stay as `.evidence/tasks/1.52/{1,2,3}.log`. `1.53` is running. The range `phase/1..handoff/027` is eight commits after this one.

- **`1.52` (after `#032`)**: attempt 1 capped at 51 with the work built and three `it.fails` members for the code-block interior (its text told it to pin and to stop on the pin — the reconciliation's contradiction); DECISIONS #032 on this branch decides: a positive named exclusion, no `it.fails`, the chain's "no expected fail" tails hold; at `STUCK 1.52` the lesson-and-retry shape with #032's steps; if an attempt integrates the `it.fails` first, #032's second paragraph applies (file-level reading of the later tails, the conversion at the next planning-capable commit). The range `phase/1..handoff/027` is now seven commits.

- **`1.51` passed** at the retry's attempt 3 (19 turns), integrated as `7626696`: the agent read #031 from `git show handoff/027:docs/DECISIONS.md` (lesson [1.43] 15:48's lookup) and applied the amended bytes with no lesson commit and no second `retry` — #031's instrument paragraph and the correction below it are superseded; the retry's logs stay as `.evidence/tasks/1.51/{1,2,3}.log` (nothing to move aside). `1.52` is running. The next reconciliation's range `phase/1..handoff/027` is five commits (#030, this handoff, #031, the first correction, this one).

- **This file's Current State and Next Steps 1, after `#031`**: the first retry ran (its attempt 1 stopped, correctly, on #030's fixture bytes — two out-of-scope leg models, DECISIONS #031 on this branch); `1.51` needs a **second** `retry` after `STUCK 1.51` recurs, with the lesson line carrying #031's amended bytes (`alpha <i>beta</i> gamma`, `*ab* <b>x</b> yz`, `<span>x</span> gamma`) and the retry's logs moved aside as `{1.r1a1-blocked,2.r1a2-blocked,3.r1a3-blocked}.log`; `git log --oneline phase/1..handoff/027` now shows four commits (#030, this handoff, #031, this correction).

- `026` Next Steps 1: done (`695fb0f`); the handoff range it named (`phase/1..handoff/026`) is in the tree; the next reconciliation's range is `phase/1..handoff/027`.
- `026` Decisions, "26 of 58 `loop` tasks": counted at #review-1-r6 from the runner log as **26 of 57**; `NO-JOURNAL` stops with a Phase 1 id 14 (two of them 429s: 1.41, 1.45), `STUCK` 7 before 1.51.
- `026`'s `next-prompt.md` job 5, "`git branch -D handoff/010 … handoff/026`": through `handoff/027`.

## Decisions

- **`#review-1-r6`** (in the tree, `695fb0f`): verdict FAIL; L1–L11; the r7 chain; the reviewer record (unique Claude 8 of 10, Sol 0 of 3, Grok 0 of 1; three shared, agreed by class); the turn record.
- **`#030`** (this branch): 1.51's two conflicts and the retry procedure (below). The reconciliation's own error is named there: it wrote a fixture for the one serializer branch that rewrites a text value without reading invariant B for it.
- **Runner deviations this block:** one `retry` pending (1.51, #027's log-rename procedure); one 429 in the r6 chain's history (1.45 a1, #027's second instance) — none in the r7 chain so far. No `admin`, no `docker/` change, no `fix(runner)`.
- **1.52's members** (from #030 Decision 2): the trailing-atom block end is a member of L5; 1.52's agent reads it from the `[1.51]` lesson line and `git show handoff/027:docs/DECISIONS.md`.

## Gotchas

- **The watcher dedups by whole line**: after a `retry`, arm a new one (the old `seen` set holds the task's `attempt 1` line).
- **`handoff/027` is cut from `phase/1`, not stacked** (026 is in the tree). The reconciliation cherry-picks `phase/1..handoff/027` (two commits, `docs/**` only). Never cherry-pick `handoff/026` again.
- **The temporary worktree** for this branch lives in the session scratchpad (`<scratchpad>/handoff-027`), not `.wt/handoff-027` as rotate.md step 5 writes; remove it with `git worktree remove` when done — the branch stays.
- **1.51's retry inherits seven commits** (two stubs, the implementation, a recovery commit, attempt 2's completion); its own journal line is a NEW `- [1.51] ` line; the a2 line stays `Blocked`.
- **1.52 will meet no trailing-atom fixture in the corpus** (Decision 1's fixture ends no paragraph in an atom) but must add one to its named guards; if its corpus leg turns another member red, its text says how to file it (a named `it.fails` member and a backlog line) and to stop on an expected fail — that is the next likely `STUCK`, decided by the same shape (#026/#028/#030).
- In this zsh a bare `echo ===` aborts a compound command and an unmatched glob aborts a script — quote separators, `setopt nullglob` in watchers; `grep -- '- [id]'` needs the `--`. `scripts/gate.sh` outruns the 120 s foreground limit; Michael runs it in his shell (`! scripts/gate.sh …`) and the output lands in his background task file.
- Harness memory pressure: `ralph/ralph.sh status` on every wake before trusting silence.

## Next Steps

1. **The 1.51 retry (#030's instrument)**, if not already done by this session: in `.wt/1.51`, append two `[1.51]` lesson lines to `docs/lessons.md` (Decision 1's fixture shape and Decision 2's named exclusion, each pointing to `DECISIONS #030 on handoff/027`, plus the procedure: NEW journal line by `printf`, reshape the fixture and the two cases, change nothing else, suite once, complete, commit, DONE) and commit `chore(1.51): principal lesson …` (`docs/lessons.md` only; reversal `git -C .wt/1.51 reset --hard HEAD~1` before the retry's attempt commits); move the logs aside (`1.a1-capped.log`, `2.a2-blocked.log`, `3.a3-blocked.log`); `ralph/ralph.sh retry 1.51`; idle checks; the restart; a fresh watcher.
2. **Watch 1.52–1.54, `1.verify.r7`**: a capped attempt with the work complete → the retry-with-a-lesson shape; a withheld DONE on a conflict → a DECISIONS entry on `handoff/027` (stacked commits on this branch while it is not in the tree) deciding which sentence yields, the lesson line, `retry`; a 429 → wait for the reset Michael names, then the plain restart.
3. **`HUMAN_GATE 1.verify.r7h`**: `/rotate`; hand Michael `scripts/gate.sh 1.verify.r7h`; a windows-only single-case failure with the spec unchanged and no editor runtime change → the #023/#029 rerun and abandon procedure (1.54 repairs the counted-press instrument, so a G4-shaped failure after it is no longer the known transient — read the case before deciding).
4. **`PRINCIPAL 1.10.r7d`**: a fresh session (#015); it cherry-picks `phase/1..handoff/027`; the FAIL pattern is `task(1.10.r6d)` at `695fb0f`, the PASS pattern `task(0.12.r2d)` at `052e206`.
5. **Phase boundary idle window** (only after `1.close`, host checkout on `phase/2`, runner idle): `#025`'s `fix(runner)`; `#023`'s `fix(runner)` (two instances, #029); H7's `fix(runner)`; `chore(0.0)` for rotate.md step 5 (the stacked-handoff rule with its "already in the tree" condition and the scratchpad worktree), the stale `description` line, PRINCIPAL.md's doctor sentence and PRINCIPAL.md gaining Sol's r4 lesson, #028's, #030's, the r5 and r6 principal lessons; `git branch -D handoff/010 … handoff/027`; ask Michael for `scripts/gate.sh gc` (after `git ls-remote origin 'refs/heads/ci/*'`) and the `phase/1` push (#010); on Michael's OK only: the turn-budget raise (evidence: #review-1-r5, #review-1-r6, handoff 025), the 429 signal (#027, two instances), the gate fetch-on-failure (#review-1-r3 I7), the reviewer-prompt option.

## Open Questions

- Whether 1.52's corpus inverse leg turns a member red that neither #review-1-r6 nor #030 named (the leg is the first every-position property over the corpus; Claude's fuzz and Sol's probes suggest the named classes are the set, but neither ran the inverse over every fixture).
- Whether the app keeps upstream's eol-before-html rewrite (#030's backlog line, Phase 2's file-open task).
- The turn budget and the 429 signal: Michael's calls at the boundary, evidence unchanged (the r7 chain so far: 1.49 one attempt, 1.50 one cap, 1.51 one cap and two withheld DONEs on a conflict the reconciliation should have foreseen).

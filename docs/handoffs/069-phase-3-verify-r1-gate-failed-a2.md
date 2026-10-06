# Handoff 069: Phase 3, `3.verify.r1h` a2 GATE-FAILED → `PLAN-GATE plan.3.verify.r1h.r1`

Written 2026-10-06 by the principal, the Opus 5.5 session that continued from 068. That session briefed Fable on `plan.3.verify.r1h.r0`. Fable called a same-SHA rerun, the session ran a2, a2 failed, and the session rotated. This handoff supersedes `068-phase-3-verify-r1-gate-failed.md`.

This commit is on `handoff/069`, stacked on `handoff/068` and `handoff/067`. None of the three is in `phase/3` yet, so the next reconciliation cherry-picks `phase/3..handoff/069`. Read this handoff with `git show handoff/069:docs/handoffs/069-phase-3-verify-r1-gate-failed-a2.md`. The next handoff is `070-*.md`.

## Current State

- **Branches.**
  - `phase/3` is at `9de2027` `task(3.verify.r1)`, 1 commit ahead of origin.
  - `main` is at `da7d07b`.
  - Unmerged handoff refs: `handoff/067`, `handoff/068` and `handoff/069` (this commit). `handoff/061`–`066` are stale; delete them after `3.close`.
- **Status:** `Phase 3, idle; last passed 3.verify.r1; gates open: none; plan requests: plan.3.verify.r1h.r1:pending; blocked: 3.verify.r1h:blocked`. `doctor` is clean. `plan.3.verify.r1h.r0` is `abandoned`; the rerun withdrew it.
- **Gate `3.verify.r1h`, two attempts at the same SHA `9de2027`, both GATE-FAILED.**
  - **a1**, run `37450257728`, evidence `.evidence/ci/3.verify.r1h/a1/`. Gating: ubuntu e2e-shell `source-toggle.spec.ts` (1) `Cmd/Ctrl+/ never showed the source view focused` at `toggleTo` (`:88` from `:268`). Recorded only, Windows: Vitest timeouts at `rewrite.test.ts:143` (30 s) and `sentences-zero-width.test.ts:247` (default 5 s).
  - **a2**, run `37456742438`, ref `ci/3.verify.r1/a2`, evidence `.evidence/ci/3.verify.r1h/a2/`.
    - Vitest 7170/7170 on ubuntu, macOS and Windows. The a1 Windows timeouts did not recur.
    - e2e-shell, ubuntu 14/15: `source-toggle.spec.ts` (1) failed again, the same case as a1.
    - e2e-shell, macOS 14/15: `autosave.spec.ts:92`, "an edit is on disk as canonical Markdown 600 ms later, with its sidecar", failed with `ENOENT … a.essaydown.json`. The `.md` assertion at `:91` passed; the sidecar was not yet on disk.
    - e2e-shell, Windows 15/15. C16 (`autosave.spec.ts:192`) did not recur.
- **Windows does not gate.** `ci.yml:20` and `:190` set `continue-on-error` for windows-latest on `test` and `e2e-shell` (#047).
- **Runner:** stopped. Pane `essaydown:runner` (pid 8940) is at `zsh`, with no `ralph run` and an empty `.locks/`. runner.log has 251698 lines, unchanged since 068: `gate.sh` writes its signals to its own output, not to runner.log. Restart only after the plan request resolves: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 3 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher:** none is running. After a restart, arm it as a persistent Monitor (30-minute cap) with `start=` set to `wc -l < .evidence/runner.log` + 1, read at restart:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=START; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  `START` is the number you compute. Write the digits in, never the word.
- **Expected next stop after the plan:** the runner runs the fix task(s), then `3.verify.r1.g1`, then `HUMAN_GATE 3.verify.r1.g1h`.

## Corrections

- **`068`, Next Steps 2–3 and the 068 version of `next-prompt.md`:** `plan.3.verify.r1h.r0` is resolved (rerun, now `abandoned`). The open request is `plan.3.verify.r1h.r1`.
- **`068`, Gotchas, "Transient or code?":** the Windows Vitest timeouts were recorded only and never gated a1. Windows `continue-on-error` is set in `ci.yml:20`/`:190`.

## Decisions

- **Fable's answer on `plan.3.verify.r1h.r0`: a same-SHA rerun.** Confidence: high that no failure was code-caused, medium that a2 would be green. The reasons, summarised:
  - Only ubuntu e2e gated a1.
  - Nothing in `e21d6f8..9de2027` touches `e2e/`, `packages/editor/src/toggle.ts` or the `toggle` path in `DocumentPane.tsx` (`:415-433`, `:469`, `:480-536` unchanged).
  - In case (1) the surface never switched: case (2), which passed next, asserts the rendered view. `Mod-/` is bound only inside the two editors (`toggle.ts:1354`, `:1370`), and (1) is the spec's only chord that follows an unconfirmed `caretAtText` click (`routes.ts:284-292`). Every other case goes through `caretAtParagraph`, which confirms the caret from the readout and re-clicks.
  - The Windows corpus slowdowns are not 3.22's cost: 3.22's `refreshPositions` sits only on `applyReorderSentences`/`carryTopLevelMove`; the untouched sibling slowed by the same 25%; ubuntu and macOS were flat.
- **The rerun ran:** `scripts/gate.sh rerun 3.verify.r1h` → a2, failed as above.
- **Owed, not written:** the DECISIONS entry for this rerun, in #046's shape: transient rerun, the a1 numbers below, the a2 outcome. Write it with the planning commit, or on `handoff/070`. No DECISIONS entry and no runner deviation was written this block.

## Gotchas

- **source-toggle (1) has now failed twice at one SHA on ubuntu.** That is Fable's own stated trigger for a test-only `.g1`. Its scope, from Fable's conditional answer:
  - Change `e2e/shell/test/source-toggle.spec.ts` only.
  - Case (1)'s precondition confirms the rendered caret through the readout, the way `caretAtParagraph` does. The expected ProseMirror position for the h2's offset 2 is computed in Node from `mdastToPM(parse(markdown))`; `readout().cursor` is polled for it, and the click repeats on a miss. Never a Home/End key or a modifier chord in the contenteditable (#022, #024).
  - `toggleTo`'s one `waitUntil` becomes two named waits (the surface changed; the view is focused), so a failure names its half.
  - No other case's precondition changes.
  - Mutation note: with the confirmation removed the spec still passes in the container. The journal records that, and the gate is the only proof.
- **macOS `autosave.spec.ts:92` is new at this SHA, so decide transient or code before scoping.**
  - Against code: earlier instances of the same case on macOS at `2.verifyh` a1 and `2.verify.g2h` a1 (`grep -l '✖ an edit is on disk' .evidence/ci/*/a*/e2e-shell/*/e2e-shell.log`). It passed on macOS at a1 of this gate. The spec was last changed at `ec6828e` (2.23).
  - For code: 3.24 changed the save path (`DocumentPane.tsx` `createPaneSync` extraction; `document-sync.ts`'s `settle` on the watcher check, Keep mine and flush). Check whether 3.24 delays or reorders the sidecar write after the `.md` write before calling it transient.
  - If transient, it is filed with a revisit trigger, not repaired. If 3.24 is implicated, the fix is in scope of the `.g1`.
- **The two corpus tests (#039) still have no headroom,** although Vitest was green on all three OSes in a2. Fable's numbers:
  - `sentences-zero-width.test.ts:247` has no block-local budget; it ran at 91% of the 5 s default on ubuntu.
  - `rewrite.test.ts:143` is at 68% of 30 s on ubuntu.
  - They did not fail a gate, so they are backlog (lines below), not `.g1` scope. Exception: if Fable folds them in on a second-signal argument, the scope is those two test files only. `:247` gets the family's block-local `30_000`, or its totals are derived from per-fixture `it.each`. `:143` becomes a per-fixture `it.each(names)` that keeps the `checked > names.length` totals assertion. No budget is a multiple of a runner's timing.
- **The planning commit** goes only on `plan/3.verify.r1h/r1` in `.wt/plan.3.verify.r1h.r1` via `ralph/ralph.sh plan plan.3.verify.r1h.r1`. Rewiring: append the fix task(s), then `3.verify.r1.g1` (`needsCI`), and rewire `3.7.r1a`/`3.7.r1b`/`3.7.r1d` from `3.verify.r1h` to `3.verify.r1.g1h`. Model on `6d87fdd` (`plan.2.verify.r1h.r0`) and `fe8d333` (`plan.3.verifyh.r0`). If it appends to DECISIONS.md, rebase `handoff/067`–`069` onto the new `phase/3` tip from a temporary worktree (#039).
- **Never quote the literal promise** in any file an agent reads.

### Backlog lines (Fable's draft; append with the DECISIONS entry, after filling in a2's result)

- `[plan.3.verify.r1h.r0, source-toggle (1) first-chord miss on ubuntu]` — superseded by the `.g1` if it is planned. Otherwise: a1 and a2 at `9de2027` both failed `Cmd/Ctrl+/ never showed the source view focused`; the chord is bound only in the two editors, and (1) is the only chord after an unconfirmed `caretAtText` click. Hard stop: `4.verify`.
- `[plan.3.verify.r1h.r0, DECISIONS #039 — two corpus identity tests without headroom]` `sentences-zero-width.test.ts:247` runs under Vitest's default 5,000 ms.
  - ubuntu: 4,396 ms at `3.verify.g1h`, 4,573 ms at `3.verify.r1h` a1.
  - Windows: 4,359 ms and 5,493 ms (a1 timed out; recorded).
  - `rewrite.test.ts:143`, under 30,000 ms: ubuntu 19,102/20,380 ms; Windows 22,633/30,468 ms (a1 timed out).
  - Not 3.22's cost.
  - Revisit: taken as a test-only fix task appended by `3.7.r1d` before `3.verify.r2`.
  - Changes the decision: a timeout of either on ubuntu or macOS at any gate → a `.g<n>` with that scope.
  - Hard stop: `4.verify`.
- (note) `apply-move-block.test.ts` slowed after 3.22's `attach` per `carryTopLevelMove`: ubuntu 2,883 → 4,311 ms, macOS 1,780 → 2,157 ms. Green; for the r1 reviewers.

## Next Steps

1. Run `status` (expect `plan.3.verify.r1h.r1:pending`, `3.verify.r1h:blocked`), `doctor` (clean) and `git status --short` (empty, on `phase/3`). Give Michael the one-line state.
2. Brief Fable on `PLAN-GATE plan.3.verify.r1h.r1`, as a written brief. It covers:
   - both attempts' evidence (`a1/`, `a2/`);
   - the a1 Fable answer and its conditional `.g1` scope (Gotchas above);
   - the macOS `autosave.spec.ts:92` question, transient or 3.24, with the prior instances;
   - whether the #039 corpus tests join the `.g1` or stay in the backlog;
   - the answer format: decision, reasons, confidence, and the task text with acceptance sentences.
3. Plan: `ralph/ralph.sh plan plan.3.verify.r1h.r1`, write the planning commit in `.wt/plan.3.verify.r1h.r1`, and include the owed DECISIONS entry and the backlog lines. Then `ralph/ralph.sh sync-state` and `ralph/ralph.sh run --phase 3 --dry-run` (#051). Restart only when the dry run names the first fix task (or `3.verify.r1.g1`), then arm the watcher.
4. At `HUMAN_GATE 3.verify.r1.g1h`, run `scripts/gate.sh 3.verify.r1.g1h` in the background with output to a scratchpad file. On ACCEPT, record the run id and the per-OS counts (Vitest, cargo, e2e-shell; C16; macOS autosave:92). Then expect `3.7.r1a` (claude) and `3.7.r1b` (sol), then `PRINCIPAL 3.7.r1d`. That stop means rotating; a fresh session runs the reconciliation:
   - cherry-pick `phase/3..handoff/069`, or the newest unmerged handoff ref;
   - copy the reports to `docs/reviews/phase-3-r1-{claude,sol}.md`;
   - under #041 D1, an r1 blocker (C14 included) goes to Michael first.
5. Hand Michael `git push origin phase/3` when convenient (1 commit ahead now).

## Open Questions

- **Michael (Phase 3→4 boundary, carried from 067/068):**
  - Fable's both-legs rule for e2e/shell tasks.
  - Which re-pointed hard stops become tasks before `4.verify`: the coverage glob G7/U10/C12, `packages/modes` G1, and the typescript range U26/G6.
  - The #039 corpus-test pair, if it is not in the `.g1`.
- **Michael, if Fable calls macOS `autosave.spec.ts:92` transient:** it is the third macOS instance of this case across phases. Should it become a test-shape task (the wait polls for the sidecar under a block-local budget, never a fixed 600 ms pause) before `4.verify`?

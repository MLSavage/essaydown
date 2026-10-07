# Handoff 073: Phase 3, `3.verify.r3h` GATE-FAILED a1 → PLAN-GATE `plan.3.verify.r3h.r0`

Written 2026-10-07 by the principal, the Opus 5.5 session that continued from 072. It restarted the runner through `3.7.r2a/b`, ran the r2 reconciliation (`3.7.r2d`, FAIL on C15), restarted through `3.28` and `3.verify.r3`, and ran the `3.verify.r3h` gate (GATE-FAILED a1). It rotated at `ROTATE-PRINCIPAL` with context past ~150k. This handoff supersedes `072-phase-3-r2-gate-accepted-reviews-next.md`.

This commit is on `handoff/073`, cut from `phase/3` at `27c6c86`. Handoff 072 is already in `phase/3` (cherry-picked by `3.7.r2d` as part of `b800c5b`), so the next principal commit that integrates cherry-picks `phase/3..handoff/073` (one commit, `docs/handoffs/` only). Read this handoff with `git show handoff/073:docs/handoffs/073-phase-3-r3-gate-failed-plan-gate.md`. The next handoff is `074-*.md`.

## Current State

- **Branches.**
  - `phase/3` is at `27c6c86` `task(3.verify.r3)`. Origin is at `b56c23c`, so `phase/3` is 3 ahead (`b800c5b` 3.7.r2d, `8734038` 3.28, `27c6c86` 3.verify.r3). Michael has not pushed them yet; recount before handing him the push.
  - `main` is at `da7d07b`.
  - Handoff refs: `handoff/073` (this). `handoff/061`–`072` are stale (their content is in `phase/3`); delete them after `3.close`.
- **Status:** `Phase 3, idle; last passed 3.verify.r3; gates open: none; plan requests: plan.3.verify.r3h.r0:pending; blocked: 3.verify.r3h:blocked`. `doctor` is clean.
- **Passed since 072:**
  - `3.7.r2a` (claude) FAIL 1/0/0 and `3.7.r2b` (sol) PASS 0/0/0.
  - `3.7.r2d`: the r2 reconciliation, verdict FAIL on C15 (DECISIONS `#review-3-r2`), integrated as `b800c5b`.
  - `3.28`: opus, attempt 1, `success` in 23 turns. Its guards are green with 7259 tests; the mutation went red and was restored; the pandoc probe shows `<a href="https://a.b/x|y">` before and after. Note that save 1 pads the table's columns, so the guards' "byte-identical to the input" means identical to the padded canonical form. The cell bytes are unchanged and saves 1–3 are a fixed point. The r3 reconciliation should read it that way.
  - `3.verify.r3`: sonnet, attempt 1.
- **Gate `3.verify.r3h` a1: GATE-FAILED.** ci.yml run 37570770629, ref `ci/3.verify.r3/a1` at `27c6c86`; evidence in `.evidence/ci/3.verify.r3h/a1/`. Three failures:
  1. **ubuntu `test`:** `packages/core/test/rewrite.test.ts` `applyUseVariant > essay-fixture.md: the no-op variant re-serialises byte-identically (corpus identity)` ran 31093 ms against its 30_000 ms budget. At r2 it ran 23.6 s on ubuntu and 35.4 s on Windows. This fires the trigger of the backlog line `[review-3-r2, windows corpus identity over its budget]`. The ubuntu artifact has no `cargo-test.log`, because the job stopped at the failed step. macOS and Windows `test` passed 72/72 files.
  2. **ubuntu e2e-shell:** `produce.spec.ts` `typewriterScroll keeps the caret within ±40px of vertical centre across 30 typed lines`: `line 0 (…) never reached the editor`. 14/15 spec files passed.
  3. **macOS e2e-shell:** `autosave.spec.ts`, 5 cases failed. The first failure is an `ENOENT` on the `a.essaydown.json` sidecar in the temp workspace. 14/15 passed.
  - Windows e2e-shell passed 15/15.
  - The only product change since the r2 gate (ACCEPT, all 15 specs green on every OS) is 3.28's one-line `cutsCell` regex in `packages/core/src/format.ts`. Nothing in that change reaches typing or autosave, so the two e2e failures look transient or environmental. `autosave.spec.ts` also failed in the `3.verify.r1h` attempts that 3.25 repaired. The rewrite budget is the #039 class that 3.26 addressed.
- **Next tasks after the plan:** `3.verify.r3h` passes, then `3.7.r3a` (claude) and `3.7.r3b` (sol), then `PRINCIPAL 3.7.r3d`. `3.close` depends on `3.7.r3d`. `EXPECTED_COUNT` is 369.
- **Runner:** idle after `HUMAN_GATE 3.verify.r3h` and the gate's `ROTATE-PRINCIPAL`. Pane `essaydown:runner` (pid 8940) is at `zsh`, and `.locks/` is empty. runner.log has 265525 lines.
  - Restart: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 3 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher:** stopped at rotation. On restart, arm a persistent Monitor (30-minute cap) with `start=` set to `wc -l < .evidence/runner.log` + 1, read at restart:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=START; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  `START` is the number you compute. Write the digits in, never the word.
- **Expected next stop:** depends on the plan. After a same-SHA rerun ACCEPT, the next stop is `PRINCIPAL 3.7.r3d`. After a `.g1` repair, it is `HUMAN_GATE 3.verify.r3.g1h`.

## Corrections

- **`072`, Current State "Handoff refs: `handoff/072` (this)"** and next-prompt's "cherry-pick `phase/3..handoff/072`": both are stale. 072's content is in `phase/3` via `b800c5b`. A handoff cherry-picked into the phase branch does not pass `git merge-base --is-ancestor`, because the cherry-pick has a new SHA. When choosing the base for a new handoff ref, check whether the handoff file is already on the phase branch (`git show phase/3:docs/handoffs/<file>`). If it is, cut from `phase/3`.

## Decisions

- **DECISIONS `#review-3-r2`** (in `b800c5b`):
  - Verdict FAIL. Claude FAIL 1/0/0, Sol PASS 0/0/0. `WARN 3.7.r2b` is a mention: all 3 hits are the tasks.json acceptance string.
  - C15: 3.27's `cutsCell` re-escapes an already-escaped `\|` in a cell's link url, so a cell written by GitHub or Typora loses its link in other GFM readers. The principal reproduced it on the core route and read it with pandoc. Fable derived the predicate from the installed gfm-table tokenizer and prototyped it (846/846).
  - Michael asked for one confirmation before answering. The `<…>` twin and the editor's `\|` display predate Phase 3: the twin comes from task 1.50, it was already broken at `main`, and Phase 3's user path holds no table. With that confirmed, his answer (verbatim) was "1, after you confirm the twin isn't covered by the r1 PRINCIPAL.md rule (feature predates Phase 3)." Option 1 was "Fix as 3.28 + r3 (Recommended)".
  - The graph adds 3.28, `3.verify.r3` (+h) and `3.7.r3a/b/d`. `EXPECTED_COUNT` went 363 → 369.
  - Three backlog lines, each with hard stop `4.verify`: the `\|`-in-a-cell parse divergence (the twin plus the editor display, with Fable's parse-side fix shape); C2 + C13 re-pointed; the Windows corpus identity over its budget. Two lessons were recorded and none promoted.
- No runner deviation this block.

## Gotchas

- `scripts/gate.sh 3.verify.r3h`, backgrounded with its output in a scratchpad file, took about 35 minutes and printed nothing until the end. Progress is visible in `.evidence/ci/<gate>/a<n>/` and with `git ls-remote origin 'refs/heads/ci/3.verify.r3/*'`.
- A CI artifact without `cargo-test.log` means the job stopped at the failed `test` step. It is not a cargo failure.
- The host has no pandoc. Use `docker run --rm -i --entrypoint pandoc essaydown-dev:0.0 -f gfm -t html < file`.
- Never quote the literal promise in any file an agent reads.

## Next Steps

1. Run `status` (expect `plan requests: plan.3.verify.r3h.r0:pending`) and `doctor` (expect clean). Give Michael the one-line state and `git push origin phase/3` (3 ahead; recount first).
2. PLAN-GATE is on Fable's trigger list. Write Fable a brief:
   - the signal, `GATE-FAILED 3.verify.r3h a1` with `PLAN-GATE plan.3.verify.r3h.r0`;
   - the evidence paths above;
   - the three failures and the r2 timings;
   - the one question: is this a same-SHA rerun (`scripts/gate.sh rerun 3.verify.r3h`, transient failures only, RUNNER-SPEC §2, #023, #029), or a `.g1` test-only repair? A repair would be the rewrite.test.ts corpus identity's budget (the #039 class and the 3.26 pattern; the r2 backlog line's trigger fired), plus the two e2e specs only if their logs show a defect.
   Before deciding, read the two e2e logs' failure blocks and compare them with the r2 gate's accepted logs (`/logs/ci/3.verify.r2h/accepted/`, the same tree minus `cutsCell`). A failure over budget is not transient in the #023 sense when it is the second occurrence of a fired trigger; weigh that.
3. Answer the plan request through the plan protocol (`ralph/ralph.sh plan`, in `.wt/plan.3.verify.r3h.r0` on its `plan/…` branch; read RUNNER-SPEC's plan section and `ralph/lib/gate.mjs` for the allowed outcomes first). Cherry-pick `phase/3..handoff/073` into any principal commit that integrates. A plan the runner integrates syncs its own spec (`ralph/lib/run.mjs:250`); a `ralph/tasks.json` change made outside the runner needs `sync-state` and `--dry-run` first (#051).
4. Restart the runner and arm the watcher. At `PRINCIPAL 3.7.r3d`, a fresh session runs the reconciliation in `.wt/3.7.r3d`:
   - cherry-pick the newest unmerged handoff range;
   - copy the two reports to `docs/reviews/phase-3-r3-{claude,sol}.md`;
   - brief Fable (a written brief) on the verdict;
   - decide any WARN as read or mention;
   - write DECISIONS `#review-3-r3` and regenerate progress.md's current state;
   - commit as `wip(3.7.r3d)`, with the promise only in the message and its own `- [3.7.r3d] ` journal line (check the last byte first).
   - On PASS, `3.close` follows. On a blocker, it goes to Michael before any planning commit (#041 D1).
5. At the Phase 3→4 boundary, raise the Open Questions below.

## Open Questions

- **Michael (Phase 3→4 boundary, carried from 067–072):**
  - Fable's both-legs rule for e2e/shell tasks.
  - Which re-pointed hard stops become tasks before `4.verify`: the coverage glob G7/U10/C12, `packages/modes` G1, the typescript range U26/G6, and C2 + C13 (re-pointed at `#review-3-r2`).
  - Whether any line of 3.26's `[3.26, other single-it corpus sweeps on the default budget]` list should be taken before `4.verify`.
  - Whether r1's two riskiest things (the source-view burst during an awaited flush; the §6.2 occurrence-shift between duplicate sentences) become Phase 4 tasks or backlog lines.
  - New from r2: whether the `\|`-in-a-cell parse divergence (`[review-3-r2, a \`\|\` in a table cell's link url]`, the `<…>` twin's wrong href) becomes a task before `4.verify`.

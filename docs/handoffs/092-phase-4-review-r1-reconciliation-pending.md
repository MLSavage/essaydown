# Handoff 092: Phase 4, PRINCIPAL 4.5.r1d pending (review r1: Claude FAIL 1 blocker, Sol PASS)

Written 2026-10-10 by the principal (Opus 5.5) that continued from 091. Supersedes `091-phase-4-verify-r1h-gate-failed.md`. Committed on `handoff/092`, cut from `phase/4` at `3332d60`. Handoff 091's content (and DECISIONS #067) is already in `phase/4`, carried by the planning commit, so `phase/4..handoff/092` is this one commit. Read it with `git show handoff/092:docs/handoffs/092-phase-4-review-r1-reconciliation-pending.md`.

## Current State

- **Branches.**
  - `phase/4` is at `3332d60` (`task(4.verify.r1.g1)`). `origin/phase/4` is the same; Michael pushed it, and the count of unpushed commits is 0.
  - `main` is at `8aba511`.
- **Status at writing:** `Phase 4, 4.5.r1d principal-pending; last passed 4.5.r1b; gates open: none; plan requests: none; blocked: none`. `doctor` is clean, and the host checkout is clean.
- **Passed this block:**
  - The planning commit `plan.4.verify.r1h.r0`, integrated as `6dc15be` (DECISIONS #068).
  - 4.30 (`3431ecc`), 4.31 and 4.verify.r1.g1 (`3332d60`) each passed on attempt 1.
  - Gate `4.verify.r1.g1h` returned ACCEPT on a1, run `38046460346`.
  - `4.verify.r1h` is superseded.
- **Review r1** at implementation SHA `3332d60`. The reports are under `.evidence/reviews/4/r1/{claude,sol}/`.
  - **Claude (4.5.r1a):** FAIL, 1 blocker / 0 should-fix / 0 nits.
    - The blocker is at `apps/desktop/src/workspace/export-sync.ts:63`. U1's fix treats any `title` key as the document's own title. For `title:`, `title: ""` or `title: ~`, no `--metadata title=` is sent, and the EPUB fails epubcheck `RSC-005` (empty `dc:title`, empty nav heading) while the app reports the export as a success.
    - Claude reproduced it in the container and proposes a fix with guards.
  - **Sol (4.5.r1b):** PASS, 0/0/0.
- **Runner:** idle at `PRINCIPAL 4.5.r1d`. Its worktree is `.wt/4.5.r1d`, on `task/4.5.r1d`, at `3332d60` with no commits yet. Pane `essaydown:runner` (pid 8940) is at zsh. The restart command:
  ```
  tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 4 2>&1 | tee -a .evidence/runner.log' Enter
  ```
- **Watcher:** stopped at rotation. The raw count is 82; the last counted line is the `[ralph] 4.5.r1d: work in …` line. Re-arm it with the positional watcher, recounting `n` first:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=275135; n=K; W=/tmp/essaydown-watch.txt; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] " > "$W" 2>/dev/null; c=$(wc -l < "$W"); if [ "$c" -gt "$n" ]; then tail -n +"$((n+1))" "$W" | cut -c1-400; n=$c; fi; sleep 30; done
  ```
- **Expected next stop:** none until 4.5.r1d's commit. After that, either an r2 fix chain (if Michael takes the blocker), or `4.close`.

## Corrections

- **091, "Current State" and "Next Steps 1–4":** done. The gate repair passed and the r1 reviews ran.
- **091 and `next-prompt.md` on `handoff/091`:** each says "`origin/phase/4` is 7 behind". It is now 0.
- **091:** names `handoff/091` as the range to cherry-pick. Its content is already in `phase/4`; cherry-pick `handoff/092` only.

## Decisions

- **DECISIONS #068**, in `phase/4` via `6dc15be`, records the gate repair:
  - 4.30 split the corpus legs of `anchor-typing.test.ts` and `anchor-source-typing.test.ts` into one test per (fixture, block), each under 30 s. 4.30's scope included `anchor-typing.test.ts` although it did not fail, because it carried the same `120_000` literal (#039). This was a principal call, recorded in #068.
  - 4.31 set `LANG: en_US.UTF-8` on CI's Linux e2e-shell step, applying #065 as Michael answered it; no product change.
  - The new verifier is `4.verify.r1.g1`, and `4.5.r1a/b` were rewired to depend on it.
  - `EXPECTED_COUNT` is 418.
  - Fable was consulted under PLAN-GATE.
- **`[autosave]` readings (#066), gate `4.verify.r1.g1h` a1:** 500, 527 and 551 ms, each ×2. All are inside the window.
- **Runner deviations:** none. The plan request was integrated by the runner itself (`run.mjs:250`), so the dry run named the plan request, not 4.30. That is expected.

## Gotchas

- **WARN at 4.5.r1b:** "transcript names a sibling's report of this attempt (claude ×1)". The quoted context is the task text's own rule (`… read no sibling directory of this attempt`), echoed back. The reconciliation decides read or mention (#025, #044); check Sol's transcript before you count it as a read.
- **Claude's blocker is in U1's class** (r0's EPUB title fix, 4.24). Under #041 D1, a blocker found in a late review attempt is Michael's before any fix chain. Do not plan r2 rows until he answers.
- **Claude's blocker is a product change.** It touches `export-sync.ts` and adds guards plus an integration leg. If Michael takes it, the chain is fix → `4.verify.r2` (needsCI) → gate → `4.5.r2a/b/d` (no Grok, #043), and `4.close` is rewired to `4.5.r2d`.
- **Lesson candidate from #068:** a corpus leg is one `it` per block under the family's `30_000`. A `120_000` literal is the #039 class. This is for the promote-lessons step.

## Next Steps

1. Run `status` and `doctor`. If the count of unpushed commits on `phase/4` is not 0, hand Michael `git push origin phase/4`.
2. **Reconciliation `PRINCIPAL 4.5.r1d`**, in `.wt/4.5.r1d`:
   - First `git cherry-pick handoff/092`.
   - Write a Fable brief on the r1 reports (`.evidence/reviews/4/r1/{claude,sol}/report.md`). The question: is Claude's finding a blocker under #041 D1, and what is the fix scope?
   - Put the blocker to Michael (#041 D1) with Fable's recommendation, before any fix chain.
   - Then write `#review-4-r1` in DECISIONS.md, the PRD §8 and `tasks.json` rows if a fix is taken (r2 rows `a`, `b`, `d`, with the reviewers depending on the new producer), and `EXPECTED_COUNT`.
   - The commit appends its own `- [4.5.r1d] ` journal line, and carries the promise only in the `wip(4.5.r1d)` commit message.
3. Restart the runner. If a fix chain was planned, arm the positional watcher; otherwise `4.close` runs next.

## Open Questions

- **For Michael:** does Claude's r1 blocker (an EPUB with an empty or null front-matter `title`, invalid and reported as exported) become an r2 fix chain? Sol passed with 0 findings.

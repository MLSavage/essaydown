# Handoff 095: Phase 4, review r2 reconciled, 4.33 passed, 4.verify.r3h GATE-FAILED (PLAN-GATE)

Written 2026-10-11 by the principal (Opus 5.5) that continued from 094. Supersedes `094-phase-4-review-r2-reconciliation-pending.md`. Committed on `handoff/095`, cut from `phase/4` at `7f0313c` (handoffs 093 and 094 are in `phase/4` through `task(4.5.r2d)`, so nothing is stacked under this one). Read it with `git show handoff/095:docs/handoffs/095-phase-4-verify-r3h-gate-failed.md`.

## Current State

- **Branches.**
  - `phase/4` is at `7f0313c` (`task(4.verify.r3)`), above `9c4648c` (`task(4.33)`) and `418ed79` (`task(4.5.r2d)`).
  - `origin/phase/4` is 2 behind (`418ed79` pushed by Michael; 4.33 and 4.verify.r3 not yet). Michael: `git push origin phase/4`.
  - `main` is at `8aba511`.
- **Status at writing:** `Phase 4, idle; last passed 4.verify.r3; gates open: none; plan requests: plan.4.verify.r3h.r0:pending; blocked: 4.verify.r3h:blocked`. `doctor` is clean; the host checkout is clean.
- **Passed this block:** `4.5.r2d` (this principal's reconciliation, FAIL, `#review-4-r2`), `4.33` (attempt 1), `4.verify.r3` (attempt 1).
- **Gate:** `scripts/gate.sh 4.verify.r3h` printed `GATE-FAILED 4.verify.r3h a1: workflow ci.yml concluded failure`, `PLAN-GATE plan.4.verify.r3h.r0`, `ROTATE-PRINCIPAL`. Run 38110743562 at `7f0313c`, ref `ci/4.verify.r3/a1`, evidence `.evidence/ci/4.verify.r3h/a1/` (`workflow.log`, `e2e-shell/`, `test-logs/`, …).
- **Runner:** idle, pane `essaydown:runner` (pid 8940) at zsh. Restart it only after the planning commit for `plan.4.verify.r3h.r0` is on its `plan/4.verify.r3h/r0` branch (see Next Steps); the run integrates it:
  ```
  tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 4 2>&1 | tee -a .evidence/runner.log' Enter
  ```
- **Watcher:** stopped (expired, not re-armed while the runner is idle). Raw count 93; the last counted line is `HUMAN_GATE 4.verify.r3h`. Re-arm after the restart, recounting `n` first:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=275135; n=K; W=/tmp/essaydown-watch.txt; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] " > "$W" 2>/dev/null; c=$(wc -l < "$W"); if [ "$c" -gt "$n" ]; then tail -n +"$((n+1))" "$W" | cut -c1-400; n=$c; fi; sleep 30; done
  ```
- **Expected next stop:** after the repair chain (`4.verify.r3.g1` → `4.verify.r3.g1h`), the reviewers `4.5.r3a/b` run, then `PRINCIPAL 4.5.r3d` → rotate; a fresh session reconciles it.

## Corrections

- **094, "Current State":** the reconciliation is done (`418ed79`), and `origin/phase/4` is no longer 0 behind (2 behind at writing).
- **094, "Expected next stop":** r2 did not pass; Michael took the fix, so the chain 4.33 → 4.verify.r3 (+h) → 4.5.r3a/b/d runs, and `4.close` depends on `4.5.r3d`.
- **`next-prompt.md` on `handoff/094`:** its job list is for the r2 reconciliation; superseded by this block's `next-prompt.md`.

## Decisions

- **`#review-4-r2`** (in `phase/4` via `418ed79`): verdict FAIL. Claude 1/0/0, Sol 0/0/0 (after the single-reviewer retry); 1 raw, 1 unique. Both #044 WARNs judged mentions (Claude's one `ls` of Sol's directory listed only Sol's aborted a1 `transcript.log`, disclosed).
  - The principal's container probe (`essaydown-dev:0.0`, pandoc 3.11, product argv, epubcheck) observed the blocker: `title:`, `""`, `~` beside `tags:`/`- essay`, and `"title":`, with no title token → empty `dc:title`, RSC-005, rc 0.
  - Michael's answer (verbatim): "Take the fix. Keep readFrontMatter limited to the title line's own value and quoted keys; no general YAML parsing in core."
  - 4.33 rows, `4.close` → `4.5.r3d`, `EXPECTED_COUNT` 424 → 430. Two backlog lines: `[review-4-r2, pandoc-unparseable block]`, `[review-4-r2, empty block-scalar title]`.
- **Runner deviations: none.**

## Gotchas

- **The ubuntu failure, read by this principal (not yet Fable).** Jobs: every job green except `e2e-shell (ubuntu-latest)` and `test (windows-latest)`.
  - `e2e/shell/test/autosave.spec.ts`: 4 failing, 15/16 specs. Case 1 (`an externally written sidecar survives the next autosave (DECISIONS #review-2-r0 U5)`) read `'HelloX\n'` at `:201`, where `'HelloXV\n'` was expected, right after `typeText(EDITOR, "V")` and `browser.pause(600)` (:196–:197).
  - Cases 2–4 read `'HelloXV…'` where `'HelloXVU…'` was expected. So the `V` **was typed and reached disk after the pause**, and case 1's `U` was never typed. That is the cascade of one late save, not lost text.
  - **Reading:** the debounce-margin signature (#066: 500 ms `saveDelayMs` + `write_doc` vs. a 600 ms pause), on **ubuntu** this time and at **:201**, a case 4.22 did not convert. 4.22 replaced only case 1's (:153) pause with the `editOnDisk` poll under a 3000 ms bound. It is **not** the `[plan.4.2.g1h.r0, … lost-pending-edit class]` signature (there the typed letter was absent altogether). Confirm this against `[4.22, autosave :153 at 600 ms on macOS, fourth instance …]` (docs/V1.1-BACKLOG.md:211), whose trigger may name this case.
  - **The `[autosave]` readings (#066):** `X: on disk after 500 ms`, `526 ms`, `531 ms` (each ×2 across the artifacts). They are under 600 but show a margin of about 70–100 ms.
  - `git log 2e4248a..7f0313c -- e2e/shell apps/desktop/src` should be empty (4.33 touched only core's sidecar.ts and tests). Verify it; then the save path is the one that ran green at 4.verify.r2h.
- **Windows (recorded, not gated, #047):** `packages/core/test/sentences-zero-width.test.ts:268` (`corpus-wide identity invariant … essay-fixture.md: an identity reorder and a self-replacement …`) timed out at the 5000 ms default; 1 failed / 8928. It is not this gate's cause. Mention it in the brief; check whether a backlog line already covers the Windows timeouts (#review-4-r2 recorded the r2 integration.test.ts EPUB timeout under #047).
- **A same-SHA rerun is only for a transient failure** (RUNNER-SPEC §2, #023, #029). #066 judged the same signature on macOS a `.g` repair, not a rerun, because there was a change to make. Expect the same here unless the 4.22 backlog line says otherwise.
- **Michael travels the week after 2026-10-10, and the Mini is powered off for the trip.** Never power off mid-gate. Rotate at an idle stop with the exact restart point.

## Next Steps

1. Run `status` and `doctor`. Check the unpushed count and hand Michael `git push origin phase/4` if it is not 0.
2. **PLAN-GATE `plan.4.verify.r3h.r0`:**
   - Write a Fable brief on `.evidence/ci/4.verify.r3h/a1/` and the Gotchas above. The one question: is this #066's debounce-margin class at a new case (`:201`, ubuntu), and what is the minimal `.g1` repair? The expected answer is test-only: the `editOnDisk` poll on every remaining 600 ms pause-then-read in autosave.spec.ts, or at least :197/:208, both container legs (#059).
   - If the brief confirms test-only and inside an existing backlog trigger, no Michael ask is needed (#066 was test-only by his answer: "the 600 ms … is a test budget, not a user-facing guarantee"). If it reads as lost text, the decision is Michael's (#041 D1).
   - Run `ralph/ralph.sh plan` for the request; the planning commit goes on `plan/4.verify.r3h/r0` in `.wt/plan.4.verify.r3h.r0`. It carries the DECISIONS entry, the repair row(s) `4.34` + `4.verify.r3.g1` (+h), and the rewire of `4.5.r3a/b` onto `4.verify.r3.g1` (the producer, not the gate id — memory "reviewer rows depend on the producer"). Assert deps in the generated tasks.json; `EXPECTED_COUNT`; the promise only in the `wip(plan.…)` message. Read handoff 091 and #066/#068 for the exact shape.
   - `sync-state` is done by the runner on integrating a plan request (`run.mjs:250`). Restart, then re-arm the watcher.
3. Handle each stop signal per `next-prompt.md`. At `PRINCIPAL 4.5.r3d`, rotate.

## Open Questions

- For Fable, then possibly Michael: is `:201` covered by an existing backlog trigger (4.22's line), and does the repair convert every remaining `browser.pause(600)` read in autosave.spec.ts, or only the failing ones (#021: scope to what failed and file the rest)?
- At the Phase 4 → 6 boundary: the `[review-4-r0, dispositions]` items with that trigger (G4–G12).

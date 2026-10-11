# Handoff 093: Phase 4, 4.verify.r2h ACCEPT, review r2 next (runner idle at the gate)

Written 2026-10-10 by the principal (Opus 5.5) that continued from 092. Supersedes `092-phase-4-review-r1-reconciliation-pending.md`. Committed on `handoff/093`, cut from `phase/4` at `2e4248a`. Handoff 092's content is already in `phase/4` (carried by `task(4.5.r1d)`), so `phase/4..handoff/093` is this one commit. Read it with `git show handoff/093:docs/handoffs/093-phase-4-verify-r2h-accepted-review-r2-next.md`.

## Current State

- **Branches.**
  - `phase/4` is at `2e4248a` (`task(4.verify.r2)`). `origin/phase/4` is **3 behind** (`git rev-list --count origin/phase/4..phase/4` = 3 at writing: `df139a6` 4.5.r1d, `3a302d0` 4.32, `2e4248a` 4.verify.r2). Michael pushes: `git push origin phase/4`.
  - `main` is at `8aba511`.
- **Status at writing:** `Phase 4, idle; last passed 4.verify.r2h; gates open: none; plan requests: none; blocked: none`. `doctor` is clean, and the host checkout is clean.
- **Passed this block (each on attempt 1):**
  - `4.5.r1d` (reconciliation, verdict FAIL, DECISIONS `#review-4-r1`), integrated as `df139a6`.
  - `4.32` (the pandoc-readable title predicate), `3a302d0`.
  - `4.verify.r2`, `2e4248a`.
  - Gate `4.verify.r2h` ACCEPT a1, run `38052929350`.
- **Runner:** idle after the gate. `gate.sh` printed `ROTATE-PRINCIPAL` (PRINCIPAL.md:34), so this session rotated without restarting it. Pane `essaydown:runner` (pid 8940) is at zsh. Restart:
  ```
  tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 4 2>&1 | tee -a .evidence/runner.log' Enter
  ```
  The next tasks are `4.5.r2a` (Claude) and `4.5.r2b` (Sol), then `PRINCIPAL 4.5.r2d`.
- **Watcher:** stopped at rotation. The raw count is 85; the last counted line is `HUMAN_GATE 4.verify.r2h`. Re-arm after the restart, recounting `n` first:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=275135; n=K; W=/tmp/essaydown-watch.txt; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] " > "$W" 2>/dev/null; c=$(wc -l < "$W"); if [ "$c" -gt "$n" ]; then tail -n +"$((n+1))" "$W" | cut -c1-400; n=$c; fi; sleep 30; done
  ```
- **Expected next stop:** `PRINCIPAL 4.5.r2d` (possibly a `WARN 4.5.r2b` sibling-mention line before it). Then rotate; a fresh session reconciles.

## Corrections

- **092, "Current State" and "Next Steps 1–3":** done. r1 was reconciled, the fix chain was planned and has passed, and the gate accepted.
- **092 and `next-prompt.md` on `handoff/092`:** "`origin/phase/4` = `3332d60`, 0 behind" — it is now 3 behind.
- **092, "Expected next stop":** superseded by the r2 chain; `4.close` now depends on `4.5.r2d`.

## Decisions

- **DECISIONS `#review-4-r1`** (in `phase/4` via `df139a6`): verdict FAIL.
  - Claude 1/0/0, Sol 0/0/0. The `WARN 4.5.r1b` was a mention, not a read (the tasks.json acceptance string, echoed).
  - Michael took the blocker (verbatim: "Option 1, take the fix. 4.32 → 4.verify.r2 → 4.5.r2a/b/d, 4.close after 4.5.r2d.").
  - The principal's container probe (pandoc 3.11 + epubcheck, 16 spellings) is recorded there. It corrected Fable's table: a clipped or kept block-scalar title (`|` or `>`) still fails RSC-005 on the title page.
  - Michael backlogged that member: `[review-4-r1, block-scalar title]`. His trigger, whichever first: the first block-scalar reader under PRD §6.1, any user report, or before export is declared done / the first public release. Confirmed in the tree: the app never writes `title`, and `writeFrontMatter` never writes a block scalar.
  - Also backlogged: `[review-4-r1, CI export-validation argv drift]`.
  - The rows added: 4.32, 4.verify.r2 (+h), 4.5.r2a/b/d. `4.close` was rewired to `4.5.r2d`. `EXPECTED_COUNT` is 424.
- **`[autosave]` readings (#066), gate `4.verify.r2h` a1:** 501, 527 and 533 ms, each ×2. All are inside the window.
- **Runner deviations:** none.

## Gotchas

- **Michael travels the week after 2026-10-10, and the Mini is powered off for the trip.** When he says he is about to power off, let any in-flight task or gate finish (never power off mid-gate), then rotate at an idle stop signal with the exact restart point in the handoff.
- **r2 scope is blocker-only** (4.5.r2a/b text). Each reviewer re-runs one bounded probe over `title:`, `""` and `~`. A finding on a backlogged item counts only if its premise is false, so a reviewer reporting the `|` block-scalar title is reporting a recorded disposition.
- **A blocker in r2 is Michael's before any fix chain** (#041 D1, 4.5.r2d's own text).
- **The stack for the 4.5.r2d reconciliation** is `handoff/093` (plus any later `handoff/NNN`): cherry-pick it first.

## Next Steps

1. Run `status` and `doctor`. Give Michael `git push origin phase/4` if the unpushed count is not 0 (3 at writing).
2. Restart the runner (the command above). Arm the watcher with `n` recounted, as a persistent Monitor (30-minute cap). On every expiry, re-arm it, run `status`, and run a catch-up grep.
3. Handle stop signals as PRINCIPAL.md says. A reviewer `NO-JOURNAL` or `STUCK` is a single-reviewer `retry` after moving its logs aside (#043). A Grok 402 cannot occur (no Grok in r2).
4. At `PRINCIPAL 4.5.r2d`: rotate. A fresh session reconciles in `.wt/4.5.r2d`: cherry-pick the handoff stack, write a Fable brief, take any blocker to Michael, then commit `#review-4-r2` with its own journal line.

## Open Questions

- None for Michael now. At the Phase 4 → 6 boundary: the `[review-4-r0, dispositions]` items with that trigger (G4–G12).

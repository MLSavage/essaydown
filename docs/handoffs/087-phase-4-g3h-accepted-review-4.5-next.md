# Handoff 087: Phase 4, 4.verify.g3h ACCEPT → review set 4.5 r0 next

Written 2026-10-09 by the principal (Opus 5.5) that continued from 086. This handoff supersedes `086-phase-4-4.verify.g2h-gate-failed-plan-gate.md`.

It is committed on `handoff/087`, based on `phase/4` `af5daa8`. Read it with `git show handoff/087:docs/handoffs/087-phase-4-g3h-accepted-review-4.5-next.md`. Handoffs 084–086 are already in `phase/4`: plan requests carried them. `phase/4..handoff/087` is the one range to cherry-pick: one commit, docs/handoffs only. Delete `handoff/077`–`087` after `4.close`.

## Current State

- **Branches.**
  - `main` is at `8aba511`.
  - `phase/4` is at `af5daa8` (`task(4.verify.g3)`), and `origin/phase/4` matches it (Michael pushed).
  - Since `4d402c4`, `phase/4` has gained:
    - `7b9b9b7`, the integrated plan request `plan.4.verify.g2h.r0` (DECISIONS #066, carrying handoff 086);
    - `8fb40ff` `task(4.22)`;
    - `af5daa8` `task(4.verify.g3)`.
- **Status at writing:**
  - `status`: `Phase 4, idle; last passed 4.verify.g3h; gates open: none; plan requests: none; blocked: none`.
  - `doctor` is clean. The host checkout is clean.
- **This block:**
  - Michael chose option (B) on the fired autosave trigger (#066).
  - 4.22 and 4.verify.g3 each passed on attempt 1. 4.22's journal quotes both container legs at 9 passing, 0 failing.
  - `scripts/gate.sh 4.verify.g3h` returned `ACCEPT 4.verify.g3h a1 run 37894168765`, then `ROTATE-PRINCIPAL`. Evidence is in `.evidence/ci/4.verify.g3h/a1/` (and `accepted/`).
  - e2e-shell Spec Files were 15/15 on ubuntu, macOS and Windows.
  - The recorded readings `[autosave] X: on disk after <n> ms` were: macOS 528, ubuntu 501, windows 536. These readings belong to #066 and are read at `4.5.r0d`.
- **Runner:** idle, and its loop exited. Pane `essaydown:runner` (pid 8940) is at `zsh`, there is no `ralph run` process, and `.locks/` is empty.
  - `ralph/ralph.sh run --phase 4 --dry-run` names `next: 4.5.r0a (reviewer, claude-opus) … from phase/4`.
  - Restart it with:
  ```
  tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 4 2>&1 | tee -a .evidence/runner.log' Enter
  ```
- **Review set 4.5** (read from `ralph/tasks.json`):
  - `4.5.r0a` (claude-opus), `4.5.r0b` (sol) and `4.5.r0c` (grok) each depend on `4.verify.g3h`. They read `/logs/ci/4.verify.g3h/accepted/`.
  - `4.5.r0d` (interactive-principal) depends on all three.
  - `4.close` depends on `4.5.r0d`.
- **Watcher:** stopped at rotation. Re-arm it with `start=275135` and `NR<=k`, where `k` is the RAW grep count at arm time. It was 55 at writing, with the last counted line `HUMAN_GATE 4.verify.g3h`; recount it.
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=275135; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk 'NR<=k { seen[$0]=1 } !seen[$0]++ { print; fflush() }'
  ```
  Replace `k` with the number before arming.
- **Expected next stop:** `PRINCIPAL 4.5.r0d`, after the three reviewers. A reviewer's `USAGE-LIMIT` or a Grok 402 may come first (PRINCIPAL.md "Reviewers").

## Corrections

- **086, "Expected next stop: … either a same-SHA rerun … or the plan request → `.g3` repair tasks → `4.verify.g3h`":** it was the `.g3`, and it is accepted.
- **086 and next-prompt.md on `handoff/086`, "`phase/4..handoff/086` is the one range to cherry-pick":** `7b9b9b7` carried it, so there is nothing left to cherry-pick from 086.
- **086, "the a1 gate run … autosave.spec 9/9 on macOS at 4.verifyh a1 and 3.verify.r3.g2h a1":** this is true but incomplete. The case had failed at 4 of 22 macOS attempts that carry it (2.verifyh a1, 2.verify.g2h a1, 3.verify.r3h a1, 4.verify.g2h a1), which fired the backlog trigger `V1.1-BACKLOG.md:195`.

## Decisions

- **DECISIONS #066** (in `phase/4` via `7b9b9b7`):
  - Michael's answer, option (B): PRD 2.5's product requirement is "debounce 500 ms", and its acceptance's "wait 600 ms" was a test budget.
  - The 600 ms check is split. `tests/document-sync.test.ts:120` owns the 500 ms debounce. The e2e asserts the exact bytes within the spec's 3000 ms bound and records its latency without asserting it.
  - It names #047 Decision 2 as why a macOS miss fails a gate.
  - The graph is 4.22 → 4.verify.g3 → 4.verify.g3h, with 4.5 rewired to `4.verify.g3`, and `EXPECTED_COUNT` 402.
- **Backlog:** 4.22 appended `[4.22, autosave :153 at 600 ms on macOS, fourth instance …]`. It closes `:195` and lists the four sibling `pause(600)` sites (`:181`, `:191`, `:253`, `:297`). Trigger: a failing assertion at one of those sites on any OS. That site alone then takes `editOnDisk` plus a sidecar poll in the next `.g<n>`.
- **Runner deviations:** none.

## Gotchas

- **At `4.5.r0d`, read the `[autosave]` readings.** Do this for every accepted gate's three OS logs (#066). A green macOS reading above 600 ms is the evidence for a `saveDelayMs` product change, and that change is Michael's call under #041 D1. At g3h every reading was under 600 ms.
- **A fresh session runs the reconciliation.** It first cherry-picks `phase/4..handoff/087` (or the newest stacked handoff not yet in `phase/4`) into `.wt/4.5.r0d`. The reconciliation's commit appends its own `- [4.5.r0d] ` journal line in the same commit, or the runner stops `NO-JOURNAL`.
- **Fable is a trigger at `N.10.r*d` reconciliations.** Write the brief.
- **`4.verify.g2h`** is superseded by `4.verify.g3h`. `.evidence/ci/4.verify.g2h/` holds a1, rejected.
- **Grok reviews `r0` only.** Any r1+ rows a planning commit writes are `a`, `b`, `d` (#043).

## Next Steps

1. Run `status` (expect `idle; last passed 4.verify.g3h`) and `doctor` (clean). Give Michael the one-line state.
2. Restart the runner with the command above, and confirm a `[ralph] 4.5.r0a` line.
3. Re-arm the watcher (`start=275135`, recount `k`, a 30-minute persistent Monitor; on each expiry, re-arm it, run `status` and a catch-up grep).
4. Handle reviewer signals: `USAGE-LIMIT` and Grok 402 per PRINCIPAL.md "Reviewers"; for a `WARN … sibling's report`, read the excerpts at reconciliation.
5. At `PRINCIPAL 4.5.r0d`, rotate. A fresh session runs the reconciliation (cherry-pick the handoff range first; Fable brief; #041 D1 stop rule).

## Open Questions

- **For Michael:** nothing pending. `phase/4` is pushed (`af5daa8`).

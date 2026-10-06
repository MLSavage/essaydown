# Handoff 067: Phase 3, fix chain r1 done → `HUMAN_GATE 3.verify.r1h`

Written 2026-10-06 by the principal, the Opus 5.5 session that continued from 066. That session ran the `3.7.r0d` reconciliation (verdict FAIL, DECISIONS #review-3-r0), restarted the runner, and watched 3.22, 3.23, 3.24 and 3.verify.r1 pass on their first attempts. It rotated at `HUMAN_GATE 3.verify.r1h` + `ROTATE-PRINCIPAL` (runner.log lines 251697–251698) without running the gate, because context had passed 150k. This handoff supersedes `066-phase-3-review-r0-reconciliation-pending.md`.

This commit is on `handoff/067`, cut from `phase/3` at `9de2027`. The stack 061–066 is already in `phase/3`: the reconciliation cherry-picked it, and the runner integrated it as `e21d6f8`. Read this handoff with `git show handoff/067:docs/handoffs/067-phase-3-verify-r1-gate.md`. The next handoff is `068-*.md`.

## Current State

- **Branches.**
  - `phase/3` is at `9de2027` `task(3.verify.r1)`, 1 commit ahead of origin. Michael pushed through `974febe`.
  - `main` is at `da7d07b`.
  - `handoff/067` (this commit) is the only unmerged handoff ref. `handoff/061`–`handoff/066` are integrated by cherry-pick, so their refs are stale; delete them after `3.close`.
  - Kept as evidence: `abandoned/3.6`, `abandoned/3.10`, `abandoned/3.13`, `attic/3.1-pre051`.
- **Status:** `Phase 3, 3.verify.r1h human-pending; last passed 3.verify.r1; gates open: 3.verify.r1h; plan requests: none; blocked: none`. `doctor` is clean. `EXPECTED_COUNT` is 353.
- **Passed this block** (attempt 1 each):

  | task | what it fixed | integrated as |
  |---|---|---|
  | 3.7.r0d | reconciliation | `e21d6f8` |
  | 3.22 | S2: sidecar re-anchor after typing | `05a63bd` |
  | 3.23 | C1/C6: Shift+Enter at inline code; link at a code span | `1a468d2` |
  | 3.24 | S1/S3: source window vs watcher; sidecar skip resolves saved | `974febe` |
  | 3.verify.r1 | verification for r1 | `9de2027` |
- **Runner:** stopped at the gate. Pane `essaydown:runner` (pid 8940) is at `zsh`, no `ralph run` process, and `.locks/` is empty. Restart with `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 3 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher:** stopped at rotation. After the restart, arm it as a persistent Monitor (30-minute cap) with `start=` set to `wc -l < .evidence/runner.log` + 1, read at restart time:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=START; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  `START` is the number you compute; write the digits in, never the word. On every expiry, re-arm it with each already-reported line in a `grep -v -F -e …` list, then run `status` and a catch-up grep from the same start. Never add a free-text term to its filter.
- **Expected next stop signal:**
  - On ACCEPT: the restart runs `3.7.r1a` (claude-opus) and `3.7.r1b` (sol) in parallel, then `PRINCIPAL 3.7.r1d`. Possible earlier signals: `USAGE-LIMIT` for a reviewer, or `WARN` (#044).
  - On failure: `GATE-FAILED` → `PLAN-GATE`.

## Corrections

- `066` Current State, "`phase/3` … 6 commits ahead of origin": Michael pushed twice. Origin is at `974febe`, and `phase/3` is 1 ahead.
- `066` Next Steps, the expected stop after the reconciliation: the reconciliation filed fix tasks, so the next stop was `HUMAN_GATE 3.verify.r1h`, not `3.close`.
- `next-prompt.md` (066's version), "cherry-pick `phase/3..handoff/066`": done. The next reconciliation cherry-picks `phase/3..handoff/067`, or whatever the newest unmerged handoff ref is then.

## Decisions

- **DECISIONS #review-3-r0** (in `phase/3` via `e21d6f8`).
  - **Verdict FAIL.** 38 raw findings came to 34 unique, 4 of them shared, with no severity disagreement on a shared finding. Five blockers: S1, S2, S3, C1, C6.
  - **Michael's answers:**
    - "Approve F1–F3 (Recommended)", which became 3.22–3.24.
    - A backlog line for a "discard sidecar and switch" escape hatch.
    - C14 (a URL containing `|` typed in a table cell) is re-run once by 3.7.r1a.
    - "Backlog both" for the undo keys: `undo-keys.ts:18` fix 2 and the Outline undo-keys gap (C10 = S5).
    - "Record, don't promote" for the r0 lessons.
  - **One Fable brief** on the D1 triage. Fable's proposed `hard_break` `NodeSpec.marks` fix was not adopted: a node spec's `marks` restricts its content, not the leaf itself.
- **Backlog lines appended:**
  - `[review-3-r0, dispositions]`
  - `[review-3-r0, undo keys outside the editor]`
  - `[review-3-r0, discard sidecar and switch — Michael]`
  - `[review-3-r0, 3.verify hard stops re-pointed]`: these now point to the Phase 3→4 boundary planning, with hard stop `4.verify`.
- **WARN 3.7.r0c** was ruled a mention: every hit was tasks.json row text, and the only `3/r0` access was a names-only listing taken while the sibling folders held only transcripts.
- No runner deviation this block.

## Gotchas

- **Run the gate in the background.** `scripts/gate.sh 3.verify.r1h` outruns the 120 s foreground limit. Use Bash `run_in_background` and redirect its output to a scratchpad file, then read that file. Don't start it at the very end of a session: a background process may die with the session.
- **On ACCEPT, record the evidence:** the run id, the per-OS Vitest/cargo/e2e-shell counts from the accepted logs, and whether Windows `autosave.spec.ts:192` fails again (C16, recorded under #047, not required).
- **r1 is blockers-only (D1).** A blocker reported in r1 goes to Michael before any planning commit, and 3.7.r1d stays principal-pending until he answers (3.7.r1d's own text). C14 is the one new probe allowed in r1: if Claude reports a split table row, that is such a blocker.
- **The r1 reconciliation copies two reports**, `phase-3-r1-{claude,sol}.md`, and its journal line goes in the same commit (`run.mjs:226`).
- **Never quote the literal promise** in any file an agent reads.

## Next Steps

1. Run `status` (expect `3.verify.r1h` human-pending), `doctor` (clean) and `git status --short` (empty, on `phase/3`). Give Michael the one-line state.
2. Run `scripts/gate.sh 3.verify.r1h` in the background, with output redirected to a scratchpad file. Wait with a backgrounded `until` loop on the run's completion, and read the file.
   - **ACCEPT:** record the counts (Gotchas), restart the runner, and arm the watcher at `wc -l` + 1. Expect 3.7.r1a/b.
   - **GATE-FAILED:** rotate first. Then the next session briefs Fable (`PLAN-GATE`), plans via `ralph/ralph.sh plan`, and scopes the repair to what failed.
   - **Transient** (infrastructure, not code): a same-SHA rerun per RUNNER-SPEC §2. Any tree change is a `.g<n>` repair.
3. At `PRINCIPAL 3.7.r1d`, rotate. The fresh session runs the reconciliation in `.wt/3.7.r1d`:
   - cherry-pick `phase/3..handoff/067` (or the newest handoff ref);
   - read the two reports;
   - brief Fable on the verdict;
   - a blocker goes to Michael first; PASS leads to `3.close`.
4. Hand Michael `git push origin phase/3` when convenient (1 commit ahead now).

## Open Questions

- **Michael (Phase 3→4 boundary):**
  - Fable's both-legs rule for e2e/shell tasks (handoff 065).
  - Which re-pointed hard stops become tasks before `4.verify`. This includes the coverage glob, now on its third fired hard stop (G7/U10/C12), `packages/modes` (G1) and the typescript range (U26/G6).

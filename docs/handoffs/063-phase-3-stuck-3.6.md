# Handoff 063: Phase 3 running, `STUCK 3.6` (no journal entry), source-toggle gap open with Michael

Written 2026-10-05 by the principal, the Opus 5.5 session that continued from 062. That session resolved `STUCK 3.13` (#053), restarted the runner, and watched 3.18, 3.14, 3.15, 3.16, 3.1–3.5 pass and 3.6 stop. This handoff supersedes `062-phase-3-stuck-3.13.md`.

This commit is on `handoff/063`, stacked on `handoff/062` → `handoff/061` (neither is in `phase/3`; no DECISIONS.md tail on the stack), from a temporary worktree. Read it with `git show handoff/063:docs/handoffs/063-phase-3-stuck-3.6.md`. The next handoff is `064-*.md`.

## Current State

- **Branches.**
  - `phase/3` is at `c8911d3` `task(3.5)`. Origin `phase/3` is at `c20260c` `task(3.3)` (Michael pushed this session), so 3.4 and 3.5 are not pushed (2 commits).
  - `main` is at `da7d07b`.
  - `handoff/061` → `handoff/062` → `handoff/063` (this commit) is the stack the `3.7.r0d` reconciliation cherry-picks.
  - Kept as evidence: `abandoned/3.10` (`89ad5f5`, #052), `abandoned/3.13` (`b1c2e19`, #053), `attic/3.1-pre051`.
- **Status:** `Phase 3, idle; last passed 3.5; gates open: none; plan requests: none; blocked: 3.6:blocked`. `doctor` is clean. The host checkout is clean on `phase/3`.
- **Tasks this block (attempts):** 3.18 a1 (`3225e9b`); 3.14 a2 (a1 capped, sound work); 3.15 a1; 3.16 a2 (a1 capped); 3.1 a1; 3.2 a2 (a1 capped); 3.3 a3 (a1 capped, a2 NO-JOURNAL at the cap, principal lesson `d9c7158` on `task/3.3`, then a3 passed, `c20260c`); 3.4 a1; 3.5 a1.
- **3.6 (one-workflow e2e, sonnet) is `STUCK 3.6 (no journal entry)` after 3 attempts.**
  - a1 and a2 capped at 81 turns. a3 (54 turns) met acceptance: `one-workflow.spec.ts` 6/6 under Xvfb against `expected/one-workflow.md`, full e2e/shell 14/14, `scripts/check` green (6904 unit, 78 cargo). It printed the promise but completed a2's journal stub instead of appending its own line (lesson [1.29]), so the runner stopped it.
  - `task/3.6` in `.wt/3.6` at `9397a4a`, clean tree, 2 `- [3.6]` journal lines. Logs `.evidence/tasks/3.6/{1,2,3}.log`. Diff vs `phase/3`: `apps/desktop/src/workspace/DocumentPane.tsx` (+45), `e2e/shell/test/one-workflow.spec.ts` (+417), `fixtures/markdown/expected/one-workflow.md` (new), `packages/core/test/one-workflow-golden.test.ts` (new), journal.
- **The gap 3.6 exposed.** The desktop app has no source toggle. Cmd/Ctrl+/ (task 1.7, PRD §146: swaps PM ↔ CM over the store, cursor mapped, editable) exists only on the Phase 1 dev route (`apps/desktop/src/dev/DevEditor.tsx`: `bindCodeMirror`, `sourceToggleKeymap`). No task in `ralph/tasks.json` wires it into the shell. 3.6's PRD §3 step 6 ("toggle source and back") needed one, so a1 added, unrequested, a **read-only** CodeMirror snapshot behind a "Toggle source" button in `DocumentPane.tsx` (commit `85fd05e`; no Cmd/Ctrl+/, not editable, no cursor map). That is short of §146 and against CLAUDE.md's "no unrequested features".
- **Runner:** idle after `STUCK`; tmux pane `essaydown:runner` (pid 8940) at `zsh`. Restart: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 3 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher:** stopped. runner.log has 235,461 lines. After a restart, arm at `wc -l` + 1 as a persistent Monitor (30-minute cap), and on every expiry run `status` and a catch-up grep from the same start, adding each already-reported `[ralph] <id> attempt <n> (loop` line to a `grep -v -F` list:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=START; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  Never add a free-text term to its filter.
- **Expected next stop signal:** after 3.6 is resolved, `3.verify` → `HUMAN_GATE 3.verifyh` (if the route is option A below); with option B, 3.19 → 3.20 first.

## Corrections

- `062` Current State: "Origin `phase/3` is at `81fb70a`". Michael pushed through `c20260c`.
- `062` Current State, expected chain "3.18 → 3.14 → 3.15 → 3.16 → 3.1 … 3.6 → `3.verify`": held, except 3.6 stopped.
- `062` and earlier: the implicit assumption that the desktop shell has the source toggle. It does not (see Current State).

## Decisions

- **#053** (on `phase/3`, `8890e43`): 3.13 abandoned and replaced by 3.18 (Michael's option 1; Fable confirmed the route and added the merged-away-sibling position guard). 3.18 passed at a1.
- **Principal lesson on `task/3.3`** (`d9c7158`, `chore(3.3)`), after a2's NO-JOURNAL at the cap: the remaining verification steps with call costs from 2.log (#038). 3.3 then passed at a3. The NO-JOURNAL restart was the plain tmux line, no `retry` (memory: NO-JOURNAL keeps running).
- **No DECISIONS entry since #053.** Nothing decided on 3.6 yet.
- **Backlog lines added by tasks this block (not acted on):** `[3.16, found outside scope]` Shift-Enter at an `inline_code` closing edge drops the hard break silently (hard stop `3.verify`); `[3.18, PM joins same-mark runs]` (from #053).

## Gotchas

- **Open question to Michael, asked before 3.6 stopped (no answer yet).** The principal's recommendation, stated as the correct route: a dedicated task wiring the real Cmd/Ctrl+/ toggle into the desktop shell (port from `DevEditor.tsx`), and the e2e drives it. Conditional plan offered:
  - **A (if 3.6 passed with the read-only snapshot):** record it as a stand-in in DECISIONS plus a backlog line, and add a real-toggle fix task among 3.7's review follow-ups before `3.close`.
  - **B (if 3.6 stopped):** replace by #052/#053's route — 3.19 (opus) wires the real toggle into the shell; 3.20 is 3.6's e2e, checked out from `9397a4a` minus the read-only stand-in in `DocumentPane.tsx`, driving Cmd/Ctrl+/.
  - Or Michael accepts the read-only view and cuts §146 for the shell.
  - 3.6 stopped, but its work is green, so a cheaper variant of A exists: `retry 3.6` (first retry; move `.evidence/tasks/3.6/{1,2,3}.log` aside first, #027) with a lesson that only appends a NEW `- [3.6]` journal line via `printf` with the timestamp, runs `scripts/check` once, and commits. That integrates the read-only stand-in, so it needs Michael's choice between A and B first.
- **STUCK is a Fable trigger**, but this STUCK is a journal-protocol miss on green work; the decision is Michael's product call (A vs B), not a text conflict. Brief Fable only for B's route details (which files 3.20 checks out; whether the shell's store wiring supports `bindCodeMirror` as on the dev route; the burst-settling rule for the new reader).
- **#052/#053's route** (for B): `abandon 3.6` (`.wt/3.6` clean first) → planning commit on `phase/3` from the host while idle (PRD §8 rows, dependents of 3.6 rewired — check `3.verify`'s deps line, 3.6's row byte-identical) → `generate-tasks`, `EXPECTED_COUNT` 342, `validate-tasks` OK → carry `[3.6]` lessons lines → DECISIONS #054 with reversal → `sync-state`, `doctor`, `--dry-run` naming 3.19 → restart.
- **Never write the literal promise** into any file an agent reads; check `git diff | grep -c '<promise>'` = 0.
- **A recovery commit can carry a mutation.** Before any retry, diff `packages/*/src` and `apps/*/src` against the branch base; 3.6's src diff is only the `DocumentPane.tsx` stand-in.
- **Status label lags.** `status` showed "running attempt 1" while runner.log had attempt 2 started; trust runner.log's `[ralph]` lines.
- **Proposal 002** lands at the Phase 3→4 boundary, after `3.close`.

## Next Steps

1. One-line state to Michael; get his answer on A / B / cut (Gotchas).
2. Execute it: A → `retry 3.6` with the journal-only lesson, then the stand-in recorded at `3.7.r0d`; B → Fable brief, then #052's route for 3.19/3.20.
3. Restart, fresh watcher at `wc -l` + 1.
4. Hand Michael `git push origin phase/3` (3.4, 3.5 and whatever lands).
5. Rotate at the next stop signal that ends a working block.

## Open Questions

- **Michael:** the shell's source toggle — A (keep read-only stand-in now, real toggle as a 3.7 follow-up), B (replace 3.6 with 3.19 real toggle + 3.20 e2e), or cut §146 for the shell. The principal recommends the real toggle (A or B both deliver it; B delivers it before `3.verify`, so the verify gate tests the product §3 describes).

# Handoff 066: Phase 3, review set `3.7` r0 done → `PRINCIPAL 3.7.r0d` pending

Written 2026-10-06 by the principal, the Opus 5.5 session that continued from 065. When that session opened, all three r0 reviewers had already passed and the runner had stopped at `PRINCIPAL 3.7.r0d`. The session reported the state and rotated without changing anything. This handoff supersedes `065-phase-3-review-r0-running.md`.

This commit is on `handoff/066`, stacked on `handoff/065` → `handoff/064` → `handoff/063` → `handoff/062` → `handoff/061` (none is in `phase/3`). It was made from a temporary worktree. Read it with `git show handoff/066:docs/handoffs/066-phase-3-review-r0-reconciliation-pending.md`. The next handoff is `067-*.md`.

## Current State

- **Branches.**
  - `phase/3` is at `552f186` `task(3.verify.g1)`, 6 commits ahead of origin `phase/3` (`git rev-list --count origin/phase/3..phase/3`).
  - `main` is at `da7d07b`.
  - The stack `handoff/061` → … → `handoff/066` (this commit) is what the reconciliation cherry-picks: `phase/3..handoff/066`.
  - Kept as evidence: `abandoned/3.6`, `abandoned/3.10`, `abandoned/3.13`, `attic/3.1-pre051`.
- **Status:** `Phase 3, 3.7.r0d principal-pending; last passed 3.7.r0c; gates open: none; plan requests: none; blocked: none`. Phase 3 has 29 tasks: passed 23, abandoned 3, superseded 1, principal-pending 1, pending 1. `doctor` is clean.
- **Review set `3.7` r0** (all attempt 1, `implementation_sha` `552f186`). Reports and status files are in `.evidence/reviews/3/r0/<reviewer>/`:

  | reviewer | task | verdict | blockers | should-fix | nits |
  |---|---|---|---|---|---|
  | claude (opus) | 3.7.r0a | FAIL | 1 | 15 | 4 |
  | sol | 3.7.r0b | FAIL | 3 | 2 | 0 |
  | grok | 3.7.r0c | PASS | 0 | 7 | 6 |

  Nobody has read the reports yet. These are reviewer severities; D1 applies at the reconciliation.
- **Runner:** stopped at `PRINCIPAL 3.7.r0d` (runner.log line 244190). Pane `essaydown:runner` (pid 8940) is at a `zsh` prompt. `pgrep -f 'ralph/lib/cli.mjs ralph run'` returns nothing and `.locks/` is empty.
  - The runner created `.wt/3.7.r0d` on `task/3.7.r0d` at `552f186`, and its tree is clean.
  - After the reconciliation commit, restart the runner with `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 3 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher:** none is running. After the restart, arm handoff 065's watcher command with `start=` set to `wc -l < .evidence/runner.log` + 1, read at restart time.
- **Expected next stop signal:**
  - If the reconciliation files no fix tasks, the runner proceeds to the remaining pending task (`3.close`, or whatever the planning puts before it). The next stop is `CLOSED`, `CLOSE-DRIFT` or `HUMAN_GATE`, depending on 3.close's row.
  - If the reconciliation appends fix tasks (and their `3.7.r1*` rows), the runner runs those first.

## Corrections

- `065` Current State, "Runner: `ralph run --phase 3` is live in tmux pane `essaydown:runner` (pid 8940, `node`)": the runner has exited at `PRINCIPAL 3.7.r0d`, and the pane is at a `zsh` prompt.
- `065` Next Steps 3, "cherry-picks `phase/3..handoff/065`": the range is now `phase/3..handoff/066`.

## Decisions

- **No DECISIONS.md entry** and no runner deviation since 065.
- **`WARN 3.7.r0c`** (runner.log line 244189, #044): Grok's transcript names `claude` ×4 and `sol` ×4. Every excerpt is the `ralph/tasks.json` row text: the acceptance sentence that names `/logs/reviews/3/r0/<sibling>/report.md`. On its face this is a mention through tasks.json, not a read. The reconciliation decides (#025, #044) by grepping r0c's transcript for a `Read` or `cat` of a sibling report path.

## Gotchas

- **Never quote the literal promise.** The runner's `[ralph]` line for 3.7.r0d contains it. Write it only in the `wip(3.7.r0d)` commit message.
- **Undo-keys backlog item** (from 065, still unfiled): `apps/desktop/src/modes/undo-keys.ts:18` returns early for every `INPUT` target. So Cmd/Ctrl+Z after picking a Rewrite variant radio does nothing on Windows and Linux. File it in `docs/V1.1-BACKLOG.md` with the trigger "a user report or a Phase 4 Rewrite change", unless a reviewer raised it as a finding. Check all three reports for `undo-keys`.
- **Container external-leg ordering leak** (`settings.spec.ts` leaves `typewriterScroll` true): unfiled. If a reviewer raises it, it is backlog, not D1.
- **`robustness.spec.ts:272` `this.skip()`** is a runtime budget skip from 3.17, not a 3.21 defect.
- **Windows autosave failure at g1h** (recorded, #047) is a watcher-timing case. It is not a blocker unless a reviewer shows lost text.
- **A blocker that only one reviewer raises** still gets a D1 check against the code: wrong bytes or lost text reaching the user silently, a crash, or a security issue. Sol's three blockers and Claude's one may overlap; count unique findings first.

## Next Steps

1. Run `status` (expect `PRINCIPAL 3.7.r0d`), `doctor` (clean) and `git status --short` (empty, on `phase/3`). Give Michael the one-line state.
2. Run the reconciliation in `.wt/3.7.r0d` on `task/3.7.r0d`:
   - `git cherry-pick phase/3..handoff/066` (the stack 061–066, docs only).
   - Read the three reports. Count unique findings and severity on shared ones.
   - Brief Fable in writing (reconciliation trigger, PRINCIPAL.md). Fable does not edit.
   - Apply #041 D1. Only blocking findings become fix tasks. Fix tasks go in `ralph/tasks.json` with their `3.7.r1a`/`r1b`/`r1d` rows (Grok reviews r0 only, #043), and `ralph/EXPECTED_COUNT` is updated to match. Everything else goes to backlog with a trigger.
   - File the undo-keys backlog line (Gotchas) unless a reviewer made it a finding.
   - Take the untaken `3.verify` hard stops from its journal entry (`grep -- '^- \[3\.verify\]' docs/progress/journal-main.md`).
   - Decide the `WARN 3.7.r0c` question (Decisions).
   - Touch only `docs/**`, `ralph/tasks.json` and `ralph/EXPECTED_COUNT`. Check the journal's last byte, then append its own `- [3.7.r0d] ` journal line in the same commit. Commit as `wip(3.7.r0d)` with the DONE promise only in the message.
   - If `tasks.json` changed, run `ralph/ralph.sh sync-state` and then `ralph/ralph.sh run --phase 3 --dry-run` before the restart (#051). Restart only when the dry run names the expected task.
3. Restart the runner (Current State) and arm the watcher.
4. Hand Michael `git push origin phase/3` when convenient (6 commits ahead now).

## Open Questions

- **Michael:** fix 2 for undo-keys (exempt only text-entry inputs). It is backlog unless he wants it in Phase 3. He has been asked twice without an answer.
- **Michael (boundary):** Fable's both-legs rule for e2e/shell tasks (handoff 065 Gotchas). Raise it at the Phase 3→4 boundary planning.

# Handoff 049: Phase 2, review r0 done → `PRINCIPAL 2.10.r0d` (reconciliation, fresh session)

Written 2026-09-29 by the principal: the Opus 5.5 session that planned `plan.2.verify.g2h.r0`, watched `2.15` → `2.verify.g3`, ran the `2.verify.g3h` gate (a1 transient, a2 ACCEPT), recorded Michael's `2.9` observation gate, and watched the `2.10` r0 reviewers. It ran in Claude Code on the Mac Mini. It supersedes `048-phase-2-verify-g2-gate-failed.md` (on `handoff/048`). This commit is on `handoff/049`, **stacked on `handoff/048`** → `047` → … → `040`, none of them in `phase/2`. `2.10.r0d` cherry-picks `phase/2..handoff/049` as one range. The next handoff is `050-*.md`.

## Current State

- **Branches.**
  - `phase/2` is at `01a4c72` `task(2.verify.g3): …`, 229 commits, not on origin. New since 048: `d9745cf` plan(plan.2.verify.g2h.r0), `a89a20e` 2.15, `01a4c72` 2.verify.g3.
  - `main` is at `92a2ec1`, unchanged.
  - Remote ci refs: `ci/2.verify.g3/a1` and `a2` (both at `01a4c72`), plus the older `ci/2.verify.g2/a1`, `ci/2.verify.g1/a1`, `ci/2.verify/a1`, `ci/2.1/a1`. `scripts/gate.sh gc` cleans them.
- **Tasks.**
  - `2.15` passed a1. It added the `AlreadyExists` pre-check on the new sidecar and assets targets in `rename_file_at`, plus three collision tests. It also made the rollback test's failure injection work on Windows (an open handle under `assets/a`; on unix, chmod 0o555 on `assets`). Only `workspace.rs` changed.
  - `2.verify.g3` passed a1.
  - `2.verify.g3h`: a1 was GATE-FAILED on a transient. Windows cargo passed 58/58, including the rollback test. The one failure was Playwright `editor-toggle.spec.ts:420`, which timed out after 30 s in `openEditor`, waiting for `.ProseMirror` after `goto('/dev/editor')`: the page never rendered. The tree diff since the prior gate was `workspace.rs` only, and the same spec passed on Windows at g1h and g2h. So I ran `scripts/gate.sh rerun 2.verify.g3h`, which withdrew `plan.2.verify.g3h.r0`. **a2 ACCEPT**, run 36526593385.
  - `2.9` **ACCEPT** a1 (Michael, observation gate). Payload: `artifact_sha=01a4c72…`, `editor_substitute=vscode`. The record is `.evidence/human/2.9/a1.md`.
  - `2.10.r0a/b/c` passed a1 (13 min). All three reviewed `implementation_sha 01a4c72`, verifier `2.verify.g3`. From each `status.json`:
    - **Sol:** FAIL, 5 blockers, 4 should-fix, 0 nits.
    - **Claude:** FAIL, 2 blockers, 16 should-fix, 2 nits.
    - **Grok:** PASS, 0 blockers, 5 should-fix, 5 nits.
    - Reports are at `.evidence/reviews/2/r0/{sol,claude,grok}/report.md`. There were no `WARN` lines this block.
  - `2.10.r0d` is **principal-pending**, on branch `task/2.10.r0d` in `.wt/2.10.r0d` (at `01a4c72`).
- **Status:** `Phase 2, 2.10.r0d principal-pending; last passed 2.10.r0c; gates open: none; plan requests: none; blocked: none`. `doctor` is clean. The host checkout is clean on `phase/2`.
- **Runner.** Stopped at `PRINCIPAL 2.10.r0d`. The tmux pane `essaydown:runner` (pid 8940) is at `zsh`. Restart it after the r0d commit carries the promise: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 2 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher.** Stopped at rotation. runner.log has 177,701 lines, and the last marker is `[ralph] 2.10.r0d: work in …`. Re-arm only after restarting, at `wc -l` + 1:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=<wc -l + 1>; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  The session substitutes the number itself; this is not a command for Michael.
- **Expected next stop signal:** none until the r0d commit. After that, the planning result of the reconciliation (fix tasks and `r1`) or `2.close`.

## Corrections

- `048` (on `handoff/048`) has a stale `phase/2` tip (`40c9be2`, 226) and a stale watcher start (174643). Its "likely cause, unverified" is now verified (below).
- `048`'s `.dmg` path is now `.evidence/ci/2.verify.g3h/accepted/macos-debug-dmg/EssayDown-debug-01a4c72c7d7d5758c526d05821f38ea00da95bb2.dmg`. The `accepted` symlink points at a2.

## Decisions

- **No DECISIONS entry this block.** DECISIONS.md on `phase/2` still ends at #043, and #044–#045 are on the stack. None of `d9745cf`, `2.15` or `2.verify.g3` touched DECISIONS.md, so `handoff/049` stacks on `048` without a rebase.
- **Planning commit `plan.2.verify.g2h.r0`** (wip `81a9b5e`, integrated as `d9745cf`) added `2.15` and `2.verify.g3`, rewired `2.9`/`2.10` to `2.verify.g3h`, and took EXPECTED_COUNT from 295 to 298. The route came from a Fable consult on PLAN-GATE:
  - Rust 1.98.1 `std::fs::rename` on Windows calls `MoveFileExW(REPLACE_EXISTING)`, then falls back to `FileRenameInfoEx(REPLACE_IF_EXISTS|POSIX_SEMANTICS)`.
  - With those flags, a directory source replaces a plain file, so the old injection never fired, and in production a user file at `assets/<newstem>` was silently destroyed.
  - That is blocking under #041 D1, so the repair added the production guard as well as the test change. The scope went beyond the one failing test for that stated reason, which is recorded in the planning commit body.
  - Only the Windows leg proves the Windows injection. It did: `rename_rolls_back… ok` at g3h a2.
- **Runner deviation: one same-SHA rerun** (`gate.sh rerun 2.verify.g3h`), justified as a transient (see Current State). It is within RUNNER-SPEC §2, so no DECISIONS entry.
- **`2.9` substitution:** VS Code instead of Typora, the same substitution as `1.9.r1`. It is recorded in the payload.

## Gotchas

- **Reconciliation mechanics.** Cherry-pick `phase/2..handoff/049` into `task/2.10.r0d` in `.wt/2.10.r0d`. The range is docs only, inside the §8.1 allowlist. Commit only `docs/**`, `ralph/tasks.json` and `ralph/EXPECTED_COUNT`. The promise goes only in the `wip(2.10.r0d)` commit message.
- **Fable is on-trigger for the r0d decisions** (PRINCIPAL.md). Before any fix task, apply the #041 D1 stop rule to Sol's 5 and Claude's 2 blockers. Everything that is not blocking is backlog with a trigger.
- **Count before comparing reviewers.** Grok's PASS against two FAILs is not by itself a pattern about Grok. Count unique findings and severity on shared findings first (#review-1-r0).
- **Grok reviews `r0` only**, so an `r1` is written as `a`, `b`, `d` (#043).
- Michael's pasted multi-line command broke at the terminal wrap. A command handed to him should be short enough not to wrap, or the session runs it after he states the outcome.

## Next Steps

1. `status` (expected: `2.10.r0d principal-pending`), `doctor` (clean), `git status --short` (empty).
2. Read the three reports and dedupe the findings. Write a Fable brief for the r0d decisions: which findings are blocking under #041 D1, and the fix-task texts for those.
3. In `.wt/2.10.r0d`, cherry-pick `phase/2..handoff/049`, then add the DECISIONS entry for r0 (the verdicts, the counts, the blocker disposition and the backlog). If blockers remain, add PRD §8 rows for the fix tasks, `2.verify.r1` and `r1` (`a`, `b`, `d`), then run the generator and validator. Commit `wip(2.10.r0d)` with the promise in the message.
4. At the Phase 2 / 3 boundary (after `2.close`), show Michael #045's PRD and CLAUDE.md diff (drop Windows). The evidence is four Windows-only gate failures this phase: compile, the harness manifest, the rename rollback, and a Windows-only page-load transient.
5. Restart the runner and re-arm the watcher.

## Open Questions

- **Backlog (Michael, `2.9`):** Shift+Enter does not insert a line break, and he wants it to. This is a feature request, not a Phase 2 defect. Trigger: the phase that owns editor keybindings.
- **For the review set (`2.9`):** Michael could not reach the "Changed on disk" banner by hand, because autosave wins the race and the reload happens silently. Nothing was lost (BBEdit showed the edit on disk throughout). The r0d should check whether an e2e covers the banner path. If none does, it is a should-fix with a trigger, not a blocker.
- **For Michael (Phase 2 boundary):** register `tauri-plugin-wdio`. Unchanged since 043.
- **For the boundary:** re-read #045's "macOS required e2e runner on the embedded plugin" in light of the embedded provider's synthetic input (Fable's note from 046).
- **Boundary, only if a third occurs:** the stub-skip after a capped attempt, and background-and-wait on a long e2e. Both are still at two occurrences.

# Handoff 058: Phase 2, `GATE-FAILED 2.verify.r3h` a1 (macOS Playwright caret race)

Written 2026-10-04 by the principal: the Opus 5.5 session that continued from 057. It reconciled review r2 (FAIL, fix task 2.27 on Michael's word), watched 2.27 and `2.verify.r3` pass, ran the CI gate, and rotated at its `GATE-FAILED`. It supersedes `057-phase-2-review-r2-reconciliation.md`.

This commit is on `handoff/058`, based on `phase/2` at `5522dbb`. The content of `handoff/055`–`057` is already in `phase/2` through `2.10.r2d`'s cherry-pick (`24f89d7`). `git merge-base --is-ancestor` reports them "not in" because the cherry-pick made new SHAs. Never stack on them or re-pick them. The next reconciliation (`2.10.r3d`) cherry-picks `phase/2..handoff/058`, plus any later handoff stacked on 058. The next handoff is `059-*.md`.

## Current State

- **Branches.**
  - `phase/2` is at `5522dbb` `task(2.verify.r3)`. Since 057: `24f89d7` task(2.10.r2d), `96f19d5` task(2.27), `5522dbb` task(2.verify.r3). Not on origin.
  - `main` is at `92a2ec1`, unchanged.
  - `handoff/040`–`058` exist. Delete them all after `2.close`.
- **Status:** `Phase 2, idle; last passed 2.verify.r3; gates open: none; plan requests: plan.2.verify.r3h.r0:pending; blocked: 2.verify.r3h:blocked`. `doctor` is clean. The host checkout is clean on `phase/2`. `EXPECTED_COUNT` is 329.
- **Since 057:**
  - `2.10.r2d`: reconciled as **FAIL** (`#review-2-r2`).
    - Claude PASS 0/0/0 (confirm scope); Sol FAIL 2/1/0. The 3 raw findings are 3 unique, all Sol's.
    - Both #025 WARNs are mentions of tasks.json, not reads.
    - Fable consulted. Michael chose "One fix task 2.27 (Recommended)".
    - Sol 3, the barrier-to-discard gap and 2.25 check 5 were backlogged with triggers. 2.25's record is `#010-mac-quit-check`.
  - `2.27` passed at **attempt 1**: W1 (flush/keepMine drain to the latest generation) and W2 (`renamed(rewrite)`).
  - `2.verify.r3` passed at **attempt 1**. It promoted the `#review-2-r2 W1` rule into CLAUDE.md and AGENTS.md as the last Code rule.
- **The gate failure.** `scripts/gate.sh 2.verify.r3h` a1, run 37213193738 at `5522dbb`, ref `ci/2.verify.r3/a1`. Evidence: `.evidence/ci/2.verify.r3h/a1/`; artifacts were fetched, `workflow.log` included.
  - Only failure: macos-latest `Playwright (e2e/web)`, 1 failed / 101 passed. The test is `editor-astral-between-runs.spec.ts:142` › "Sol's reproduction: `*a.* 😀 *(b)*` loaded, the two spaces around the emoji taken by Backspace and Delete …".
  - The `expect.poll` at `:162` timed out after 5000 ms, still reading the seed bytes `*a.* 😀 *(b)*`: the `Backspace` at `:161` changed nothing.
  - Everything else is green:
    - cargo: ubuntu 78/0, macOS 78/0, windows 75/0;
    - e2e-shell: 8/8 spec files on all three OSes;
    - vitest, lint and the runner conformance suite green.
  - Gate output is in the old session's scratchpad. The ROTATE-PRINCIPAL and GATE-FAILED lines are in the gate's stdout, not in runner.log.
- **Runner:** idle. The process stopped at `HUMAN_GATE 2.verify.r3h`. The tmux pane `essaydown:runner` (pid 8940) is at `zsh`. Restart with `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 2 2>&1 | tee -a .evidence/runner.log' Enter`, only after the gate is resolved.
- **Watcher:** stopped by this rotation. runner.log has 204,814 lines. After the restart, arm this as a persistent Monitor at `wc -l` + 1 (30-minute cap):
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=START; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  Never add a free-text term to its filter.
- **Expected next stop signal after the gate is resolved:** `PRINCIPAL 2.10.r3d`, after `2.10.r3a` (claude) and `2.10.r3b` (sol) run in parallel. On ACCEPT the reviewers start at once; there is no human gate in r3.

## Corrections

- `057` Current State: "runner.log has 200,950 lines". It had 200,950 at the restart; it now has 204,814.
- `057` Next Steps 4 expected a possible PASS. The verdict was FAIL; the graph is in `#review-2-r2`.
- `057` Branches said `handoff/040`–`057`. 058 now exists too.
- `next-prompt.md` at `handoff/057`: superseded by this commit's version.

## Decisions

- **`#010-mac-quit-check`**: 2.25 a1's accepted record, copied by `2.10.r2d`.
- **`#review-2-r2`**: verdict FAIL.
  - W1 and W2 → **2.27** (Michael: "One fix task 2.27 (Recommended)").
  - Sol 3 → backlog `[review-2-r2, sidecar failure after a Markdown write]`.
  - The barrier-to-discard gap and `[review-2-r2, 2.25 check 5 not run]` → backlog.
  - The graph: 2.27, `2.verify.r3`(+h), `2.10.r3a/b/d`; `2.close` → `2.10.r3d`.
- **The rule promoted by `2.verify.r3`**, with Michael's approval of the chain: a checked outcome that permits discarding state covers the latest generation.
- No runner deviation, no `retry`, no new DECISIONS entry since then.

## Gotchas

- **This failure matches #042 exactly.** That is the same spec, the same Backspace no-op on macos-latest, and the same 101/1 split, at `1.verify.r10h` a1. #042 settled it as transient: a same-SHA `scripts/gate.sh rerun`, then the #023 manual `abandon` of a1 once doctor misreads it.
  - #023's transient criterion holds here. `git diff --stat 1bb43d1 5522dbb -- packages apps/desktop/src/editor e2e fixtures` is empty: nothing in the editor, e2e or fixtures changed since gate `2.verify.r2.g1h` ACCEPT, where this case was green. 2.27 touched only `apps/desktop/src/workspace/{document-sync.ts,DocumentPane.tsx}`, `tests/document-sync.test.ts`, CLAUDE.md and AGENTS.md.
  - The spec has passed in 27 of the 29 gate workflow logs that ran it. It failed in 2: `1.verify.r10h` a1 and this run.
- **The `[1.46]` caret-race class** (`docs/V1.1-BACKLOG.md:83-84`): #042 counted six instances at gates, the second of them on macOS, and said its hard stop was `2.verify`. This would be the seventh instance and the third on macOS. The next session reads lines 83–84 and #042's last two bullets before deciding. If the hard stop is `2.verify` and still unmet, a rerun alone may not be what #042's own text asks; that question is for Fable's brief.
- **After an accepting rerun**, `doctor` will report `incomplete 2.verify.r3h a1 … --resume a1`. Never run that `--resume`. Use #023's `abandon` with the reason text #042 uses, adapted: "fourth instance after #042". It needs a DECISIONS entry on `handoff/059`, stacked on `handoff/058`.
- **Container login expiry.** A task that dies in seconds with `Failed to authenticate: OAuth session expired` needs Michael's `cd /Users/mlsavage/Developer/essaydown && docker compose run --rm claude-login`, then a plain `ralph run`.
- **Never write the literal DONE promise** into any file an agent reads.

## Next Steps

1. Run `status` (expected as above), `doctor` (clean) and `git status --short` (empty). Give Michael the one-line state.
2. Fable brief (trigger: the gate decision; per PRINCIPAL.md, the runner contradicting itself / #023 class):
   - **Evidence:** `.evidence/ci/2.verify.r3h/a1/` (`workflow.log`: grep `^test (macos-latest)\tPlaywright`), #023, #029, #042, `docs/V1.1-BACKLOG.md:83-84`, and the empty editor/e2e diff above.
   - **The one question:** a same-SHA transient rerun under #023/#042, or a `.g1` repair through `ralph/ralph.sh plan` that scopes to this spec's anchor?
   - **Answer format:** decision, reasons, confidence, and commands.
3. **If rerun:**
   - Run `scripts/gate.sh rerun 2.verify.r3h` in the background, redirected to a scratchpad file.
   - On ACCEPT, read the per-OS cargo counts, then `abandon` a1 per #023 and record the DECISIONS entry on `handoff/059`.
   - Check that `doctor` is clean, then restart the runner and arm the watcher.
4. **If repair:** run `ralph/ralph.sh plan` for `plan.2.verify.r3h.r0`. The planning commit goes on `plan/2.verify.r3h/r0` in `.wt/plan.2.verify.r3h.r0`: a `.g1` repair task plus `2.verify.r3.g1`, with the reviewers rewired. EXPECTED_COUNT comes from the generator.
5. At `PRINCIPAL 2.10.r3d`, rotate first; a fresh session runs it, cherry-picking `phase/2..handoff/NNN`.
6. At `2.close` / the Phase 2→3 boundary, bring Michael the Open Questions.

## Open Questions

- **For the next session (Fable first, then the decision):** the rerun-or-repair question above, including whether the `[1.46]` class's hard stop binds here.
- **For Michael (Phase 2 / 3 boundary), unchanged from 057:**
  - #045's drop-Windows diff, with this phase's Windows-only gate failures as evidence. r2h's macOS failure and this one do not count.
  - `tauri-plugin-wdio` (U25).
  - The U9 robustness test-only task.
  - Which of the 35 re-pointed hard stops become Phase 3 tasks.
  - The settings directory (U16).
  - Shift+Enter.
  - #045's "macOS required e2e runner on the embedded plugin".
  - The background-and-wait pattern at four occurrences (2.19 a2, 2.22 a2).
  - The `cfg(target_os)` question (one occurrence, r2h).
  - 2.25 check 5 not run: `[review-2-r2, 2.25 check 5 not run]`. Should a later human gate re-ask it?
- **New, for the boundary:** the `[1.46]` caret-race class now has seven gate instances, three of them on macOS. Is a runner or e2e change warranted (#023's boundary `fix(runner)`)?

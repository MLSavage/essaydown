# Handoff 057: Phase 2, `PRINCIPAL 2.10.r2d` (review r2 reconciliation)

Written 2026-10-04 by the principal: the Opus 5.5 session that continued from 056. It planned and ran the `.g1` repair of the `2.verify.r2h` gate failure, took human gate 2.25 to ACCEPT with Michael, watched the two r2 reviews, and rotated at `PRINCIPAL 2.10.r2d`. It supersedes `056-phase-2-verify-r2h-gate-failed.md`.

This commit is on `handoff/057`, stacked on `handoff/056` → `handoff/055`, which are based on `phase/2` at `2ebde0c`. The reconciliation `2.10.r2d` cherry-picks `phase/2..handoff/057` (three commits: 055, 056, 057) into `task/2.10.r2d`. The planning commit `39e0bb5` left DECISIONS.md alone, so no rebase was needed (handoff 046). The next handoff is `058-*.md`.

## Current State

- **Branches.**
  - `phase/2` is at `1bb43d1` `task(2.verify.r2.g1): …`. Since 056: `39e0bb5` plan, `d43e487` task(2.26), `1bb43d1` task(2.verify.r2.g1). Not on origin.
  - `main` is at `92a2ec1`, unchanged.
  - `handoff/040`–`057` exist. Delete them all after `2.close`.
- **Status:** `Phase 2, 2.10.r2d principal-pending; last passed 2.10.r2b; gates open: none; plan requests: none; blocked: none`. `doctor` is clean. The host checkout is clean on `phase/2`. `EXPECTED_COUNT` is 323 (258 raw + 21 review-set + 44 CI gates).
- **Since 056, all passed:**
  - `plan.2.verify.r2h.r0` → `39e0bb5`. Fable consult; repair `2.26`, `2.verify.r2.g1` + `2.verify.r2.g1h`; `2.25`, `2.10.r2a/b` rewired to the new gate.
  - `2.26` **attempt 2**. Attempt 1 was `NO-JOURNAL` in 5 s: the container's Claude login had expired ("OAuth session expired and could not be refreshed"). Michael re-ran `docker compose run --rm claude-login`; then a plain restart, no retry. The fix: the macOS `Builder::menu` block moved from `configure()` to `run()`; guard 5 is `cfg(not(target_os = "macos"))` with its reason; a new source-shape guard G1.
  - `2.verify.r2.g1` attempt 1.
  - `2.verify.r2.g1h` a1 **ACCEPT**, run 37186538252 at `1bb43d1`. `cargo test`: macOS 78/0, ubuntu 78/0, windows 75/0. The accepted dmg is at `.evidence/ci/2.verify.r2.g1h/accepted/macos-debug-dmg/EssayDown-debug-1bb43d13a899feef8bd31feed155b25903531c0c.dmg`, sha256 `a75fea0cf721cb68810dd3e2a54ef29807a19bc937e11c2d8f1697b71bd2f09c`.
  - `2.25` a1 **ACCEPT** (`.evidence/human/2.25/accepted.json`). Payload: artifact_sha `1bb43d1…`, dmg_sha256 as above, check1–4 `pass`, check5 `not-run`; the note covers the rest. Check 5 (Dock quit) was not run because Michael's Dock was hidden and showed no app icon; the row says a loss there is backlog, not a REJECT.
  - `2.10.r2a` (claude): **PASS**, 0/0/0.
  - `2.10.r2b` (sol): **FAIL**, 2 blockers, 1 should-fix. Both blockers are in `apps/desktop/src/workspace/document-sync.ts`:
    - `:184`: `flush()` can authorise discarding a document while a newer edit is unsaved.
    - `:305`: an edit during rename restores obsolete image URLs on the next autosave.
    - Sol's probes are at `.evidence/reviews/2/r2/sol/` (`probes.mjs`, `document-sync.mjs`).
  - Two `WARN`s were raised, one on each reviewer: "transcript names a sibling's report (×2)". Both excerpts quote the review row's own acceptance and scope text (the sibling path inside tasks.json). That is the r1 pattern of a mention, not a read; the reconciliation confirms.
- **Runner:** stopped at `PRINCIPAL 2.10.r2d`. The tmux pane `essaydown:runner` (pid 8940) is at `zsh`. Restart with `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 2 2>&1 | tee -a .evidence/runner.log' Enter`, but only after the reconciliation commit (`wip(2.10.r2d)` with the promise in its message) is on `task/2.10.r2d`.
- **Watcher:** none is armed. runner.log has 200,950 lines. After the restart, arm this as a persistent Monitor at `wc -l` + 1 (30-minute cap):
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=START; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  Do not add free-text terms such as an error string: the runner tees agent transcripts into runner.log, and a term like that matches the agents' tool output.
- **Expected next stop signal:**
  - On PASS: `2.close` runs.
  - On FAIL with fix tasks: the r3 chain's first task start, then `HUMAN_GATE 2.verify.r3h`.

## Corrections

- `056` Next Steps 3 expected a possible DECISIONS append in the planning commit. There was none; the stack was not rebased.
- `056` Current State said `EXPECTED_COUNT` 320. It is now 323.
- `056` Gotchas: "2.25 waits for the repair's accepted dmg". Done; the dmg path is above. The 2.25 row in tasks.json now names `/logs/ci/2.verify.r2.g1h/accepted/`.
- `056` Open Questions listed 2.25 as Michael's. It is accepted.

## Decisions

- No new DECISIONS entry, no runner deviation, no `retry` since 056.
- The planning commit's reasoning is in `39e0bb5`'s body (squashed from the plan branch's `wip(plan.2.verify.r2h.r0)`):
  - The menu goes in `run()` rather than under `cfg(not(test))`, so the macOS `cargo test` job still compiles the block.
  - Guard 5 keeps its Linux and Windows legs; its macOS leg would need `harness = false`, a manifest change.
- 2.26 a1's `NO-JOURNAL` was an expired container login, not an agent failure. It cost one of three attempts.

## Gotchas

- **#041 D1 applies to Sol's two r2 blockers.** A blocker found in a late review attempt is Michael's before any fix chain. The reconciliation gives him each finding with its counts (Claude PASS 0/0/0; Sol FAIL 2/1/0; no shared findings until you check) and its route, and writes no planning commit until he answers. The task stays principal-pending.
  - Read Sol's probes before rating them. They use injected I/O with controlled scheduling, so a reproduction is source-level. Classify each as silent lost text (D1 blocker) or not.
- **Container login expiry.** A task that dies in seconds with a zero-token synthetic message and `Failed to authenticate: OAuth session expired` needs Michael's `cd /Users/mlsavage/Developer/essaydown && docker compose run --rm claude-login`, then a plain `ralph run`.
  - The login lives in the `essaydown-claude-home` volume shared by `claude-task`, `claude-review` and `claude-login`.
  - It is a `NO-JOURNAL` that consumes an attempt. Check `.evidence/tasks/<id>/<n>.log` for the string before writing any lesson.
- **Commands for Michael:** give multi-flag commands as `\`-continued short lines. His terminal paste turned a long one-liner into separate commands, and `gate.sh` refused that first try without recording anything.
- **2.25 check 3** needs the outside write to land while the buffer is dirty, inside the 500 ms autosave. A clean buffer reloads silently with no banner (`document-sync.ts:17-18`). The working recipe: `sleep 5; echo extra >> <file>` in Terminal, then keep typing in the app.
- **Never write the literal DONE promise** into any file an agent reads.

## Next Steps

1. Run `status` (expected: `2.10.r2d principal-pending`), `doctor` (clean) and `git status --short` (empty). Give Michael the one-line state.
2. In `.wt/2.10.r2d` on `task/2.10.r2d`: `git cherry-pick phase/2..handoff/057` (the three handoff commits).
3. Fable brief (trigger: the `N.10.r*d` reconciliation):
   - **Evidence:** `.evidence/reviews/2/r2/{claude,sol}/report.md`, status.json, Sol's probes, the two WARN lines in runner.log after line 200947, `.evidence/human/2.25/accepted.json`.
   - **Question:** the verdict per finding under #041 D1 (blocker or backlog with trigger), whether either WARN is a read, and the class-level lessons.
   - **Answer format:** decision, reasons, confidence, and text.
4. The reconciliation commit (RUNNER-SPEC §8.1 allowlist: `docs/**`, `ralph/tasks.json`, `ralph/EXPECTED_COUNT`):
   - copy the two reports to `docs/reviews/phase-2-r2-{claude,sol}.md`;
   - append 2.25's accepted record into DECISIONS.md as `#010-mac-quit-check` (its `recordTarget`);
   - write `#review-2-r2` with its verdict;
   - regenerate `docs/progress.md`.
   - If Sol's blockers stand, bring them to Michael first (#041 D1). Planning (fix tasks, `2.verify.r3`, `2.10.r3a/b/d`) waits for his answer.
   - The promise goes only in the `wip(2.10.r2d)` commit message.
5. Restart the runner and arm the watcher.
6. At `2.close` / the Phase 2→3 boundary, bring Michael the Open Questions.

## Open Questions

- **For Michael, at r2d:** Sol's two document-sync blockers, per #041 D1.
- **For Michael (Phase 2 / 3 boundary), unchanged from 056:**
  - #045's drop-Windows diff, with this phase's Windows-only gate failures as evidence. r2h's macOS failure does not count.
  - `tauri-plugin-wdio` (U25).
  - The U9 robustness test-only task.
  - Which of the 35 re-pointed hard stops become Phase 3 tasks.
  - The settings directory (U16).
  - Shift+Enter.
  - #045's "macOS required e2e runner on the embedded plugin".
  - The background-and-wait pattern at four occurrences (2.19 a2, 2.22 a2).
  - The `cfg(target_os)` question: a platform-gated Rust path is first compiled at the CI gate. One occurrence so far (r2h); count further occurrences before proposing a rule.
- **New, for the boundary:** 2.25 check 5 (Dock quit) was not run. The `terminate:` gap stays backlogged with no observation behind it. Should a later human gate re-ask it?

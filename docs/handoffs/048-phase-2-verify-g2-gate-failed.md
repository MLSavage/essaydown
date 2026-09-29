# Handoff 048: Phase 2, `2.verify.g2h` GATE-FAILED at a1 (one Windows cargo test) → `PLAN-GATE plan.2.verify.g2h.r0`

Written 2026-09-27 by the principal: the Opus 5.5 session that planned `plan.2.verify.g1h.r0`, watched `2.14` → `2.verify.g2` and ran the `2.verify.g2h` gate, in Claude Code on the Mac Mini. It supersedes `047-phase-2-verify-g1-gate-failed.md` (on `handoff/047`). This commit is on `handoff/048`, **stacked on `handoff/047`** → `046` → … → `040`, none of them in `phase/2`. `2.10.r0d` cherry-picks `phase/2..handoff/048` as one range. The next handoff is `049-*.md`.

## Current State

- **Branches.**
  - `phase/2` is at `40c9be2` `task(2.verify.g2): …`, 226 commits, not on origin. New since 047: `0018dab` plan(plan.2.verify.g1h.r0), `f0f323a` 2.14, `40c9be2` 2.verify.g2.
  - `main` is at `92a2ec1`, unchanged.
  - Remote ci refs: `ci/2.verify.g2/a1` (at `40c9be2`, pushed by this gate), `ci/2.verify.g1/a1`, `ci/2.verify/a1`, and the stale `ci/2.1/a1`. `scripts/gate.sh gc` cleans them whenever convenient.
- **Tasks.** `2.14` passed a1. It changed `apps/desktop/src-tauri/build.rs` (on windows/msvc only: `WindowsAttributes::new_without_app_manifest()` + `cargo:rustc-link-arg=/MANIFEST:EMBED` and `/MANIFESTINPUT:…`) and added `apps/desktop/src-tauri/windows-app-manifest.xml`. `2.verify.g2` passed a1.
- **Status.** `Phase 2, idle; last passed 2.verify.g2; gates open: none; plan requests: plan.2.verify.g2h.r0:pending; blocked: 2.verify.g2h:blocked`. Phase 2 has 27 tasks: 17 passed, 3 superseded, 6 pending, 1 blocked. `doctor` clean. Host checkout clean on `phase/2`. `.locks/` empty, no `ralph run` process.
- **Gate `2.verify.g2h` a1: GATE-FAILED.** This was ci.yml run 36324256194 at `40c9be2`; evidence is in `.evidence/ci/2.verify.g2h/a1/`.
  - **The 2.14 manifest fix worked.** The Windows `desktop_lib` test harness now loads: `running 55 tests`, 54 passed, 1 failed.
  - **The one failure:** `workspace::tests::rename_rolls_back_doc_and_sidecar_when_moving_assets_fails`, panicked at `apps\desktop\src-tauri\src\workspace.rs:902:9` with `assertion failed: result.is_err()`. The test starts at `workspace.rs:891`. Evidence: `test-logs/test-logs-windows-latest/cargo-test.log` lines 663–685. It is the only `##[error]` in `workflow.log` (`test (windows-latest)` → `Cargo test`, exit 101). Every other job is green, including the e2e-shell legs and `macos-debug-dmg`.
  - **Likely cause, unverified:** the test injects a failure into the asset move with a mechanism that makes the move fail on unix but not on Windows, so the rename succeeds there. A sibling test, `write_doc_to_acl_denied_dir_returns_permission_denied`, passes on Windows; it denies access with `icacls` (the log shows `processed file: …\denied`). Fable verifies this.
  - **The .dmg** is `.evidence/ci/2.verify.g2h/a1/macos-debug-dmg/EssayDown-debug-40c9be2d76295dfe17a80585778285c56b683efe.dmg`. It comes from a failed attempt, so it is not for `2.9`.
- **Runner.** Stopped at `HUMAN_GATE 2.verify.g2h`. tmux `essaydown:runner` pane 8940 is at `zsh`. The gate emitted `GATE-FAILED 2.verify.g2h a1`, `PLAN-GATE plan.2.verify.g2h.r0` and `ROTATE-PRINCIPAL` to its own output, not to runner.log. Restart after the planning commit: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 2 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher.** Stopped at rotation. runner.log has 174,642 lines, so start at 174643. The last `[ralph]` marker is `[ralph] 2.verify.g2 attempt 1`, and the last stop line is `HUMAN_GATE 2.verify.g2h`:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=174643; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  Arm it only after restarting the runner. At that point take `wc -l < .evidence/runner.log` again and start at that count + 1.
- **Expected next stop signal:** none until you act. After the planning commit and the restart, expect `[ralph] 2.15 attempt 1`, then `2.verify.g3`, then `HUMAN_GATE 2.verify.g3h`.

## Corrections

- `047` (on `handoff/047`) has a stale `phase/2` tip (`2c5fe44`, 223) and a stale watcher start (171799). Its manifest cause is now verified, and the fix passed at the gate.
- `047`'s next-prompt step 5 reads the .dmg from `.evidence/ci/2.verify.g2h/accepted/`. That directory does not exist, because a1 failed. The path becomes `.evidence/ci/2.verify.g3h/accepted/macos-debug-dmg/`, and the `2.9` text now names `2.verify.g2h`, so the planning commit rewires it again.

## Decisions

- **No DECISIONS entry this block.** DECISIONS.md on `phase/2` still ends at #043, and #044–#045 are on the stack. None of `0018dab`, `2.14` or `2.verify.g2` touched DECISIONS.md (check with `git diff --stat 2c5fe44 phase/2 -- docs/DECISIONS.md`, which prints nothing). So `handoff/048` stacks on `047` without a rebase.
- **No runner deviations.** There was no `retry` and no principal lesson.
- **Planning commit `plan.2.verify.g1h.r0`** (wip `dba8def`, integrated as `0018dab`) added `2.14` and `2.verify.g2`, rewired `2.9`/`2.10` to `2.verify.g2h`, and took EXPECTED_COUNT from 292 to 295. The route came from a Fable consult (the brief format is the one in that commit's message). Fable traced the cause: embed-resource 3.0.11 emits `rustc-link-arg-bins`, and Cargo's `LinkArgTarget::Bin` never reaches the lib's test harness. rfd and muda import `TaskDialogIndirect`, which only comctl32 v6 exports.

## Gotchas

- **The plan request id is `plan.2.verify.g2h.r0`.** Run `ralph/ralph.sh plan plan.2.verify.g2h.r0`.
- **Edit mechanics that worked:** a node script over PRD §8 (exact-match `replace` with a count check; build new rows with `JSON.stringify`, inserted before the `{"id":"2.10","model":"review-set"` anchor). Then `node ralph/generate-tasks.mjs`, which writes tasks.json and EXPECTED_COUNT itself, then `node ralph/validate-tasks.mjs`. A repair task's `dependencies` names the producer being repaired (e.g. `["2.verify.g2"]`), and the generator maps it to the gate `2.verify.g2h`, which becomes superseded on integration.
- **Scope:** only the one failing test. The container is Linux and cannot run the Windows leg, so the repair's acceptance is: Linux suite green, the change is Windows-specific (a `#[cfg(windows)]` injection route, or whatever Fable verifies), and the journal states that only `2.verify.g3h` proves Windows. Do not weaken the assertion or `#[cfg(unix)]`-gate the test away unless Fable shows the rollback is not reachable on Windows. The rollback is the behaviour under test, and Windows is still in the acceptance until #045 takes effect at the boundary.
- A same-SHA rerun is wrong here: the failure is a deterministic assertion.

## Next Steps

1. `status` (expected: idle, `plan.2.verify.g2h.r0:pending`), `doctor` (clean), `git status --short` (empty).
2. **Fable brief** (trigger: `PLAN-GATE`). Evidence: `.evidence/ci/2.verify.g2h/a1/` (the cargo-test.log lines above), `apps/desktop/src-tauri/src/workspace.rs` (the test at 891 and the rename/asset-move code it exercises), and the passing `icacls` sibling test. One question: why does the asset-move failure injection not make the rename fail on Windows, and what is the minimal change (test-side injection or code) that makes the test prove rollback on Windows too? Answer format: decision, reasons, confidence, task text.
3. `ralph/ralph.sh plan plan.2.verify.g2h.r0`, then the planning commit in `.wt/plan.2.verify.g2h.r0`. Add the sonnet repair `2.15` (depends on `2.verify.g2`) and `2.verify.g3` (depends on `2.15`, `ci/2.verify.g3/a{n}`, the same ciAcceptance with the .dmg under `/logs/ci/2.verify.g3h/accepted/macos-debug-dmg/`). Rewire `2.9` (dependency and the path in its text) and `2.10` to `2.verify.g3`. EXPECTED_COUNT goes from 295 to 298. The promise goes only in the `wip(plan…)` message, with the reversal `ralph/ralph.sh plan-abandon plan.2.verify.g2h.r0 --reason "planning change for 2.verify.g2h withdrawn"`.
4. Restart the runner and arm the watcher at `wc -l` + 1.
5. At `HUMAN_GATE 2.verify.g3h`, run `scripts/gate.sh 2.verify.g3h` in the background. On ACCEPT, restart and re-watch. On GATE-FAILED, rotate first, then Fable → `.g4`.
6. At `HUMAN_GATE 2.9`, hand Michael `scripts/gate.sh 2.9 …` with the .dmg path read from `.evidence/ci/2.verify.g3h/accepted/macos-debug-dmg/`, and tell him the debug build binds WebDriver port 4445 while it runs.
7. Rotate before `PRINCIPAL 2.10.r0d`.

## Open Questions

- **For Michael (Phase 2 boundary):** register `tauri-plugin-wdio` so shell e2e stops paying about 6 s per command. Unchanged since 043.
- **For the boundary:** the embedded provider's input is synthetic, so re-read #045's "macOS required e2e runner on the embedded plugin" with that in hand (Fable's note from 046).
- **For the boundary:** #045 drops Windows. This is the third Windows-only gate failure in a row (compile errors, the test-harness manifest, now a rollback test). That is evidence for #045 in the diff Michael sees, but it does not waive this gate.
- **Boundary, only if a third occurs:** the stub-skip after a capped attempt, and background-and-wait on a long e2e. Both are still at two occurrences.

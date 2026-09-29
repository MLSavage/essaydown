# Handoff 047: Phase 2, `2.verify.g1h` GATE-FAILED at a1 (Windows cargo test only) → `PLAN-GATE plan.2.verify.g1h.r0`

Written 2026-09-27 by the principal: the Opus 5.5 session that watched `2.11` → `2.12` → `2.13` → `2.verify.g1` and ran the `2.verify.g1h` gate, in Claude Code on the Mac Mini. It supersedes `046-phase-2-verify-g1-repairs.md` (on `handoff/046`). This commit is on `handoff/047`, **stacked on `handoff/046`** → `045` → … → `040`, none of them in `phase/2`. `2.10.r0d` cherry-picks `phase/2..handoff/047` as one range. The next handoff is `048-*.md`.

## Current State

- **Branches.**
  - `phase/2` is at `2c5fe44` `task(2.verify.g1): …`, 223 commits, not on origin. New since 046: `989c592` 2.11, `313da8c` 2.12, `5e6d8c2` 2.13, `2c5fe44` 2.verify.g1.
  - `main` is at `92a2ec1`, unchanged.
  - Remote ci refs: `ci/2.verify.g1/a1` (at `2c5fe44`, pushed by this gate), `ci/2.verify/a1`, and the stale `ci/2.1/a1`. `scripts/gate.sh gc` cleans them whenever convenient.
- **Tasks.** `2.11` passed a1. `2.12` (opus) passed a2: a1 made a clean break with no DONE because its caret-to-end guard survived its own mutation, and the runner retried on its own. `2.13` passed a1. `2.verify.g1` passed a1.
- **Status.** `Phase 2, idle; last passed 2.verify.g1; gates open: none; plan requests: plan.2.verify.g1h.r0:pending; blocked: 2.verify.g1h:blocked`. `doctor` clean. Host checkout clean on `phase/2`. `.locks/` empty, no `ralph run` process.
- **Gate `2.verify.g1h` a1: GATE-FAILED.** This was ci.yml run 36300536766 at `2c5fe44`; evidence is in `.evidence/ci/2.verify.g1h/a1/`, and the failed-step log is `gh run view 36300536766 --log-failed`.
  - **Green:** all 3 `e2e-shell` legs (ubuntu, windows, macos), `macos-debug-dmg`, `test (ubuntu)`, `test (macos)`, and `merge-logs`. Every cause from `2.verifyh` a1 (F1–F5) is gone.
  - **The one failure: `test (windows-latest)` → `Cargo test`.** The build finishes. Then `Running unittests src\lib.rs (…desktop_lib-….exe)` exits with `0xc0000139, STATUS_ENTRYPOINT_NOT_FOUND` before any test runs. This is the first time the Windows lib test binary ever ran; at `2.verifyh` a1 it did not compile.
  - **Likely cause, unverified.** A Windows test executable that links tauri/wry gets no comctl32 v6 application manifest. `tauri_build` embeds the manifest only into the bin target, and the `desktop_lib` test harness then fails at load. `apps/desktop/src-tauri/build.rs` is a bare `tauri_build::build()`. The upstream-known workaround is `tauri_build::try_build(Attributes::new().windows_attributes(WindowsAttributes::new_without_app_manifest()))`, plus embedding the manifest for every target with linker args (`/MANIFEST:EMBED /MANIFESTINPUT:…`, `cargo:rustc-link-arg…`). Fable should verify this against the installed `tauri-build` source before it becomes the planned fix.
  - **The .dmg** was built and fetched: `.evidence/ci/2.verify.g1h/a1/macos-debug-dmg/EssayDown-debug-2c5fe44bae62714395f025a9e1e923603880948f.dmg`. It is from a failed attempt, so `2.9` takes the path from the *accepted* attempt of the next gate, not this one.
- **Runner.** Stopped at `HUMAN_GATE 2.verify.g1h`; tmux `essaydown:runner` pane 8940 is at `zsh`. The gate then emitted `GATE-FAILED 2.verify.g1h a1` and `PLAN-GATE plan.2.verify.g1h.r0` to its own output, not to runner.log. Restart after the planning commit integrates: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 2 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher.** Stopped at rotation. runner.log has 171,798 lines; start at 171799. The last `[ralph]` marker is `[ralph] 2.verify.g1 attempt 1`, and the last stop line is `HUMAN_GATE 2.verify.g1h`:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=171799; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  Arm it only after restarting the runner. At that point take `wc -l < .evidence/runner.log` again and start at that count + 1.
- **Expected next stop signal:** none until you act. You write the Fable brief and the planning commit on `plan.2.verify.g1h.r0`, then restart the runner. The runner then runs the repair task(s), `2.verify.g2`, and stops at `HUMAN_GATE 2.verify.g2h`.

## Corrections

- `046` (on `handoff/046`) expected the next stop to be `HUMAN_GATE 2.verify.g1h` followed by ACCEPT. It came, but the gate failed. `046`'s `phase/2` tip (`6adfec3`, 219) and its watcher start (166140) are stale.
- `046`'s next-prompt described step 4 as "the accepted .dmg path read from `.evidence/ci/2.verify.g1h/accepted/`". That directory does not exist, because a1 was not accepted. After the repair it becomes `.evidence/ci/2.verify.g2h/accepted/macos-debug-dmg/`, and `2.9`'s text names `2.verify.g1h`. The planning commit must rewire `2.9` (and `2.10.r0a/b/c`) to the new gate and update the path in `2.9`'s text, as `6adfec3` did for `2.verifyh` → `2.verify.g1h`.

## Decisions

- **No DECISIONS entry this block.** DECISIONS.md on `phase/2` still ends at #043; #044–#045 are on the stack. None of `2.11`–`2.verify.g1` touched DECISIONS.md (the 046 check is repeated by `git diff --stat 6adfec3 phase/2 -- docs/DECISIONS.md`, which should print nothing). So `handoff/047` stacks on `046` without a rebase.
- **No runner deviations.** No `retry`, no principal lesson; `2.12` a1 → a2 was the runner's own retry after a no-DONE attempt.
- **Windows is still in the acceptance.** #045 (drop Windows) takes effect only at the Phase 2 / Phase 3 boundary, after Michael sees the diff. This Windows failure is therefore a real gate failure and gets a `.g2` repair; it is not waived.

## Gotchas

- **The plan request id is `plan.2.verify.g1h.r0`**, as printed by the gate; the runner computes it from the count of existing requests. Run `ralph/ralph.sh plan plan.2.verify.g1h.r0`.
- **Scope the planning commit to the one failure.** Add one sonnet repair task (Windows test-binary manifest in `apps/desktop/src-tauri/build.rs`, or whatever Fable verifies), then `2.verify.g2` → gate `2.verify.g2h` (`ci/2.verify.g2/a{n}`), with the same acceptance as `2.verify.g1` (the .dmg under `…/2.verify.g2h/accepted/…`). Rewire `2.9` and `2.10.r0a/b/c` to `2.verify.g2h`.
- **The repair's acceptance has to be about Windows, which the container cannot run.** Linux `cargo test` stays green, and the container cannot claim a Windows pass. The honest acceptance is: the Linux suite is green, the change is gated `#[cfg(windows)]`/target-conditional where it applies, and the gate proves it. A build.rs change affects every target, so the task must keep macOS/Linux behaviour (the bin still gets its manifest on Windows, and nothing changes elsewhere).
- **Zero new dependencies** in a `verify` task. The repair task may touch build.rs only with crates already in the tree (`tauri-build` is).
- If the fix makes the Windows test binary load and then tests *fail* on Windows (the path/case-fold tests in `workspace.rs` have never run there), that is a `.g3` with its own evidence. Do not pre-empt it.
- A same-SHA `scripts/gate.sh rerun` is not appropriate here: `STATUS_ENTRYPOINT_NOT_FOUND` is deterministic, not a transient.

## Next Steps

1. At session start, run `status` (expected: idle, `plan.2.verify.g1h.r0:pending`), `doctor` (clean) and `git status --short` (empty).
2. **Fable brief** (PRINCIPAL.md trigger: `PLAN-GATE`). Cover the signal, the evidence (`.evidence/ci/2.verify.g1h/a1/`, run 36300536766 `--log-failed`, `apps/desktop/src-tauri/build.rs`, `Cargo.toml`, the installed `tauri-build` source under `~/.cargo/registry`), the hypothesis above, and one question: what is the minimal build.rs (or Cargo) change that makes the Windows `desktop_lib` test harness load, verified against the installed tauri-build? Answer format: decision, reasons, confidence, task text.
3. Run `ralph/ralph.sh plan plan.2.verify.g1h.r0`, and make the planning commit in `.wt/plan.2.verify.g1h.r0`. It contains the repair task, `2.verify.g2`, the gate `2.verify.g2h`, and the rewire of `2.9`/`2.10.r0a/b/c`, with EXPECTED_COUNT bumped. Put the promise only in the `wip(plan…)` commit message, with a concrete reversal line and no placeholder.
4. Restart the runner and arm the watcher at `wc -l` + 1.
5. At `HUMAN_GATE 2.verify.g2h`, run `scripts/gate.sh 2.verify.g2h` in the background. On ACCEPT, restart and re-watch. On GATE-FAILED, Fable → `.g3`.
6. At `HUMAN_GATE 2.9`, hand Michael `scripts/gate.sh 2.9 …` with the .dmg path read from `.evidence/ci/2.verify.g2h/accepted/macos-debug-dmg/`. Tell him the debug build binds WebDriver port 4445 while it runs.
7. Rotate before `PRINCIPAL 2.10.r0d`.

## Open Questions

- **For Michael (Phase 2 boundary):** register `tauri-plugin-wdio` so shell e2e stops paying about 6 s per command. Unchanged since 043.
- **For the boundary (Fable's note from 046):** the embedded provider's input is synthetic, so re-read #045's "macOS required e2e runner on the embedded plugin" with that in hand.
- **For the boundary:** #045 drops Windows. This is the second Windows-only gate failure in a row (`2.verifyh` a1 compile errors, now the test-binary manifest). That is evidence for #045 in the diff Michael sees, but it does not waive this gate.
- **Boundary, only if a third occurs:** the stub-skip after a capped attempt, and background-and-wait on a long e2e. Both are still at two occurrences.

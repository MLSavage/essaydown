# Handoff 056: Phase 2, `GATE-FAILED 2.verify.r2h` → `PLAN-GATE plan.2.verify.r2h.r0`

Written 2026-10-04 by the principal: the Opus 5.5 session that continued from 055. It ran the CI gate `2.verify.r2h`, which failed on macOS `cargo test`, and rotated at the gate's `ROTATE-PRINCIPAL`. It supersedes `055-phase-2-verify-r2-gate.md`.

This commit is on `handoff/056`, stacked on `handoff/055`, which is based on `phase/2` at `2ebde0c`. The next reconciliation (`2.10.r2d`) cherry-picks `phase/2..handoff/056`, or a newer stacked handoff. If the planning commit for `plan.2.verify.r2h.r0` appends to DECISIONS.md, rebase `handoff/055..056` onto the new `phase/2` tip from a temporary worktree (#039). The next handoff is `057-*.md`.

## Current State

- **Branches.**
  - `phase/2` is at `2ebde0c` `task(2.verify.r2): …`. It is not on origin (`ls-remote` is empty).
  - `main` is at `92a2ec1`, unchanged.
  - `handoff/040`–`056` exist. Delete them all after `2.close`.
- **Status:** `Phase 2, idle; last passed 2.verify.r2; gates open: none; plan requests: plan.2.verify.r2h.r0:pending; blocked: 2.verify.r2h:blocked`. `doctor` is clean. The host checkout is clean on `phase/2`. `EXPECTED_COUNT` is 320.
- **CI gate `2.verify.r2h` a1: GATE-FAILED.**
  - Run 37180485441 at `2ebde0c`, ref `ci/2.verify.r2/a1`. Evidence is in `.evidence/ci/2.verify.r2h/a1/`.
  - **The only failure is macOS `cargo test`: 74 passed and 4 failed** (`test-logs/test-logs-macos-latest/cargo-test.log:617-716`).
  - All four tests panic at `muda-0.19.3/src/platform_impl/macos/mod.rs:132:37`: "`muda::Menu` can only be created on the main thread". The four tests are:
    - `menu::tests::guard5_build_menu_under_mock_runtime_matches_the_spec_per_submenu`
    - `commands::tests::open_folder_then_list_tree_and_write_doc_round_trip_over_real_ipc`
    - `commands::tests::coach_key_value_never_crosses_ipc`
    - `commands::tests::set_coach_key_never_reaches_the_settings_file_on_disk`
  - Everything else is green:
    - Ubuntu `cargo test` 77/0, Windows 74/0.
    - `e2e-shell` 8/8 spec files on all three OSes.
    - lint and unit tests on all three OSes.
  - A dmg was built (`a1/macos-debug-dmg/EssayDown-debug-2ebde0c1a8faf615f0ac630c6cd3bcf9602e1b4e.dmg`) but not accepted. Gate 2.25 waits for the repair's accepted dmg.
- **Cause:** 2.24's macOS-only menu, under `cfg(target_os = "macos")`, is now built in cargo test threads.
  - guard 5 builds it under `MockRuntime`.
  - The three `commands` tests build an app that reaches the same menu path.
  - The Linux container never compiles that path, so 2.24's suite was green there. This is a code defect in the tests or the builder wiring, not a transient failure. A same-SHA rerun is refused (RUNNER-SPEC §2).
- **Runner.** It is not running. The tmux pane `essaydown:runner` (pid 8940) is at `zsh`. Restart it with `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 2 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher.** None is armed. runner.log has 197,747 lines. After the restart, take `wc -l < .evidence/runner.log` + 1 and arm this as a persistent Monitor (30-minute cap):
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=START; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  Replace `START` with the number. On every expiry, re-arm from the same start, run `status` and a catch-up grep, and filter out the task-start lines already reported.
- **Expected next stop signal:** none until the planning commit lands. After the restart, expect `HUMAN_GATE 2.verify.r2.g1h` (or whatever id the planning protocol gives the new gate).

## Corrections

- `055` Current State expected `2.verify.r2h human-pending` and an ACCEPT. That is superseded: the gate failed, so status is now `idle`, `plan.2.verify.r2h.r0:pending`, `2.verify.r2h:blocked`.
- `055` Gotchas and the 2.25 row in tasks.json point Michael at `.evidence/ci/2.verify.r2h/accepted/macos-debug-dmg/`. No such directory exists. The dmg for 2.25 comes from the repair's accepted gate (the row already says "or that of its latest repair").
- `055` says "a GATE-FAILED … A Windows-only failure is evidence for #045". This failure is macOS-only, so it is **not** #045 evidence.

## Decisions

- No new DECISIONS entry, no runner deviation, no retry since 055.
- The gate failure is a code failure. It needs a `.g1` repair through `ralph/ralph.sh plan`, not a rerun.

## Gotchas

- **Read the 2.24 diff first** (`b543604`, `apps/desktop/src-tauri/src/menu.rs` and `lib.rs`). Find how the `commands` tests reach menu construction: a shared builder, or `mock_builder` with the default menu. On macOS, muda panics off the main thread, and cargo's test harness runs each test on a worker thread.
- **Scope the repair to what failed** (#021, #039). Candidate shapes for Fable to weigh:
  - Keep the menu out of the test builder path.
  - Gate guard 5's `build_menu` leg as non-macOS, recording why. 2.24's acceptance already allowed "if it cannot, record why and guards (1)–(4) stand alone".
  - Run it on the main thread.
  - Whichever shape, **the production `Builder::menu` call stays** under `cfg(target_os = "macos")`. 2.25 proves it on Michael's Mac. Never `#[ignore]` or skip a test to get green (CLAUDE.md).
- **The container cannot prove the repair.** The `.g1` task's own suite runs on Linux, and only the new CI gate's macOS leg shows the repair works. The task text should say that the macOS pass is proven at the CI gate, not claimed.
- **Rewire `2.25` to depend on the new CI gate** in the planning commit. `2.10.r2a`/`r2b` keep depending on `2.25` (and on `2.verify.r2`; check whether they also need the new verify id, following the r1 pattern in `6d87fdd`).
- **Scratchpad logs are session-local.** For the full failing output, run `gh run view 37180485441 --log-failed > <scratchpad>/ci-failed.log`.
- **Never write the literal DONE promise** into any file an agent reads.

## Next Steps

1. Run `status` (expected: idle, `plan.2.verify.r2h.r0:pending`), `doctor` (clean) and `git status --short` (empty). Give Michael the one-line state.
2. **Fable brief** (trigger: `PLAN-GATE`), written:
   - **Signal:** `GATE-FAILED 2.verify.r2h a1` → `PLAN-GATE plan.2.verify.r2h.r0`.
   - **Evidence paths:**
     - `.evidence/ci/2.verify.r2h/a1/test-logs/test-logs-macos-latest/cargo-test.log` (lines 617-716)
     - `apps/desktop/src-tauri/src/menu.rs` and `lib.rs`
     - the `commands` test module
     - the 2.24 diff `b543604`
     - the 2.24 row and journal entry
   - **What was tried:** nothing; this is gate attempt 1.
   - **One question:** what is the minimal `.g1` repair that makes macOS `cargo test` green? It must keep the production macOS menu and guards (1)–(4), and it must not skip a test. Which guard 5 shape is right?
   - **Answer format:** decision, reasons, confidence, and the task text with acceptance.
3. Run `ralph/ralph.sh plan plan.2.verify.r2h.r0`, then make the planning commit in `.wt/plan.2.verify.r2h.r0`, following `6d87fdd` (the r1 `.g1` plan):
   - Add the repair task (`2.verify.r2.g1`, or the id the protocol gives) and its CI gate.
   - Rewire `2.25` to the new gate.
   - Update `EXPECTED_COUNT` from 320, read from the rows you add.
   - The promise goes only in the `wip(plan…)` message. The reversal is `ralph/ralph.sh plan-abandon plan.2.verify.r2h.r0 --reason "planning change for 2.verify.r2h withdrawn"`.
   - If the planning commit appends to DECISIONS.md, rebase `handoff/055..056` (#039).
4. Restart the runner and arm the watcher at `wc -l` + 1.
5. At the new CI gate's `HUMAN_GATE`, run `scripts/gate.sh <gate>` in the background, redirected to a scratchpad file.
   - On GATE-FAILED, rotate first, then brief Fable again.
   - On ACCEPT, restart the runner. Expect `HUMAN_GATE 2.25`. Give Michael:
     - the accepted dmg path;
     - its sha256 (`shasum -a 256`);
     - the five checks verbatim from the 2.25 row;
     - once he reports, the finished command `scripts/gate.sh 2.25 --outcome ACCEPT|REJECT --payload artifact_sha=… --payload dmg_sha256=… --payload check1=… … --note "…"` with his real values (#019; the form follows `.evidence/human/2.9/accepted.json`).
6. After 2.25 ACCEPT, restart the runner and watch `2.10.r2a` (claude) and `2.10.r2b` (sol).
7. At `PRINCIPAL 2.10.r2d`, rotate. The fresh session:
   - cherry-picks `phase/2..handoff/NNN`;
   - briefs Fable;
   - appends 2.25's accepted record as `#010-mac-quit-check`;
   - applies #041 D1.
8. At `2.close`, bring Michael the Open Questions.

## Open Questions

- **For Michael, at 2.25:** the five manual checks, on the repair's dmg.
- **For Michael (Phase 2 / 3 boundary), unchanged from 055:**
  - #045's drop-Windows diff, with this phase's Windows-only gate failures as evidence. This gate's failure is macOS-only and does not count.
  - `tauri-plugin-wdio` (U25).
  - The U9 robustness test-only task.
  - Which of the 35 re-pointed hard stops become Phase 3 tasks.
  - The settings directory (U16).
  - Shift+Enter.
  - #045's "macOS required e2e runner on the embedded plugin".
  - The background-and-wait pattern at four occurrences (evidence: 2.19 a2, and 2.22 a2's `.evidence/tasks/2.22/2.log`).
- **New, for the boundary:** a platform-gated Rust path (here `cfg(target_os = "macos")`) is never compiled by the Linux container, so its tests first run at the CI gate. This is the first gate failure of that class. Should a task that adds a `cfg(target_os)` branch say so in its acceptance, or is the CI gate enough? Count further occurrences before proposing a rule.

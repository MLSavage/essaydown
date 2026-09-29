# Handoff 046: Phase 2, `2.verifyh` GATE-FAILED → repairs `2.11`–`2.13` + `2.verify.g1` running

Written 2026-09-27 by the principal. This was the Opus 5.5 session that ran the `2.verifyh` gate, took its `PLAN-GATE` through a Fable consult to the planning commit, and restarted the runner, in Claude Code on the Mac Mini. It supersedes `045-phase-2-verify-gate.md` (on `handoff/045`, not in the tree). This commit is on `handoff/046`, **stacked on `handoff/045`** → `044` → `043` → `042` → `041` → `040`, none of them in `phase/2`. `2.10.r0d` cherry-picks `phase/2..handoff/046` as one range. The next handoff is `047-*.md`.

## Current State

- **Branches.**
  - `phase/2` is at `6adfec3` `plan(plan.2.verifyh.r0): planning commit for 2.verifyh (GATE-FAILED at a1)`, 219 commits, not on origin.
  - `main` is at `92a2ec1`, unchanged.
  - Remote `ci/2.verify/a1` was pushed by the gate. Remote `ci/2.1/a1` is still stale. `scripts/gate.sh gc` cleans both whenever convenient.
- **Status.** `Phase 2, 2.11 running; last passed 2.verify; gates open: none; plan requests: none; blocked: none`. `doctor` clean; host checkout clean on `phase/2`.
- **Gate `2.verifyh` a1: GATE-FAILED.** ci.yml run 36292723305 at `5c086c6`; evidence in `.evidence/ci/2.verifyh/a1/`. Ubuntu was green on every job (e2e 6/6 specs). This was the first macOS/Windows run of 2.2–2.8 code (`2.1.g1h` ran no cargo tests). It had five causes:
  - Windows `cargo test` does not compile: `workspace.rs` has unix-only tests without `#[cfg(unix)]`.
  - macOS `cargo test` does not compile: `_EMBED_INFO_PLIST` is defined twice, because `generate_context!` expands in both `lib.rs` `run()` and `commands.rs` `test_app()`.
  - Windows e2e: `browser.execute(() => location.reload())` hangs the before-all hook of 4 specs on the embedded provider.
  - Embedded-provider input is synthetic. The F2 rename gives `'a.mdb.md'` on Windows and macOS, and typed text never reaches the doc on macOS.
  - No workflow produces `macos-debug-dmg`, and `gate.mjs:127` refuses a missing artifact.
- **Plan request.** `plan.2.verifyh.r0` is resolved: `wip` commit `50d2633` on `plan/2.verifyh/r0`, integrated as `6adfec3`. The request id was `.r0`; handoff 045 had guessed `.r1`. EXPECTED_COUNT 287 → 292. It added:
  - `2.11` (sonnet): Rust test portability, covering the `#[cfg(unix)]` gating and one `pub(crate) fn context()`. It depends on the superseded `2.verifyh`, which is satisfied for appended fix tasks.
  - `2.12` (**opus**): `e2e/shell/test/routes.ts`, provider-keyed embedded routes (`browser.refresh()`, Range caret-to-end, `addValue`, `setValue`). Its acceptance is green on both container legs (`ESSAYDOWN_E2E_DRIVER=embedded`).
  - `2.13` (sonnet): a ci.yml job `macos-debug-dmg` (native aarch64, `tauri build --debug --bundles dmg`, uploads `EssayDown-debug-${GITHUB_SHA}.dmg`).
  - `2.verify.g1` → gate `2.verify.g1h` (`ci/2.verify.g1/a{n}`). Its acceptance: suite green ×3 OS, every shell spec green on ubuntu + windows (macOS recorded), and the .dmg at `/logs/ci/2.verify.g1h/accepted/macos-debug-dmg/EssayDown-debug-<sha>.dmg`.
  - Rewired: `2.9` → `2.verify.g1h` (path in its text updated); `2.10.r0a/b/c` → `2.verify.g1h`, `2.9`.
- **Runner.** Restarted in tmux `essaydown:runner` (pane pid 8940, now `node`). It integrated the plan and started `[ralph] 2.11 attempt 1 (loop, sonnet, max-turns 80) in …/.wt/2.11`. Restart command after a stop: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 2 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher.** Stopped at rotation. runner.log had 166,139 lines at rotation; start at 166140. The `2.11` start marker is at an earlier line, so a restart at 166140 does not repeat it:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=166140; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  Use a persistent `Monitor` with a 30-minute cap. On every expiry, re-arm it and run `status` plus a catch-up grep from 165380. Last marker: `[ralph] 2.11 attempt 1`.
- **Expected next stop signal:** `HUMAN_GATE 2.verify.g1h`, after `2.11` → `2.12` → `2.13` → `2.verify.g1`. Any `STUCK`/`NO-JOURNAL` on the way follows the next-prompt constraints.

## Corrections

- `045` (on `handoff/045`) named the plan request `plan.2.verifyh.r1`. The runner computes `r<n>` from the count of existing requests, so the first is `.r0`.
- `045` said `gate.sh 2.9` "installs the .dmg". It does not: 2.9 is an observation gate, so Michael installs the .dmg by hand, and `gate.sh 2.9 --outcome …` only records the result. The .dmg path is now under `2.verify.g1h`, not `2.verify`.
- `045`'s `phase/2` tip (`5c086c6`, 218), its runner.log count (165,379) and its expected next stop (`HUMAN_GATE 2.9`) are stale.

## Decisions

- **No DECISIONS entry this block.** DECISIONS.md on `phase/2` still ends at #043; #044–#045 are on the stack.
- **The stack was not rebased.** The #039 rebase exists for a planning commit that itself appends to DECISIONS.md. `6adfec3` touches only PRD.md, tasks.json and EXPECTED_COUNT (`git diff --stat 5c086c6 phase/2 -- docs/DECISIONS.md` is empty), so `phase/2..handoff/046` cherry-picks without conflict. `handoff/040`–`045` refs are kept.
- **Fable consult on `PLAN-GATE`** (PRINCIPAL.md trigger), with a written brief; Fable made no edits. It verified the causes from the evidence and from the upstream provider's source (`tauri-plugin-wdio-webdriver` executor: every input is synthetic JS, and `execute/sync` polls a window variable that a reload wipes). It chose four sequential tasks over one, and put F4 in scope because Windows shows it too. Its confidence: F1 high; F2 high on cause and medium-high on the shared-`context()` route; F3 medium, because WebView2's behaviour under `refresh()` has not been observed; F4 medium-high; F5 medium (bundler flake).
- **Michael:** his MacBook Pro is Apple silicon, so `2.13` builds native aarch64, not universal.
- **Principal slip:** the first `wip(plan…)` message had a `<why>` placeholder in its reversal command. It was amended before push (no remote `plan/*` refs), so the integrated message has concrete text.

## Gotchas

- **If `2.verify.g1h` shows Windows still hanging on `browser.refresh()`**, that is the next `PLAN-GATE` (Fable trigger). Fable's named route is `reloadSession()` after a read-back settle of the localStorage write. `2.12` was told not to choose it.
- **`2.13`'s bundle step** (hdiutil/osascript in `bundle_dmg.sh`) is a known transient on GitHub runners. A failure with no code cause is `scripts/gate.sh rerun 2.verify.g1h` (same SHA). Anything else is a `.g2`.
- **At `HUMAN_GATE 2.9`, tell Michael** that a `--debug` build registers the WebDriver plugin unconditionally (`apps/desktop/src-tauri/src/lib.rs:23–24`). It binds port 4445 locally while the app runs; this is harmless for his test but worth knowing.
- `2.12` is an opus task with two e2e legs in the container, so it is the likeliest to cap. The background-and-wait count is still two (`2.4` r0 a3, `2.8` a2); its description says one foreground call bounded by `timeout`. The stub-skip count is still two.
- The gate fetches artifacts on failure too, so failed-run evidence is in `.evidence/ci/<gate>/a<n>/`. `gh run view <id> --json jobs` names the failing steps.

## Next Steps

1. At session start, run `status` (expected: `2.11`, `2.12`, `2.13` or `2.verify.g1` running, or `2.verify.g1h human-pending`), `doctor` (clean), and `git status --short` (empty). Re-arm the watcher above.
2. For each stop until the gate, follow the constraints: `STUCK`/`NO-JOURNAL` get a principal lesson or a `retry` per #027/#038.
3. At `HUMAN_GATE 2.verify.g1h`, run `scripts/gate.sh 2.verify.g1h` in the background and read its output file.
   - **ACCEPT:** restart the runner and re-arm the watcher.
   - **GATE-FAILED:** write a Fable brief, then `ralph/ralph.sh plan plan.2.verify.g1h.r0` → `2.verify.g2`, scoped to what failed.
4. At `HUMAN_GATE 2.9`, hand Michael `scripts/gate.sh 2.9 …` with the accepted .dmg path read from `.evidence/ci/2.verify.g1h/accepted/`, and mention port 4445.
5. Rotate before `PRINCIPAL 2.10.r0d`. A fresh session runs the reconciliation (Fable on the decisions) and cherry-picks `phase/2..handoff/NNN`.

## Open Questions

- **For Michael (Phase 2 boundary, with #045's Windows change):** register `tauri-plugin-wdio` so shell e2e stops paying about 6 s per command. Unchanged from 043–045.
- **For the boundary (Fable's note, not yet a DECISIONS entry):** on the embedded provider every event is synthetic by construction. The embedded leg proves DOM → ProseMirror → store → disk, and only the Linux external leg proves native input. Re-read #045's "make macOS a required e2e runner on the embedded plugin" with this in hand before the boundary diff goes to Michael.
- **Boundary, only if a third occurs:** the stub-skip after a capped attempt, and background-and-wait on a long e2e. Both are still at two occurrences.

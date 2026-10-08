# Handoff 078: Phase 4, 4.1 passed → `INTEGRATION-FAILED 4.2` (sidecar binaries missing on a clean checkout)

Written 2026-10-07 by the principal, the Opus 5.5 session that continued from 077. It watched 4.1 pass on attempt 3 after a principal lesson. It then saw 4.2 stop `INTEGRATION-FAILED`, diagnosed the failure, and rotated before designing the repair. This handoff supersedes `077-phase-4-running-4.1.md`.

This handoff is committed on `handoff/078`, stacked on `handoff/077`. Neither branch is in `phase/4` yet. The runner is idle but mid-phase, so this is not a boundary, and the commit stays off `phase/4`. Read the handoff with `git show handoff/078:docs/handoffs/078-phase-4-integration-failed-4.2.md`. The next handoff is `079-*.md`, stacked on `handoff/078`.

## Current State

- **Branches.**
  - `main` is at `8aba511`, the same as origin.
  - `phase/4` is at `792adc9` (`task(4.1)`), 1 commit ahead of `origin/phase/4` (`7be39d4`). Michael pushed `7be39d4` this block. Hand him `git push origin phase/4`.
  - `handoff/077` → `handoff/078` (this commit) are stacked on `7be39d4`. Reconciliation `4.5.r0d` cherry-picks both. Delete both after `4.close`.
- **Status:** `Phase 4, idle; last passed 4.1; gates open: none; plan requests: none; blocked: 4.2:integration-failed`. `doctor` is clean.
- **Passed this block:** 4.1 `792adc9`, on attempt 3.
  - Attempt 1 hit the turn cap (81 turns); the runner's recovery commit swept up its work.
  - Attempt 2 was `NO-JOURNAL`: it completed attempt 1's stub instead of appending its own line.
  - Before attempt 3 the principal committed lesson `834d87f` on `task/4.1`.
- **4.2 `integration-failed`, after 2 attempts:**
  - Attempt 1 hit the turn cap (81 turns).
  - Attempt 2 succeeded in 72 turns and printed DONE.
  - The branch tip is `b2f47eb` in `.wt/4.2`; the branch diff is 14 files, +757.
  - Logs: `.evidence/tasks/4.2/1.log` and `2.log`.
- **Runner:** stopped. Pane `essaydown:runner` (pid 8940) is at `zsh`.
  - Restart line, only after 4.2 is repaired and retried: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 4 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher:** stopped at rotation. Re-arm it as a persistent Monitor (30-minute cap) with `start=275135`. Skip the 16 raw lines already reported (the last one is `INTEGRATION-FAILED 4.2`) with `NR<=16 { seen[$0]=1 }`. Re-grep that count before you arm, because the raw count without dedup is what `NR` compares against:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=275135; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk 'NR<=16 { seen[$0]=1 } !seen[$0]++ { print; fflush() }'
  ```
- **Expected next stop:** none until 4.2 is retried. After the retry, the next stop is `HUMAN_GATE 4.2h`.

## The 4.2 failure (diagnosis, read from the evidence)

- **The candidate's `cargo test` fails in the desktop build script.**
  - The error: `resource path \`binaries/pandoc-aarch64-unknown-linux-gnu\` doesn't exist`.
  - It is in `.evidence/runner.log`, just above the `INTEGRATION-FAILED 4.2` line, at the end of the file.
- **Cause 1: the binaries exist only in the task worktree.**
  - 4.2 added `"externalBin": ["binaries/pandoc", "binaries/typst"]` to `tauri.conf.json`.
  - `tauri-build` requires the file for the current target triple at every build, including `cargo test` and dev builds.
  - 4.2 also gitignored `apps/desktop/src-tauri/binaries/`.
  - `pnpm fetch-sidecars && pnpm assemble-sidecars` regenerates that directory. Nothing runs those two steps in a fresh checkout: not the runner's candidate, not `scripts/check`, and not CI.
- **Cause 2: the container is arm64, which the lock does not cover.**
  - The container is `aarch64-unknown-linux-gnu` (host `uname -m` = arm64, image arch arm64).
  - 4.1's `scripts/sidecars.lock.json` covers only x86_64 Linux, x86_64 Windows and the two macOS slices.
  - Attempt 2's `assemble-sidecars.ts` (`writeAarch64LinuxDevStandIn`) writes 192-byte text stand-ins for `pandoc-aarch64-unknown-linux-gnu` and `typst-aarch64-unknown-linux-gnu`.
  - Those stand-ins are only in `.wt/4.2/apps/desktop/src-tauri/binaries/`, which is gitignored.
- **The same break reaches CI.** The existing jobs `test`, `e2e-shell` and `macos-debug-dmg` all run `cargo build` from a fresh checkout. They will fail the same way at `4.2h`. The new `tauri-build` job is the only one that fetches and assembles first.
  - The ci.yml comment that the existing jobs "already exercise" Linux externalBin is wrong.
- **Downstream need.** A stand-in can't spawn, so with stand-ins the next two tasks cannot pass in the container:
  - 4.3's integration test exports `essay-fixture` through the Rust `export` command.
  - 4.4 runs PDF/EPUB export and the one-workflow steps 1–7 in the container under xvfb.
  - Both need a real pandoc and typst at the container's host triple.

## Corrections

- **077, Current State "Running: 4.1 attempt 1":** stale. 4.1 passed on attempt 3 (`792adc9`).
- **077, Current State "`phase/4` … 7 commits ahead":** stale. Michael pushed. It is now 1 ahead (`792adc9`).
- **077, Current State "Expected next stop: `HUMAN_GATE 4.2h`":** stale. The actual stop was `INTEGRATION-FAILED 4.2`.
- **`.wt/4.2` ci.yml comment on the `tauri-build` job:** wrong, as described above. Whoever repairs 4.2 corrects it.

## Decisions

- **No DECISIONS entry and no runner deviation this block.**
- **Principal lesson `834d87f` on `task/4.1`** (`docs/lessons.md` only).
  - It was the #038 "remaining steps with call costs" form, and attempt 3 passed on it.
  - Reverse: `git revert` it on `task/4.1`. Moot now that 4.1 has integrated.

## Gotchas

- **`INTEGRATION-FAILED` takes `ralph/ralph.sh retry 4.2`.**
  - `retry` resets the task to `pending` with `attempts: 0` (`ralph/lib/doctor.mjs` `retry`) and has no reverse transition.
  - Move `.evidence/tasks/4.2/1.log` and `2.log` aside with a suffix first (#027).
  - This is the first retry of 4.2, so it needs no DECISIONS entry (#038 requires one only for a second retry).
- **Read a candidate failure on a fresh checkout.** A task's own green suite proves nothing about gitignored generated inputs. The candidate worktree `/work/.wt/candidate-<id>` is the clean-checkout test.
- **The raw grep count, not the deduped count, is what `NR<=k` must use.** It was 16 raw (16 unique) at rotation.
- **4.2 legitimately adds one Rust crate, `tauri-plugin-shell`.** It is in PRD §4's Rust crates row, and attempt 2 added its `docs/dependencies.json` entry.

## Next Steps

1. Run `status` and `doctor`. Hand Michael `git push origin phase/4` (1 ahead). Re-arm the watcher as above.
2. **Put the 4.2 repair decision to Michael before any retry** (Open Questions). Then write the principal lesson for the chosen option on `task/4.2` in `.wt/4.2`, as `chore(4.2): principal lesson …` touching `docs/lessons.md` only, with the reversal in the message.
   - The lesson orients and never widens scope (#028). The acceptance binds: "`pnpm tauri build` succeeds in the container and the Linux app contains the Linux binaries", and the suite is green on a clean checkout.
   - The lesson tells the agent three things:
     - append a NEW `- [4.2] ` journal line (`node ralph/journal.mjs stub 4.2`);
     - prove green from a clean state with `git clean -fdX apps/desktop/src-tauri/binaries`, then `scripts/check`;
     - fix every ci.yml job that builds cargo.
   - Then:
     - move `.evidence/tasks/4.2/1.log` and `2.log` aside with a suffix;
     - run `ralph/ralph.sh retry 4.2`;
     - run `doctor`;
     - restart the runner.
   - `sync-state` is not needed, because `tasks.json` is unchanged.
3. Handle each later stop: `HUMAN_GATE 4.2h` (`scripts/gate.sh 4.2h` in the background), then 4.3, 4.4, `HUMAN_GATE 4.verifyh`, and review set `4.5`. `PRINCIPAL 4.5.r0d` is run by a fresh session that cherry-picks `handoff/077..handoff/078` (and any later stacked handoff) first.

## Open Questions

- **For Michael: how a clean checkout gets the host-triple sidecars.** My recommendation is option A.
  - **(A) Recommended.**
    - Add the two aarch64-Linux artifacts to `scripts/sidecars.lock.json` as dev-only targets, not distributables: pandoc `linux-arm64` tarball, typst `aarch64-unknown-linux-musl`.
    - Make `scripts/check`'s cargo step and every ci.yml job that builds cargo run `pnpm fetch-sidecars && pnpm assemble-sidecars --host` first. `--host` assembles only the current triple, so a fresh checkout downloads 2 archives, not 8.
    - Put the archive cache outside the worktree (an env var, defaulting to `scripts/.cache/`), so candidate worktrees reuse it.
    - The cost is network access on the first build of each cache.
    - This is the only option under which 4.3 and 4.4 can spawn a real pandoc in the container. It adds no new dependency (same tools, same versions), but it touches 4.1's lock file. Passed-task files are not frozen (#016).
  - **(B)** Move `externalBin` into a bundle-only config (`tauri build --config …`), so `cargo test` and dev builds need nothing.
    - It is simpler for 4.2, but the debug app cannot resolve a sidecar, so 4.3 and 4.4 would need a second spawn path. That is worse, because it defers and doubles the same problem.

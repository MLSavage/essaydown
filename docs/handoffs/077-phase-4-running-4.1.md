# Handoff 077: Phase 4 running, 4.0r decided (#004) → 4.1 in flight

Written 2026-10-07 by the principal, the Opus 5.5 session that continued from 076. It restarted the runner on Phase 4, watched 4.6–4.10 and 4.0 pass, ran gate `4.0h` (ACCEPT), and wrote the SPIKE decision `4.0r` (#004). It rotated at the end of that stop-signal block, while 4.1 runs. This handoff supersedes `076-phase-4-boundary-planned-start-4.6.md`.

This handoff is committed on `handoff/077`, cut from `phase/4` at `7be39d4` from a temporary worktree, because the runner is live (#017). Read it with `git show handoff/077:docs/handoffs/077-phase-4-running-4.1.md`. The next handoff is `078-*.md`, stacked on `handoff/077` while that branch is not yet in `phase/4`.

## Current State

- **Branches.**
  - `main` is at `8aba511`, the same as origin.
  - `phase/4` is at `7be39d4` (`task(4.0r)`), 7 commits ahead of `origin/phase/4` (`4a6f110`). Hand Michael `git push origin phase/4`.
  - `handoff/077` (this handoff) is one commit on top of `7be39d4`. The next reconciliation (`4.5.r0d`) cherry-picks it. Delete it after `4.close`.
- **Status:** `Phase 4, 4.1 running; last passed 4.0r; gates open: none; plan requests: none; blocked: none`. `doctor` is clean.
- **Passed this block, all on attempt 1:**
  - 4.6 `6e6b80a`
  - 4.7 `8004767`
  - 4.8 `852adb0` (4 files)
  - 4.9 `1f1ba2e` (9 files, +1044; a product change)
  - 4.10 `de39b75`
  - 4.0 `11cdbe9`
  - `4.0h` ACCEPT a1 (run 37612096346)
  - 4.0r `7be39d4`
- **Running:** `4.1 attempt 1 (loop, sonnet, max-turns 80)` in `.wt/4.1`.
- **Remaining chain:** 4.1 → 4.2 (`needsCI`, gate `4.2h`) → 4.3 → 4.4 → 4.verify (gate `4.verifyh`) → review set `4.5` (`4.5.r0a/b/c`, reconciliation `4.5.r0d`) → `4.close` (next phase **6**).
- **Runner:** live in pane `essaydown:runner` (pane pid 8940, `node`).
  - Restart, only after it stops: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 4 2>&1 | tee -a .evidence/runner.log' Enter`.
  - The runner exits at every `HUMAN_GATE` and `PRINCIPAL` stop. After the gate or the principal commit, run `doctor`, then restart it.
- **Watcher:** stopped at rotation. Re-arm it as a persistent Monitor (30-minute cap) with `start=275135`, the Phase 4 restart line. Skip the 10 lines already reported (the last one is `[ralph] 4.1 attempt 1 …`) with `NR<=10 { seen[$0]=1 }`. Re-grep that count before you arm, because it grows if a signal fired between rotations:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=275135; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk 'NR<=10 { seen[$0]=1 } !seen[$0]++ { print; fflush() }'
  ```
  - Get the count with `tail -n +275135 .evidence/runner.log | grep -E '<same pattern>' | awk '!s[$0]++' | wc -l`.
  - On every expiry: re-arm it with the new count, run `status`, and grep from the same start.
- **Expected next stop:** `HUMAN_GATE 4.2h`, after 4.1 and 4.2 pass. Run `scripts/gate.sh 4.2h` in the background and read its output file.

## Corrections

- **076, Current State "`phase/4` is at this rotation commit … unpushed":** stale. Michael pushed it; `origin/phase/4` = `4a6f110`.
- **076, Next Steps 1–3:** done (restart, watcher, `4.0h`, `4.0r`).
- **076, Gotchas, the 4.0r evidence path `.evidence/ci/4.0/accepted/`:** wrong. The gate writes under the gate id: `.evidence/ci/4.0h/accepted/` → `a1`, with `accepted.json` one level up. #004 records this as the deviation 23 reading.

## Decisions

- **#004-pdf-pipeline** (in `7be39d4`):
  - The primary pipeline runs on all three OSes, and the fallback is not built. The command is `pandoc -f gfm --resource-path=<docdir> --pdf-engine=typst`, with pandoc 3.11 and typst 0.15.1.
  - Each OS has `route.txt` = `primary`, two `pdfimages -list` rows (pasted per OS) and an empty pandoc log.
  - The macOS leg was arm64 only, so the x86_64 slices were not exercised.
  - Lesson [4.0]: pandoc exits 0 on an unresolved image, so 4.4 reads the embedded count, not the exit status. This orients 4.4; it does not widen its scope.
  - It was not a Fable trigger. `spike-pdf.yml` was deleted in the same commit. The integrated subject is `task(…)`, so doctor's principal-deletion check skips it.
- **No runner deviation this block.**

## Gotchas

- **`scripts/gate.sh` takes the gate id (`4.2h`), not the task id.** `gate.sh 4.0` refused with "4.0 is not a human gate" and changed nothing.
- **An interactive-principal commit needs its own `- [<id>] ` journal line in the same commit.** It must carry the DONE promise in the commit message only. The runner then runs the full suite before integrating, which takes several minutes.
- **4.2 is `needsCI`.** Its gate pushes `ci/4.2/a<n>`; read `.evidence/ci/4.2h/`.
- `4.close` goes to **phase 6**, not 5.
- The host has no pandoc. Use `docker run --rm -i --entrypoint pandoc essaydown-dev:0.0 -f gfm -t html < file`.

## Next Steps

1. Run `status` and `doctor`, and re-arm the watcher as described above. Hand Michael `git push origin phase/4` if `git rev-list --count origin/phase/4..phase/4` is non-zero.
2. Handle each stop signal:
   - `HUMAN_GATE 4.2h`: run `scripts/gate.sh 4.2h`, then `doctor`, then restart.
   - `HUMAN_GATE 4.verifyh`: the verifier gate (rotate here, and per #029 the handoff stays on `handoff/NNN`).
   - Review set `4.5`: after it, `PRINCIPAL 4.5.r0d` is run by a fresh session, which cherry-picks `handoff/077` (and any later stacked handoff) first.
3. Rotate at every stop signal that ends a working block, and before context passes about 150k.

## Open Questions

- None for Michael.

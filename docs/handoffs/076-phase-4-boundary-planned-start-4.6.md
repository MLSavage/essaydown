# Handoff 076: Phase 3 closed, Phase 4 planned (#059) → start at 4.6 (fresh session)

Written 2026-10-07 by the principal, the Opus 5.5 session that continued from 075. It ran the reconciliation `3.7.r3d` (verdict PASS, `#review-3-r3`), watched `3.close`, raised the boundary questions, and made the Phase 4 boundary planning commit (#059) on `phase/4`. It rotated at the idle boundary on Michael's "Go: rotate, then restart Phase 4 and arm the watcher in the fresh session". This handoff supersedes `075-phase-3-r3-reviews-done-principal-r3d.md`.

This handoff is committed on the host checkout on `phase/4` (idle boundary, #017, #059). There is no `handoff/NNN` branch. The next handoff is `077-*.md`.

## Current State

- **Branches.**
  - `main` is at `8aba511` (the Phase 3 close), the same as origin.
  - `phase/3` is at `8aba511`, the same as origin. It is closed; never commit there again.
  - `phase/4` is at this rotation commit, on top of `7c0d175` (#059, pushed). The rotation commit is unpushed: hand Michael `git push origin phase/4`.
  - `handoff/061`–`075` are deleted (none was on origin; every file is on `phase/3`).
- **Status:** `Phase 4, idle; last passed 3.close; gates open: none; plan requests: none; blocked: none`. `doctor` is clean. `sync-state` has run (380 tasks, 5 added), and `ralph/ralph.sh run --phase 4 --dry-run` printed `next: 4.6 (loop, opus) on task/4.6 from phase/4`.
- **Passed since 075:** `3.7.r3d` (reconciliation, PASS) and `3.close` (`CLOSED 3 main 8aba511 next phase/4`, then the COMPLETE line).
- **The Phase 4 chain** (PRD §8, #059): 4.6 (`\|` in a cell, opus) → 4.7 (URL literal spans: C2, C13, the r3 guard; opus) → 4.8 (source burst during an awaited flush, reproduce first; opus) → 4.9 (§6.2 occurrence-shift, reproduce first; opus) → 4.10 (coverage glob, sonnet) → 4.0 (PDF spike, `needsCI`, gate `4.0h`) → 4.0r (interactive-principal: DECISIONS #004 pdf pipeline) → 4.1 → 4.2 (`needsCI`, gate `4.2h`) → 4.3 → 4.4 → 4.verify (gate `4.verifyh`) → review set `4.5` (`4.5.r0a/b/c`, reconciliation `4.5.r0d`) → `4.close` (next phase **6**, `phase/6`).
- **Runner:** idle, pane `essaydown:runner` (pid 8940) at `zsh`. `.locks/` is empty, and no `ralph run` process is running. runner.log is 275134 lines at rotation.
  - Restart: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 4 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher:** stopped. After the restart, arm a persistent Monitor (30-minute cap). Set `start=` to `wc -l < .evidence/runner.log` + 1, read at restart:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=START; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  - `START` is the number you compute. Write the digits in, never the word.
  - When re-arming mid-block, skip the lines already reported with awk (`NR<=k { seen[$0]=1 }`), where `k` is a count you grepped.
- **Expected next stop:** `HUMAN_GATE 4.0h` after 4.6–4.10 and 4.0 pass (run `scripts/gate.sh 4.0h`, backgrounded, and read its output file). A reproduce-first task (4.8, 4.9) can pass with no product change; that is a success, not a stop. Then `PRINCIPAL 4.0r`.

## Corrections

- **075, Current State "`phase/3` is at `1508473`" and next-prompt's "a principal commit goes on the host checkout on `phase/3` (#017)":** stale. Phase 3 is closed. At an idle boundary, a principal commit goes on the **new** phase's branch (`phase/4` now). #017's "phase/3" was written when `phase/3` was the new branch (#059 records this).
- **075, Next Steps 2–3:** done (`3.7.r3d` PASS, `3.close` CLOSED).

## Decisions

- **`#review-3-r3`** (in `3.7.r3d`'s integrated commit): verdict **PASS**.
  - Claude and Sol both reported 0/0/0 and confirmed C15 fixed by 3.28.
  - `WARN 3.7.r3b` is a mention: Sol's transcript line 1108 is the `3.7.r3a` row of a `ralph/tasks.json` dump.
  - Fable's brief: Claude's risk 2 (a `\`-terminal literal beside a typed `|`) is reachable as a tree but not as wrong bytes. `settleLiterals` writes the resource form, the row keeps two cells, and the output is the same at `main`. It became one backlog line (`[review-3-r3, …]`).
  - Three lessons recorded, none promoted.
- **#059** (`7c0d175`, Michael's answers, quoted verbatim there):
  - Five tasks before `4.0`, and `4.0` now depends on `4.10`.
  - The both-legs e2e rule is now a CLAUDE.md/AGENTS.md code rule and a clause in the acceptance of 4.4, 4.8 and 4.9.
  - `4.verify` gains the listing of its backlog hard stops.
  - G1, U26/G6, 3.26's list (none taken) and the autosave `:91` trigger stay on the backlog, with hard stop `4.verify`.
  - `EXPECTED_COUNT` 380.
- **No runner deviation this block.**

## Gotchas

- **#017 order: doctor before staging.** At #059, `git add` ran before `doctor`, so doctor's stale-index check reported 1 finding (my own staged diff on a runner-owned branch). The commit was verified (7 files, no deletions), but the order is doctor first, then stage.
- **4.0r is interactive-principal** (the SPIKE decision, DECISIONS #004). It is yours: read `/logs/ci/4.0/accepted/` (host `.evidence/ci/4.0/accepted/`), write `#004-pdf-pipeline` with the `pdfimages -list` lines, and delete `.github/workflows/spike-pdf.yml` in the same commit. It also needs its own `- [4.0r] ` journal line in that commit (`run.mjs:226`). Check whether it is a Fable trigger in PRINCIPAL.md before calling one.
- **4.6 and 4.7 change bytes that passed tasks' guards assert** (3.27, 3.28). This is allowed (#016), and the task text asks for a per-guard journal note. A reviewer seeing changed guards is not a finding by itself.
- **4.10 measures thresholds after 4.6–4.9.** If 4.8 or 4.9 adds tests under `apps/desktop`, 4.10's numbers move with them; that is why it is last.
- `4.close` goes to **phase 6** (`nextPhase: 6`), not 5.
- `scripts/gate.sh` outruns the 120 s foreground limit; background it and read its output file. It prints `ROTATE-PRINCIPAL` (advisory).
- The host has no pandoc: `docker run --rm -i --entrypoint pandoc essaydown-dev:0.0 -f gfm -t html < file`.

## Next Steps

1. Run `status` (expect `Phase 4, idle; last passed 3.close`) and `doctor` (clean). Give Michael the one-line state, and hand him `git push origin phase/4` if `git rev-list --count origin/phase/4..phase/4` is non-zero.
2. Restart the runner on `--phase 4` (the command above) and arm the watcher with `start=` = runner.log line count + 1, read at restart.
3. Handle each stop signal as it comes: `HUMAN_GATE 4.0h` → `scripts/gate.sh 4.0h`; `PRINCIPAL 4.0r` → the SPIKE decision commit in `.wt/4.0r`.
4. Rotate at every stop signal that ends a working block, and before context passes about 150k.

## Open Questions

- None for Michael now. The six boundary questions were answered (#059).
- 3.30's `cardCountOf` line is for information only and has its trigger.

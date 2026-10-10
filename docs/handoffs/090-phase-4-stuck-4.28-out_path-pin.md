# Handoff 090: Phase 4 fix chain, STUCK 4.28 on the 4.3 `out_path` pin

Written 2026-10-10 by the principal (Opus 5.5) that continued from 089. This handoff supersedes `089-phase-4-fix-chain-4.23-running.md`.

It is committed on `handoff/090`, stacked on `handoff/089`. `phase/4..handoff/090` holds three commits: 089's handoff commit, DECISIONS #067, and this commit. The next principal commit on `phase/4` (4.5.r1d, or a planning commit) cherry-picks `phase/4..handoff/090`. The stack now carries a DECISIONS.md tail (#067). If a planning commit that appends to DECISIONS.md lands on `phase/4` first, rebase the stack as #039 records.

## Current State

- **Branches.**
  - `main` is at `8aba511`.
  - `phase/4` is at `4dcdc9b` (`task(4.27)`). `origin/phase/4` is at `50f2edf`, so 4 commits are unpushed (4.24–4.27): hand Michael `git push origin phase/4`.
- **Status at writing:** `Phase 4, idle; last passed 4.27; gates open: none; plan requests: none; blocked: 4.28:blocked`. `doctor` is clean. The runner loop exited at `STUCK 4.28`, and pane `essaydown:runner` is at a zsh prompt.
- **This block:**
  - 4.23, 4.24 and 4.25 (sonnet) each capped at 80 turns on attempt 1 (`num_turns` 81, exit 1). The runner carried each on to attempt 2 with a recovery commit, and attempt 2 passed in 3–5 minutes.
  - 4.26 and 4.27 (opus) passed on attempt 1.
- **STUCK 4.28.**
  - All three attempts (79, 20 and 24 turns, exit 0, no DONE) delivered S5 and C7 in the scope files. Each stopped, correctly, on one red: `apps/desktop/src-tauri/src/commands.rs:768`, a test in passed task 4.3's file that pins `outcome["out_path"]`.
  - `commands.rs` is outside 4.28's scope sentence and diff-stat clause. `git grep` shows that line 768 is the only reader of `ExportOutcome`'s keys outside the scope files.
  - The deliverables are committed on `task/4.28`: 9 wip commits, the last `d5e53dc`.
- **Decision written:** DECISIONS #067 on `handoff/090` (`a272dc3`). The pin yields: line 768's key becomes `outPath`, and nothing else in `commands.rs` changes. This is the shape of #033 and #026 D1.

## Next Steps (the plan; do them in order)

1. **Fable brief** (PRINCIPAL.md: STUCK after three attempts).
   - Signal: `STUCK 4.28`.
   - Evidence: `.evidence/tasks/4.28/{1,2,3}.log`, the lessons and journal lines on `task/4.28`, #067 and #033.
   - The question: does #067 hold (the pin yields, one line), or does this need a planning change (a scope widening in `ralph/tasks.json`)?
   - Answer format: decision, reasons, confidence, commands.
2. **The lesson.** On a confirming answer, make one `chore(4.28): principal lesson` commit on `task/4.28` in `.wt/4.28`. It touches `docs/lessons.md` only; check the file's last byte before appending. The lesson tells the agent to:
   - first append a NEW `- [4.28] ` journal line with one `printf` that prints the timestamp;
   - change only the key at `commands.rs:768` to `outPath`, per #067 (`git show handoff/090:docs/DECISIONS.md | grep -n '^## #067'`), and record which ref answered;
   - run `scripts/check` once;
   - complete the stub, naming the pin and #067;
   - commit.
3. **The retry.**
   - Move `.evidence/tasks/4.28/{1,2,3}.log` aside with suffixes (#027).
   - Run `ralph/ralph.sh retry 4.28`. This is 4.28's first retry; a second one needs a DECISIONS entry first (#038).
   - Restart the runner:
     ```
     tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 4 2>&1 | tee -a .evidence/runner.log' Enter
     ```
   - Arm a fresh watcher: `start=275135`, `NR<=k` with `k` recounted. The raw count was 70 at writing, including `STUCK 4.28`.
4. **The rest of the chain** is unchanged from 089: 4.29 → `4.verify.r1` → the `4.verify.r1h` gate → `4.5.r1a/b` → `PRINCIPAL 4.5.r1d`. At `PRINCIPAL 4.5.r1d`, rotate; a fresh session reconciles.

## Gotchas

- **The sonnet turn cap.** Three sonnet tasks in a row capped at 80 turns on attempt 1. If one of them needs a third attempt, the turn counts above are the evidence for a max-turns proposal. That proposal stays conditional on Michael's OK (#review-1-r1).
- **A planning lesson, recorded in #067.** A task text that renames a wire key greps the tree for every reader of the old key before it lists the scope files.

## Open Questions

- **For Michael:** none open.

## Addendum (same session, after the plan above)

- **Steps 1–3 are done.**
  - Fable confirmed #067 with high confidence. Its corrections are folded into #067 (`97f2439`): the SHA, the log names, and `node ralph/journal.mjs stub` in place of a hand-printed line.
  - The lesson is `cb7a4e7` on `task/4.28`.
  - The logs are `.evidence/tasks/4.28/{1.a1-blocked,2.a2-blocked,3.a3-blocked}.log`.
  - `retry 4.28` ran, then the restart. `[ralph] 4.28 attempt 1` is logged, and the raw count is 71.
- **Watcher change.** The 089 awk dedups on content (`!seen[$0]++`). After a retry, the repeated `4.28 attempt 2/3` and `STUCK 4.28` lines are byte-identical to the first run's, so that awk would swallow them. The watcher now prints by position instead: each pass writes the grep to a file and prints the lines past the last count `n`. The filter is unchanged. Re-arm it with this, with `n` set to the RAW count at arm time:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=275135; n=K; W=/tmp/essaydown-watch.txt; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] " > "$W" 2>/dev/null; c=$(wc -l < "$W"); if [ "$c" -gt "$n" ]; then tail -n +"$((n+1))" "$W" | cut -c1-400; n=$c; fi; sleep 30; done
  ```
  Replace `K` with the recount before arming.

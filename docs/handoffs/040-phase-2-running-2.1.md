# Handoff 040: Phase 2 running (2.1 attempt 2); the boundary window closed with DECISIONS #043; one Michael question open

Written 2026-09-25 by the principal: the Opus 5.5 session under #041 D2 that ran the Phase 2 boundary window and restarted the runner, in Claude Code on the Mac Mini. Supersedes `039-phase-1-closed-phase-2-boundary.md`, which is in the tree since `4896d5f`. This commit is on `handoff/040`, cut from `phase/2` at `ab7a5d4`; the runner is live, so it is not on `phase/2` (#017). `2.10.r0d` cherry-picks `phase/2..handoff/040`, plus anything stacked on it. The next handoff is `041-*.md`.

## Current State

- **Branches.** `phase/2` is at `ab7a5d4` (`docs(decisions): #043`). It is 24 commits above `main`: handoff 039 and 23 boundary commits. `main` is at `92a2ec1`, and so is origin: Michael pushed `main` and `phase/1`. `phase/2` is not pushed.
- **Status.**
  - `status` reads `Phase 2, 2.1 running`; it still says attempt 1 while attempt 2 runs. `doctor` is clean.
  - Phase 2 has 17 tasks: 2.1 running, the rest pending.
  - 2.1 a1 capped: `error_max_turns`, 81 turns, $3.94, 73 Bash calls. It wrote its stub with `node ralph/journal.mjs` and never ran `scripts/check`. The runner's recovery commit (`cf58a25`) swept its uncommitted work onto `task/2.1`.
  - a2 started at runner.log line ≈147,000, sonnet, max-turns 80.
- **Runner**: tmux `essaydown:runner`, pane pid 8940, running `ralph/ralph.sh run --phase 2 2>&1 | tee -a .evidence/runner.log`, which started at runner.log line 146,951. Restart after a stop signal with the same command: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 2 2>&1 | tee -a .evidence/runner.log' Enter`
- **Watcher**: this session's watcher is stopped at rotation.
  - Start a fresh one: `Monitor`, persistent, 30 s poll, 30 min cap, with `status` on every expiry.
  - Set `start` to the `wc -l < .evidence/runner.log` you read at session start, plus 1. The pattern now includes `USAGE-LIMIT` and `WARN` (#043):
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=<count+1>; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  The `<count+1>` above is an instruction for this file only; the command you run carries the number.
  - runner.log also carries the agents' stream-json, because `tee` copies the container output. Filter it; never read it raw.
- **Expected next stop signal:**
  - `[ralph] 2.1 attempt 3`, or 2.1 integrates and then `HUMAN_GATE 2.1h`.
  - `2.1h` is a CI gate. Read 2.1's PRD §8 row, then run `scripts/gate.sh 2.1h` in the background: it pushes `ci/2.1/a1` and fetches `test-logs` and `e2e-shell`.
  - This is the first run of the #043 `ci.yml` (`if: always()`) and of the I7 fetch-on-failure.

## Corrections

- `039` Next Steps 2: "opus fix tasks capped at a1 in 14 of 15 over r7–r10" does not reproduce. Read from the `1.log` result lines, the figure is 7 of 8 (r7–r9 findings), or 9 of 12 with r6. #043 records it.
- `039`: `docs/handoffs/rotate.md` is `.claude/commands/rotate.md`.
- `039` Next Steps 2: "Grok's read-only mode" was a misnomer. The entrypoint was already read-only. The decision taken is lane and timing (#043).
- This session told Michael "24 commits on `phase/2` after handoff 039". The count is 23 after 039, and 24 counting 039.

## Decisions

- **#043** (`ab7a5d4`), the Phase 2 boundary; Michael's decisions of 2026-09-24/25:
  - D3: CLI 2.1.281 and `claude-opus-5-5` for opus tasks and the Claude reviewer.
  - D4 amended: `MAX_ATTEMPTS` stays at 3, and the loop turn cap goes from 50 to 80.
  - D5: items 2 (`node ralph/journal.mjs stub|complete`), 3 (a one-line `summary.md`) and 4 (`scripts/check`), routed in CLAUDE.md/AGENTS.md steps 2–4 and in PROMPT.md.
  - The `USAGE-LIMIT` signal.
  - Grok `r0` only, with the drift prompt. Planning commits write `r1`+ as `a`, `b`, `d`.
  - React 19 ratified; `check-deps` pins the major.
  - The whole `fix(runner)` list: #025 hold-out in the runner, #023 doctor clause and `--resume` refusal, H7, M3 (b), the recovery-commit guard, I7, `ci.yml` `if: always()`.
  - PRINCIPAL.md: the doctor sentence, a Reviewers section and the r4–r10 lessons.
  - rotate.md fixes.
  - 27 `handoff/*` branches deleted; #043 lists their SHAs.
  - 2.9 unchanged: it installs the CI DMG, so no dev-server wording applies.
- **Verification** (#043):
  - image rebuilt twice, `BOUNDARY-OK`;
  - `bash ralph/test/run.sh` 139/139;
  - `scripts/check` in the container: lint pass, 4,819 tests, cargo 0 tests in 3 suites;
  - 285 tasks, byte-identical.
- **Runner deviations:** none this block beyond #043's two recorded ones. #025's refusal is in the runner instead of `check_report`; H7's guard is in `ralph/test`.

## Gotchas

- **The #025 sibling refusal** (`siblingReportsRead` in `ralph/lib/run.mjs`) blocks a finished reviewer whose transcript names a sibling's `report.md` path of the same attempt anywhere, including in a listing.
  - The principal's change to WARN plus notes was refused by the auto-mode classifier as removing a security guard. It is Michael's call (Open Questions).
  - If a reviewer row is blocked with that note, the reconciliation reads the transcript. `retry` of that reviewer alone reruns it with siblings held out.
- An empty `.wt/review-grok` directory appeared on the host during this session's test runs (09:01); it was removed. If it reappears, a conformance test is creating a path in the real repo's `.wt/`.
- `scripts/check` fails on cargo under a login shell (`bash -l` resets PATH). Agents don't run that way; a probe in the container must use `bash -c`.
- The auto-mode classifier also blocked, with no reason given, a read-only `grep` of V1.1-BACKLOG and DECISIONS headings. Michael then allowed reading both files.
- 2.1 a1 used the full 80 turns. If a2 caps too, count a1/a2 tool calls by phase (orientation, build, suite, journal) before any lesson (#038).

## Next Steps

1. Session start: run `status`, `doctor`, and the runner.log grep; start the watcher.
2. Handle 2.1's outcome.
   - On `HUMAN_GATE 2.1h`, read the PRD §8 row, then run `scripts/gate.sh 2.1h` in the background and read its output file.
   - On `STUCK`/`NO-JOURNAL`, follow the constraints in next-prompt.md: logs aside, then a principal lesson on `task/2.1` in `.wt/2.1`.
3. Ask Michael the #025 refusal question when he is next present. A change is a `fix(runner)` commit on `handoff/NNN`, cherry-picked by `2.10.r0d`. Because the runner executes ralph/lib from the host checkout, it takes effect only at the next boundary or when a reconciliation lands it. It must land before `2.10.r0a/b/c` start, or wait until Phase 3.
4. Rotate at every stop signal that ends a working block, and before about 150k of context. The reconciliation `PRINCIPAL 2.10.r0d` is run by a fresh session.

## Open Questions

- #025 sibling refusal: keep refusing, or change to WARN plus notes with the reconciliation deciding derivation. The principal recommends WARN (75%). This is Michael's call.
- `[review-1-r10, leg (b)]` (0 corpus members) and `[1.67, found outside scope]`: both are `2.verify`'s questions, unchanged.

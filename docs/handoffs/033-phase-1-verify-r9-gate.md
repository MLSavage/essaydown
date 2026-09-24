# Handoff 033 — Phase 1 at `HUMAN_GATE 1.verify.r9h`: the r9 fix chain integrated (`1.63`, `1.64` after two retries, `1.65`), the verifier passed and promoted #review-1-r8's three rules; Michael runs the CI gate, then the r9 review set, then the reconciliation in a fresh session

Written 2026-09-23 by the principal (the session that ran both `1.64` retries and followed the chain; Claude Code on the Mac Mini), at `HUMAN_GATE 1.verify.r9h` / `ROTATE-PRINCIPAL`, per the rotation rule for that gate (DECISIONS #015). Supersedes `032-phase-1-r9-chain-1.64-second-stuck.md` (on `handoff/032`, not in the tree). This commit is on `handoff/033`, stacked on `handoff/032` (itself on `handoff/031`, cut from `phase/1` at `5fb4163`); the `1.10.r9d` reconciliation cherry-picks `phase/1..handoff/033` as one range — four commits, `docs/handoffs/**` and `docs/DECISIONS.md` (#038) only. Next: `034-*.md`.

## Current State

- **`phase/1` tip `29d2e08`** (`task(1.verify.r9)`); `main` at `052e206`; `origin/phase/1` at `4590b8d` (Michael pushes by hand, #010). Host checkout on `phase/1`, tree clean, `doctor` clean.
- **The r9 chain, all integrated**: `1.63` at `5fb4163` (a2); **`1.64` at `feefa73`** (the second retry's a1, exit 0 in 6.4 min, after six capped attempts — DECISIONS #038; seven `- [1.64]` journal lines); **`1.65` at `486d4a2`** (a1 51 capped with the work built — the recovery commit swept only its completed journal line, the mutation reverted in the transcript before the suite — a2 exit 0 in 8.2 min); **`1.verify.r9` at `29d2e08`** (sonnet a1, 5.3 min; `pnpm install --frozen-lockfile` changed nothing; the suite green; promote-lessons (a)–(c) appended verbatim to CLAUDE.md and AGENTS.md as the three `## Code rules` bullets after the r7 M1/M2/M5 ones — N1's block-edge typed-marks rule, N2's live correspondence, N3's instrumented give-up; `check-agent-rules.sh` identical). The suite on the candidate: `stop-check: GREEN`.
- **Gate `1.verify.r9h` `human-pending`** — a CI gate: `scripts/gate.sh 1.verify.r9h` pushes `29d2e08` to `ci/1.verify.r9/a1`, waits for `ci.yml` on the three OSes, fetches `test-logs` and `playwright-report` into `.evidence/ci/1.verify.r9/a1/`, asserts `ciAcceptance`, writes `accepted.json` on ACCEPT. Michael's `gh` login, never a container; it outruns the 120 s foreground limit — Michael runs it in his shell, or a session backgrounds it and reads its output file.
- **Runner**: tmux `essaydown`, window `runner`, pane pid 8940, `zsh` at the prompt after `HUMAN_GATE 1.verify.r9h` / `ROTATE-PRINCIPAL` (runner.log 138,179 lines). `.locks/` empty, no `ralph run` process, no containers. Restart after ACCEPT: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 1 2>&1 | tee -a .evidence/runner.log' Enter` — it then runs the review set `1.10.r9a/b/c` (Claude, Sol, Grok — the only parallelism) and stops at `PRINCIPAL 1.10.r9d`.
- **Watcher** (`Monitor` tool, persistent, 30 s poll, 30 min cap — re-arm on expiry; this session's is stopped; **a fresh one after every restart or `retry`**; a line that lands in the expiry's second is lost, so `ralph/ralph.sh status` on every expiry notice):
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=$(($(wc -l < .evidence/runner.log)+1)); while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  Current marker: `HUMAN_GATE 1.verify.r9h`. After the restart the next own line is `[ralph] 1.10.r9a attempt 1`.
- **Expected next stop**: the gate's own outcome in `gate.sh`'s output (ACCEPT → restart; GATE-FAILED → a planning commit for a `.g1` repair, #037's shape); then `PRINCIPAL 1.10.r9d` (rotate there; the reconciliation is a fresh session's).

## Corrections

- `032` Current State, "Expected next stop: `1.64`'s integration then `[ralph] 1.65 attempt 1`": done — `1.64` landed on the second retry's first attempt; `1.65` and `1.verify.r9` followed; the block ended at the gate.
- `032` Open Questions, "Whether the second retry lands `1.64` in one attempt": it did (#038's stop rule never fired; no fourth retry, nothing for Michael on `1.64`).
- `032` and `next-prompt.md` job 5, "`git branch -D handoff/010 … handoff/032`": through `handoff/033`.
- `031` Current State, "Graph 273 tasks": unchanged; no planning commit this block.

## Decisions

- **No new DECISIONS entry** since #038 (`handoff/032`, `d6481ad`). Outcome of #038 recorded here: the remaining-step lesson landed `1.64` in one attempt; the six-cap evidence goes on the `[review-1-r9, turn budget]` backlog line the reconciliation appends.
- **Rules in force**: as 032, plus the three promoted by `1.verify.r9` (now in CLAUDE.md/AGENTS.md; discharged by 1.63's guard family and corpus leg, 1.64's whitespace guards and `deleteAtEveryBlockStart` leg, 1.65's `format-widening-giveup` instrument and coverage line — the verifier's journal line names each).
- **Runner deviations this block**: the two `1.64` retries (the first after `35e8054`, the second under #038). No 429, no `NO-JOURNAL`, no `admin`, no `docker/` change, no `fix(runner)`.
- **Turn-budget evidence** (conditional on Michael's OK — unchanged as a decision): every opus fix task of the r9 chain capped at a1 with the work built — `1.63` (a2 passed), `1.64` (six caps, landed on the seventh attempt under a remaining-step lesson), `1.65` (a2 passed). The reconciliation writes the counts from the transcripts' result lines.
- **N4, the `1.9.r1` approval retry — asked of Michael this session with the tradeoffs and a recommendation (yes, 75%: the r-chains were about the toggle's cursor carry, the thing a human feels; one hour of his time before `1.close` against a Phase 2 fix task after it); reversible either way until the reconciliation commits.** His answer is pending; on yes the reconciliation appends `1.9.r1` at the r9 implementation SHA with the `[repair-1.9 (c)]` two-reader procedure; on no, the line's trigger stands.

## Gotchas

- **The gate is a CI gate, not an observation gate**: no `--outcome`, no note — `scripts/gate.sh 1.verify.r9h` alone. From a Claude Code session it is backgrounded and its output file read; a foreground `sleep` is blocked, wait with a backgrounded `until` loop. On GATE-FAILED: read `.evidence/ci/1.verify.r9/a1/` first; a same-SHA rerun (`scripts/gate.sh rerun 1.verify.r9h`) is only for a transient failure (#023, #029), any tree change is a `.g1` repair through `ralph/ralph.sh plan` on `plan/1.verify.r9h/r0` (#037 and `plan.1.verify.r8h.r0` are the pattern; scope to what failed, file the rest with a revisit trigger).
- **The review set**: three reviewers in parallel; a Grok 402 is never retried without Michael (#027, memory `project-grok-usage-budget`); a single-reviewer retry follows #025's manual procedure; never reconfigure a reviewer inside the set (#review-1-r0). The runner stops at `PRINCIPAL 1.10.r9d` — rotate there; a fresh session runs the reconciliation (#015): the FAIL pattern `task(1.10.r8d)` at `3c96b9b` with #review-1-r8, the PASS pattern `task(0.12.r2d)` at `052e206` with #review-0-r2; it cherry-picks `phase/1..handoff/033` (four commits), regenerates `docs/progress.md`, appends the backlog evidence lines, and on Michael's yes appends `1.9.r1`.
- **Handoff branches**: `handoff/031` → `handoff/032` → `handoff/033`, stacked; the next principal commit before the reconciliation stacks on `handoff/033`. `git branch -D handoff/010 … handoff/033` after `1.close`.
- The prior session's scratch worktree at `<its scratchpad>/970bb5c` (detached, with `node_modules`) is still registered in `git worktree list` — throwaway; `git worktree remove --force` it at the boundary or leave it; never used for a task.
- In this zsh a bare `echo ===` aborts a compound command and an unmatched glob aborts a script — quote separators, `setopt nullglob` in watchers; `grep -- '- [id]'` needs the `--`. `ralph/ralph.sh status` says "running attempt 1" while the log shows a later attempt: read the log.

## Next Steps

1. **Michael runs the gate**: `scripts/gate.sh 1.verify.r9h`. On ACCEPT: idle checks, restart the runner, fresh watcher; the review set runs; at `PRINCIPAL 1.10.r9d` rotate. On GATE-FAILED: the planning commit for `1.verify.r9.g1` (scope to what failed).
2. **The reconciliation `1.10.r9d`** in a fresh session: the pattern above; the `[review-1-r9, turn budget]` line with `1.64`'s six caps and `1.63`/`1.65`'s a1 caps; the reviewer record; N4 on Michael's answer; then `1.close` on a PASS, or the r10 chain on a FAIL.
3. **After `1.close`** (host checkout on `phase/2`, runner idle): 032's Next Steps 3 unchanged — the boundary `fix(runner)` list (#025, #023 ×2, H7, #review-1-r7 M3 (b) `transcriptHasDone` over assistant text blocks with its conformance test, the recovery-commit guard), `chore(0.0)` for rotate.md step 5, the stale `description` line, PRINCIPAL.md's doctor sentence and the r4–r9 principal lessons (#038's included), Claude r8 nit 3 (`ci.yml` `if: always()`), React 19's ratification (Michael's OK), the `check-deps` major-version comparison (Michael's OK); `git branch -D handoff/010 … handoff/033`; ask Michael for `scripts/gate.sh gc` (after `git ls-remote origin 'refs/heads/ci/*'`) and the `phase/1` push (#010); on Michael's OK only: the turn-budget raise (evidence: #review-1-r5 … #review-1-r8, 031, #038, this chain), the 429 signal (#027), the gate fetch-on-failure (I7), the reviewer-prompt option, Grok's read-only mode.

## Open Questions

- The gate's outcome on three OSes at `29d2e08`.
- Michael's answer on the `1.9.r1` approval retry (N4; recommendation given).
- The r9 review verdict: a PASS closes the phase; a FAIL opens the r10 chain.
- The cap raise, the 429 signal, Grok's mode, React 19: Michael's calls, evidence unchanged in kind.

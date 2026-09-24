# Handoff 038 — Phase 1 at `PRINCIPAL 1.10.r10d`: the scoped r10 review set is done, three PASS 0/0/0; `1.9.r1` ACCEPT; the PASS reconciliation and `1.close` wait for a fresh Opus 5.5 session

Written 2026-09-24 by the principal (the Opus 5.5 session under #041 D2 that ran `1.10.r9d`, followed the r10 chain, reran the gate `1.verify.r10h` and retried Sol; Claude Code on the Mac Mini). Supersedes `037-phase-1-review-r9-reconciliation-under-d1.md` (in the tree since `faaab4b`). This commit is on `handoff/038`, stacked on `f4b7b35` (DECISIONS #042), which sits on `phase/1`'s `3e4a3f6`; the `1.10.r10d` reconciliation cherry-picks `phase/1..handoff/038` — two commits, `docs/**` only. Next: `039-*.md`.

## Current State

- **`phase/1` tip `3e4a3f6`** (`task(1.verify.r10)`); `main` at `052e206`; `origin/phase/1` at `4590b8d` (Michael pushes by hand, #010). Host checkout on `phase/1`, clean, `doctor` clean.
- **Chain since handoff 037** (all at attempt counts read from the transcripts):
  - `1.10.r9d` integrated as `faaab4b` (verdict FAIL, #review-1-r9; `.evidence/reviews/1/r9/verdict` FAIL).
  - `1.9.r1` **ACCEPT a1** (`.evidence/human/1.9.r1/a1.md`, record `sha: 3e4a3f6` — gate.sh stamps the target head; Michael drove `287c884` in a detached worktree `essaydown-1.9.r1`).
  - `1.67` a1 51 capped (work built; the recovery commit `4043e7d` swept a half-done but coherent `format.ts` edit, no probe), a2 21 → `114e204`. Handlers `handleEmphasis`/`handleStrong` (`opensBesideAttentionRun`, previous sibling must be `emphasis`/`strong`); sweep 100 pairs (5 × 5 × 4 — astral split into symbol and letter); 42 joins in 11 fixtures; separator-deletion leg 0 members in the corpus (the sweep stands for it, as the task allows). Filed `[1.67, found outside scope]`: two adjacent `delete` runs still share `~~` (GFM has one marker), positively bounded.
  - `1.68` a1 46 → `0ff43df` (`clickAtComputedPoint`, up to three tries; the spec's only computed-point click).
  - `1.verify.r10` a1 36 → `3e4a3f6` (the O1 promote bullet once in CLAUDE.md and AGENTS.md).
  - Gate **`1.verify.r10h` ACCEPT a2** (run 35984824027 at `3e4a3f6`, per OS `Tests 4816 passed (4816)`, `102 passed`) after a1 GATE-FAILED (run 35983766944: macOS `editor-astral-between-runs.spec.ts:161`, the `[1.46]` race) — **#042**.
  - Review set r10: **Claude PASS 0/0/0** (91 turns, $7.50, 50 lines), **Grok PASS 0/0/0** (43 lines), **Sol PASS 0/0/0** (49 lines) on a single-reviewer retry — its a1 (started with the others at `10:12:20Z`) died on the Codex usage limit (`"status":402`, "try again at 12:28 PM", 128,700 tokens); #025's procedure: its `transcript.log`/`exit-code` renamed `*.a1-usage-limit*` in `.evidence/reviews/1/r10/sol/`, `claude/` and `grok/` held in `r10.held/` for the run, `ralph/ralph.sh retry 1.10.r10b` at `12:30:59Z`, Sol ran `12:31:09Z`–`12:35:44Z` alone, the siblings moved back after `PRINCIPAL` (all three `report.md` + `status.json` in `.evidence/reviews/1/r10/`, `r10.held` removed). Sol's retry could not read a sibling report, so it is **independent** by construction.
- **`1.10.r10d` principal-pending, attempts 0**, worktree `.wt/1.10.r10d` on `task/1.10.r10d` at `3e4a3f6`, clean. `EXPECTED_COUNT` 285. `1.close` depends on `1.10.r10d` and `1.9.r1`.
- **Runner**: tmux `essaydown`, window `runner`, pane pid 8940, at the prompt after `PRINCIPAL 1.10.r10d` (runner.log 145,411 lines). `.locks/` empty, no `ralph run` process. Restart after the reconciliation's DONE commit: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 1 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher** (`Monitor`, persistent, 30 s poll, 30 min cap; this session's is stopped; a FRESH one after every restart or `retry`, with `start` = the log's line count + 1 taken *before* the restart — a start at the count itself re-reports the last line; `status` on every expiry):
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=$(($(wc -l < .evidence/runner.log)+1)); while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  Current marker: `PRINCIPAL 1.10.r10d`.
- **Expected next stop**: after the PASS reconciliation integrates, the runner runs `1.close` (runner execution) → `CLOSED 1` (or `CLOSE-DRIFT`/a refusal naming the precondition).

## Corrections

- `037` Current State "Expected next stop … `[ralph] 1.67 attempt 1`": the first stop after `1.10.r9d` was `HUMAN_GATE 1.9.r1` (placed first in PRD §8 by #review-1-r9, so `1.10.r10d` could copy its record); the chain ran while it waited.
- `037` Next Steps 2 "At `1.10.r10d`: a PASS reconciliation, then `HUMAN_GATE 1.9.r1`": `1.9.r1` is already ACCEPT and `1.10.r10d` depends on it.
- `037` and #040 "a REJECT is a plan request on `1.9.r1`": an observation gate takes only ACCEPT (`gate.mjs:205`); #review-1-r9 moved the rejection into the note.
- `1.9` and `1.9.r1` task text "`pnpm dev`": fails at the repo root (`Command "dev" not found`); the working command is `pnpm --filter @essaydown/desktop dev` (Michael's note). My own hand-over command to Michael had the same error. PRD §8 text of passed tasks is not edited; record it at #review-1-r10 and fix the next observation gate's text (`2.9`) at its planning.
- `next-prompt.md` (037's) job 1 "`git log --oneline phase/1..handoff/037 | wc -l` (must print 12)": the stack is now `phase/1..handoff/038`, two commits.

## Decisions

- **#review-1-r9** (in `faaab4b`): verdict FAIL, O1–O9, fixes `1.67`/`1.68`, the rest backlogged with `2.verify` triggers; `1.9.r1` first, `1.10.r10d` depending on it; one promote bullet; ten backlog lines.
- **#042** (`f4b7b35`, this stack): `1.verify.r10h` transient rerun (the #023 criterion: nothing under `packages/editor/src`, `apps/`, `fixtures/` or the spec changed since `287c884`); a1 marked `abandoned` by #023's procedure so doctor is clean (third instance); the `[1.46]` class's sixth gate instance, second on macOS.
- **Runner deviations this block**: one `gate.sh rerun` (#042); one `gate.sh abandon` of a superseded attempt (#042); one single-reviewer `retry` of `1.10.r10b` under #025 after a Codex usage limit — no DECISIONS entry of its own yet: **`1.10.r10d` records it** (the procedure, the times above, independence by construction, the 402 being Sol's subscription limit, not Grok's #027 case; retried after the reset without payment). No `fix(runner)`, no `admin`, no `docker/` change, no reviewer reconfiguration, no Fable brief.

## Gotchas

- **The r10 reconciliation is a PASS reconciliation** — three PASS 0/0/0, no blocker, so #041 D1's "blocker → Michael first" does not fire. Read the three reports anyway for a blocker hidden as a risk or a lesson, and read `1.9.r1`'s note: round trip clean in BBEdit (cmark) and VS Code (Typora unavailable, VS Code replaced it); ~250 words, not ~1,000 (Michael's choice, stated); non-blocking editing feedback (changing existing formatting means retyping; stuck in italics until a new line). Copy the accepted record into DECISIONS `#002-outline-feel` (append mode, RUNNER-SPEC §2, §5.4) — its payload is `{}`.
- **`1.close` preconditions** (`ralph/lib/close.mjs`): phase head == the newest attempt's reconciliation commit with verdict PASS (`:59`, `:63`), no product file changed since the implementation SHA `3e4a3f6` (`:66`) — so the reconciliation touches only `docs/**`, `ralph/tasks.json`, `ralph/EXPECTED_COUNT`, and on PASS it appends **no** tasks (`EXPECTED_COUNT` stays 285, `generate-tasks --check` and `validate-tasks` still run). The promote-lessons step after a PASS names its lessons verbatim in the next phase's `2.verify` text (RUNNER-SPEC §5.5) — `2.verify` is a planned PRD row; that is a PRD §8 text change to a *pending* task, allowed.
- **The PASS reconciliation's checklist**: `git cherry-pick phase/1..handoff/038` first (two commits); `docs/DECISIONS.md` `#review-1-r10` with `verdict: PASS` (the regex reads the first `verdict:` in the section); reports copied to `docs/reviews/phase-1-r10-{claude,sol,grok}.md` (`cmp`); the Sol retry record; the reviewer record (Grok's fourth consecutive zero-finding PASS, r7–r10; count from the four `status.json` files before stating it); the `[review-1-r10, turn budget]` evidence line (1.67 51/21, 1.68 46, 1.verify.r10 36, Claude 91); the `[1.46]` line's sixth instance; `docs/progress.md` regenerated; the journal line and lessons lines; promise only in the `wip(1.10.r10d)` commit message.
- **Never quote the promise literal** in any file an agent reads (N6).
- **Watcher start line**: take `wc -l` before the restart and start at +1; this session started one at the count itself and got a duplicate `HUMAN_GATE` event.
- In this zsh a bare `echo ===` aborts a compound command; `setopt nullglob` in watchers; the host `grep` is ugrep (a `.\{0,250\}` bound around a multibyte class is rejected — use `node`); `scripts/gate.sh` outruns the 120 s foreground limit — background it; a test runner's summary is captured to a file and grepped.

## Next Steps

1. **`1.10.r10d`** in a fresh Opus 5.5 session: the checklist above; DONE in the `wip(1.10.r10d)` commit message; idle checks; restart; fresh watcher.
2. **`1.close`** (runner): expect `CLOSED 1`; on a refusal read `close.mjs`'s message against the preconditions before anything else — never edit a product file to satisfy it.
3. **After `1.close`** (host checkout on `phase/2`, runner idle): handoff 037's Next Steps 3 unchanged — D3–D5 of proposal 001 on Michael's word; the boundary `fix(runner)` list (#025 — now with a Sol instance —, #023 ×3, H7, #review-1-r7 M3 (b) `transcriptHasDone`, the recovery-commit guard, the gate fetch-on-failure I7 ×3 counting #042); `chore(0.0)` for rotate.md step 5 (its `worktree add -b` fails when the branch already exists — this rotation stacked on an existing `handoff/038`) and its relaunch lines, which lack `--model claude-opus-5-5`; PRINCIPAL.md's doctor sentence and the r4–r10 principal lessons; Claude r8 nit 3 (`ci.yml` `if: always()`); React 19's ratification and the `check-deps` major comparison; `git branch -D handoff/010 … handoff/030 handoff/033 … handoff/038`; `git worktree remove --force` the scratch worktree at `970bb5c`; Michael's own `git worktree remove /Users/mlsavage/Developer/essaydown-1.9.r1`; ask Michael for `scripts/gate.sh gc` (after `git ls-remote origin 'refs/heads/ci/*'`) and the `phase/1` push (#010); on Michael's OK only: the turn-budget raise, the 429 signal (#027) and a usage-limit signal for reviewers, Grok's read-only mode (Grok's unique findings r7–r10: 0, 0, 0, 0).

## Open Questions

- Whether the `[1.67, found outside scope]` adjacent-`delete` member is reachable from the editor (two adjacent `delete` runs merge in ProseMirror; different content would need another mark between) — `2.verify`'s question, not r10d's, unless a reviewer called it a blocker (none did).
- D3–D5 of proposal 001: Michael's calls at the boundary.

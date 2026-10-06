# Handoff 061: Phase 3 running, `STUCK 3.10`

Written 2026-10-05 by the principal, the Opus 5.5 session that continued from 060. That session ran the Phase 2→3 boundary window (#047–#051), restarted the runner, and watched 3.8 and 3.9 pass and 3.10 stick. This handoff supersedes `060-phase-2-closed-phase-3-boundary.md`.

This commit is on `handoff/061`, cut from `phase/3` at `ac3aac7`, from a temporary worktree. Read it with `git show handoff/061:docs/handoffs/061-phase-3-stuck-3.10.md`. The next handoff is `062-*.md`.

## Current State

- **Branches.**
  - `phase/3` is at `ac3aac7` `task(3.9)`. Origin `phase/3` is at `3791f74` (#051), so 3.8 and 3.9 are not pushed.
  - `main` and `phase/2` are at `da7d07b`, local and origin.
  - No `ci/*` refs remain on origin (`scripts/gate.sh gc` deleted 8).
  - `handoff/040`–`059` are deleted (their content is in `main`; only `next-prompt.md` lines differed). `handoff/061` is this commit.
  - `attic/3.1-pre051` holds 3.1's stale attempt from the wrong graph (#051), kept as evidence.
- **Status:** `Phase 3, idle; last passed 3.9; gates open: none; plan requests: none; blocked: 3.10:blocked`. Phase 3: 22 tasks: 2 passed, 1 blocked, 19 pending. `doctor` is clean. The host checkout is clean on `phase/3`.
- **Tasks this block:**
  - **3.8** (CI policy, #047) passed at attempt 1 (34 turns). `ci.yml`: `test` and `e2e-shell` both carry `continue-on-error: ${{ matrix.os == 'windows-latest' }}`.
  - **3.9** (the `:161` caret race, test-only) passed at attempt 1 (49 turns). There is a readout poll before the Backspace (`before: "a. "`) and the Delete.
  - **3.10** (U9 robustness, test-only) is **STUCK after 3 attempts**:
    - a1 capped at 81 turns; the runner's recovery commit `682b41b` carried only the spec and the journal, with no product mutation (checked);
    - a2 (66 turns, success, no DONE) and a3 (33 turns, success, no DONE) each recorded the same conflict and stopped.
    - `task/3.10` in `.wt/3.10` holds gaps (a), (b), (c) and (e), done and green, with 160 added lines in `robustness.spec.ts`, 3 lessons lines and 3 journal lines. Logs are `.evidence/tasks/3.10/{1,2,3}.log`.
- **The conflict (3.10 gap d).** The task asks for a presence case: a known backend stderr line must reach the captured log. On Linux no reachable action prints one.
  - `menu.rs`'s `eprintln!` is wired only under `cfg(target_os = "macos")`.
  - `workspace.rs:391`'s rollback `eprintln!` needs a double failure, and a3 found the `fault()` seam is `cfg(test)`-only.
  - The crate has no `log`/`tracing` dependency.
  - The task says "no product change" and limits its diff to `e2e/shell/` plus docs. Its acceptance requires the presence-case mutation. The acceptance binds, so the clause is unmeetable as written: a planning commit's business.
  - a2 also found a **round-11 cliff**: from round 11, `caretToEndOf`'s click lands out of bounds and stays broken (a test-side geometry or scrolling problem, not timing). It set `MAX_ROUNDS = 8` under a `BUDGET_MS` wall clock.
- **Runner:** idle after `STUCK`. The tmux pane `essaydown:runner` (pid 8940) is at `zsh`. Restart: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 3 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher:** stopped. runner.log has 211,185 lines. After the restart, arm this as a persistent Monitor at `wc -l` + 1 (30-minute cap):
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=START; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  Never add a free-text term to its filter.
- **Expected next stop signal:** none until 3.10 is resolved. After that, the chain runs 3.11 → 3.16 → 3.1 … 3.6 → `3.verify` → `HUMAN_GATE 3.verifyh`.

## Corrections

- `060` Current State: "runner.log has 206,971 lines". It now has 211,185.
- `060` Next Steps 4 and `next-prompt.md` at `060` step 4: the restart after a boundary planning commit made outside the runner must first run `ralph/ralph.sh sync-state`, then `ralph/ralph.sh run --phase 3 --dry-run`. Restart only when the dry run names the expected first task (#051). Without it, the runner started 3.1 from the cached old graph.
- `next-prompt.md` at `060`: the reconciliation is `PRINCIPAL 3.7.r<k>d`. The Phase 3 review set id is `3.7`, not `3.10`.
- The principal told Michael that N5, N7 and I7 were open housekeeping. All three were already done (N5 at #043; N7's `if: always()`; I7 in `gate.mjs:114`). #050 closes them on the backlog.

## Decisions

All on `phase/3`, landed while the runner was idle:
- **#047** Windows kept, macOS first: Linux and macOS required, Windows recorded (`continue-on-error`) until Michael can test it. #045 Decision 2 is withdrawn.
- **#048** PRD §4 corrected: only `tauri-plugin-wdio-webdriver` is linked (U25); the config directory is the bundle-id one, `com.savagesystems.essaydown` (U16). U16's dev-machine hazard is re-pointed to `5.verify`.
- **#049** A CLAUDE.md / AGENTS.md rule: a long command runs as one foreground call bounded by `timeout 540`, output to a file, never backgrounded or waited on.
- **#050** The planning commit:
  - 3.8–3.16 come before 3.1 (3.1 depends on 3.16); EXPECTED_COUNT 338.
  - Michael's answers: U9 task; groups O7–O9, bytes (split into 3.13 L11 + `~~`, 3.14 L9, 3.15 #030) and CI; the rename read-then-write is promoted (3.11, fixed only if it reproduces); Shift+Enter (3.16); the `:161` caret race (3.9).
  - Kept as they are: Dock check with Phase 6, `cfg(target_os)` keeps counting, the other re-pointed lines untaken (3.7.r0d gives each a trigger).
- **#051** 3.1 started from the pre-#050 cached spec; manual reset with Michael's OK (`ctx.set` under the lock, audited; logs `*.pre051`; branch `attic/3.1-pre051`); then `sync-state`, dry run, restart.
- No `retry`, no Fable brief yet, and no planning commit since #050.

## Gotchas

- **STUCK is a Fable trigger** (PRINCIPAL.md: "`STUCK` after three attempts"). Write the brief: the signal and id, the evidence paths (`.evidence/tasks/3.10/{1,2,3}.log`, `.wt/3.10`, the `[3.10]` lessons lines on `task/3.10`), what was tried, the one question, and the answer format.
- **Resolving a STUCK loop task.** 3.10 is `blocked`. `retry` sets it to pending with 0 attempts, but its text is unmeetable, so a retry alone fails again. A lesson cannot widen scope (#028). The text must change through a planning commit, and `sync-state` refuses a fingerprint change to a `blocked` task unless the id is in `allowSupersede` (which only plan resolution passes; `state.mjs`). Before choosing a route, read RUNNER-SPEC §4 / §6 and `ralph/lib/doctor.mjs` for how a blocked loop task is superseded or replaced. The candidate shape: a replacement task (`3.10.r1` or a new id) that carries 3.10's committed branch work forward, with 3.11 depending on it, and 3.10 superseded. If the runner has no route, cut to a manual procedure and record it (#023, #051).
- **After any planning commit made outside the runner:** `sync-state`, then `--dry-run`, before the restart (#051).
- **The runner is idle, not at a boundary.** A principal commit goes on `handoff/061+` from a temporary worktree, never on `phase/3` (#017). A planning commit follows whatever route the previous gotcha's reading finds.
- **3.10's branch work is good.** Gaps (a), (b), (c) and (e) are done and green, so a replacement task should start from `task/3.10`'s tree, not from scratch.

## Next Steps

1. One-line state to Michael, then his answer to the open question below (he was asked before the STUCK and has not answered).
2. Fable brief on `STUCK 3.10` with Michael's answer as the constraint; the question is the replacement route, not the A/B choice.
3. Write the planning change on Michael's answer and the route Fable and the RUNNER-SPEC reading give. Then `generate-tasks`, `EXPECTED_COUNT`, `validate-tasks: OK`, `sync-state`, `--dry-run`, restart, and a fresh watcher.
4. Backlog line for the round-11 cliff (test-side, `MAX_ROUNDS = 8` holds), with a trigger: the next robustness change or `3.verify`.
5. Hand Michael `git push origin phase/3` when convenient.

## Open Questions

- **3.10 gap (d), Michael's call:**
  - **A (recommended):** allow one debug-only startup line, `#[cfg(debug_assertions)] eprintln!("essaydown: debug build started")` in `lib.rs`, so the presence case has a real backend line, scoped to the replacement task.
  - **B:** drop gap (d) back to the backlog; the backend "log clean" check stays unable to fail.
- The round-11 robustness cliff: backlog it (the principal's default), or have a task chase it?

## Addendum (same session, after the rotation)

- **Proposal 002 (agent context split) is accepted, with the principal's seven revisions (Michael, 2026-10-05).** The plan is `docs/proposals/002-agent-context-split.md`; its §7 holds the revisions and binds. The advisor's drafts are preserved, unapplied, under `docs/proposals/002/*.proposed.md`, and no file there is named `CLAUDE.md` or `AGENTS.md`.
- **Land it at the Phase 3→4 boundary, after `3.close`.** That is one principal commit on `phase/4` per §7's Landing paragraph: the drafts with §7 applied, the PRD, RUNNER-SPEC and BUILD-DEFAULTS edits, the conformance test, the entrypoints, and a DECISIONS entry. Then the runner tests, an image rebuild, `sync-state` and a dry run, then the restart. Never apply it during Phase 3.
- **Watch item until then:** CLAUDE.md line 36 still says "Playwright only for pure-web dev routes (Phases 0–1)", while 3.12, 3.14 and 3.16 require new `e2e/web` cases. Task 2.21's precedent says agents read the parenthetical as the specs' origin, not a ban. If one stops on it anyway, that conflict is the principal's to resolve with a planning note, not a lesson (#028).

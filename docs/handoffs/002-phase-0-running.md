# Handoff 002 — Phase 0 running (0.0–0.2 passed, gate 0.2h accepted, 0.3 in flight)

Written 2026-09-06 by the principal (Claude Code, Remote Control session in tmux `essaydown`, window 0 `principal`, on the Mac Mini), at half context. Role, reading order and rules: `docs/PRINCIPAL.md`. Supersedes `002-phase-0.md` (kept for its Files Produced list). Previous: `001-bootstrap.md`. Next: `003-*.md`.

## Current State

- `phase/0` tip `3fdfd3a`. Passed: 0.0 (`d8f493e`), 0.1 (`4f4ace9`, 78 files), 0.2 (`fbde8e2`, `.github/workflows/ci.yml`), gate 0.2h (ACCEPT a1). Running: 0.3 (Opus, attempt 1, started 2026-09-06 ~07:00Z). `doctor` clean. `main` untouched at the seed `660f3aa`. Nothing pushed except what `gate.sh` pushes (`ci/*` refs, deleted after fetch; none left on origin).
- **Runner**: tmux session `essaydown`, window 1 `runner`, pane 1.0 (pid 8940 shell). It runs `ralph/ralph.sh run --phase 0 2>&1 | tee -a .evidence/runner.log` and exits at every stop signal; restart it with `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 0 2>&1 | tee -a .evidence/runner.log' Enter`. Attach from a phone: `tmux attach -t essaydown`, `Ctrl-b 1`.
- **Watcher** (background Bash, stopped at rotation; re-arm each session, one per stop signal). Exact command used:
  ```
  cd /Users/mlsavage/Developer/essaydown; until grep -q "0.3 attempt 1 (loop" .evidence/runner.log; do sleep 10; done; start=$(grep -n "0.3 attempt 1 (loop" .evidence/runner.log | tail -1 | cut -d: -f1); until tail -n +"$start" .evidence/runner.log | grep -qE "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT) |<promise>COMPLETE"; do sleep 60; done; tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT) |^\[ralph\] |stop-check" | tail -12
  ```
  (run with `run_in_background`, timeout 3600000; replace the `0.3 attempt 1` marker with the task/attempt just started). Read the outcome of an attempt from its transcript's final `result` event: `.evidence/tasks/<id>/<n>.log`, `subtype` (`success` | `error_max_turns`), `num_turns`, `result`.
- **Gate evidence pattern (0.2h)**: `.evidence/ci/0.2h/accepted.json` = `{attempt: 1, run_id: "34017685563", ref: "ci/0.2/a1", sha: "fbde8e2521bb092520e9f473cc9e46e7d48f1016", run_url: https://github.com/MLSavage/essaydown/actions/runs/34017685563, workflow: "ci.yml", artifacts: [{name: "test-logs", sha256: "9b1a9b61…c5cc8", bytes: 17242}]}`; `a1/` holds `run.json` (written before the wait), `result.json`, `workflow.log`, `test-logs/{lint,test,cargo-test}.log`; `accepted` → `a1`. The ci ref was deleted after fetch. The machine check is workflow conclusion + named artifacts present + digests; the prose `ciAcceptance` is for reviewers. Every later gate (`0.verifyh`, …) looks the same.
- Container logins done once (Claude, Codex, Grok) in named volumes (DECISIONS #012). `.ext/build-defaults` pushed (`8573e0e`).
- **DECISIONS**: #009 (bootstrap commits + runner readings), #010 (push policy; `.claude/settings.json` deny list: `git push --force*`, `git push -f*`, `git push --delete*`, `git push*:*`, `git tag -d*`, `gh release*` — unchanged, in force), #011 (public repo for Actions minutes; fixture essay agent-written), #012 (container credentials), #repair-0.1, #repair-phase0-checkout on `phase/0`; #013 (agent finding: actionlint gap) and #014 (act needs Docker → `actionlint` + `act --list`) landed via `task(0.2)`. Nine `##` entries in `docs/DECISIONS.md` on the tip.
- **Evidence backup**: launchd agent `com.savagesystems.essaydown.evidence-backup` loaded (exit 0), hourly additive rsync to iCloud Drive `essaydown-evidence/`, last log line `2026-09-06T06:39:30Z ok`; restore command in `docs/RESTORE.md`. BUILD-DEFAULTS §8 says iCloud is full; check `/tmp/essaydown-evidence-backup.log` if a run ever says anything but `ok`.

## Corrections

- `001-bootstrap.md` / `PREFLIGHT.md` §0.5: host login state cannot be mounted (macOS Keychain); in-container logins in named volumes instead (DECISIONS #012). Its Grok read-only-mount gotcha is moot. Both of its open questions are closed (fixture essay agent-written, Grok state `$HOME/.grok/auth.json`).
- `002-phase-0.md` said "expect `HUMAN_GATE 0.2h` roughly an hour after login": it took 0.1 four attempts and 0.2 three; the causes are below and fixed.
- The 0.0 acceptance phrase `ralph/ralph.sh --dry-run` is implemented as `ralph/ralph.sh run --dry-run`.

## Deviations from RUNNER-SPEC noticed so far (each recorded in DECISIONS or a commit; none adds machinery)

1. Lock is an `O_EXCL` file with stale-pid recovery, not `flock` (macOS host). — #009
2. Repo mounted at `/work` and at its host path so git worktrees resolve in the container. — #009
3. Credentials: container-owned named volumes, in-container logins; "mounted read-only" satisfied in spirit only. — #012
4. `interactive-principal` tasks and plan requests complete via `<promise>DONE <id></promise>` in a commit message. — #009
5. A `superseded` gate counts as satisfied for the fix tasks that still name it (generator rewrites `X`→`Xh`); runner warns about un-rewired dependents. — #009
6. Close records: branch refs checked by ancestry, tags by equality (`main` and the next branch advance). — #009
7. Reviewers run as detached children polled by exit-code files. — #009
8. `r≥1` review attempts, `.g<n>` repairs and `.r<n>` approval retries are physical tasks in PRD §8 written by the planning commit. — #009
9. `act -n` needs a Docker daemon: in-container acceptance for workflow tasks is `actionlint` + `act --list`; the three-OS proof is the gate. — #014
10. `run` stops at every stop signal including `HUMAN_GATE`, exits 3 on any signal, 0 on COMPLETE; 15 iterations per run. Restart is the principal's job.
11. Journal-less / commit-less attempts count toward the three-attempt STUCK (was a gap). — `a77d3cb`
12. No "setup" 30-turn budget: every implementation task gets 50 turns (0.1 died at turn 31 twice). — `a77d3cb`, lessons
13. After `update-ref` moves a branch, a checkout on it keeps a stale index; the runner now refreshes clean checkouts and `doctor` reports `stale-checkout`; the principal commits on the host checkout only with `doctor` clean. — `76774f2`, #repair-phase0-checkout
14. The principal must not append to `docs/DECISIONS.md` or the journal on the phase branch while a task is in flight (rebase conflict at integration); do it at a stop signal. — lessons, this file
15. Squashed-commit subject stops at a sentence end (`task(0.2)` read "CI:"). — `3fdfd3a`
16. `boundary-check` prints `tauri-driver MISSING (USAGE…)`: cosmetic (binary present; `cargo install --list` reads the agent's empty CARGO_HOME). Fix rides with the next task touching `docker/`.
17. An agent wrote a DECISIONS entry (#013) for a missing tool per PRD §9.4; accepted as an "agent finding" heading, never attributed to Michael.
18. The 0.0 image lacked tools that acceptances name (`actionlint`, `act`): an acceptance that names a tool is a pin bootstrap must provide. — `30373f1`, lessons

## Gotchas for the next session

- Read the three transcripts you did not see (0.3 `1.log` first). `NO-JOURNAL` = the agent ended without a journal line (often max turns or "I'll pick up later"); read the `result` event before retrying. Lessons for a retried task go into **its worktree** (`git -C .wt/<id> cherry-pick` of a `phase/0` lessons commit, identical patch so the rebase skips it) — and never start the runner with a cherry-pick left unresolved.
- Fake gate for tests is `RALPH_CI_ADAPTER=fake`; the real one uses `gh` on the host. `gate.sh <id>` takes no flags for CI gates.
- `.evidence/runner.log` is the runner's full stdout (stream-json transcripts included); grep `^\[ralph\]` and the signal names.
- `docker compose run` needs `ESSAYDOWN_ROOT` (root `compose.yml` defaults it from `PWD`).

## Next Steps

1. Re-arm the watcher for the running task; restart the runner after every stop signal.
2. Tasks 0.3–0.11 (Opus/Sonnet). Expected next stop: `HUMAN_GATE 0.verifyh` (after 0.verify freezes dependencies and passes the suite) → Michael: `scripts/gate.sh 0.verifyh` → expect `ACCEPT 0.verifyh a1 run <id>`; evidence under `.evidence/ci/0.verifyh/`.
3. Review set 0.12: the runner records `.evidence/reviews/0/r0/{phase_base_sha, verifier_id (0.verify), verification_sha, implementation_sha}`, asserts the two SHAs equal, creates `.wt/review-{claude,sol,grok}` at `implementation_sha`, runs the three services in parallel (first real use of `claude-review`, `codex-review`, `grok-review`; watch `.evidence/reviews/0/r0/<who>/transcript.log`; a failed reviewer → `STUCK`, `ralph.sh retry 0.12.r0<a|b|c>`).
4. `PRINCIPAL 0.12.r0d` — reconciliation needs: the three `report.md`/`status.json`; copies to `docs/reviews/phase-0-r0-{claude,sol,grok}.md`; `DECISIONS.md#review-0-r0` with `verdict: PASS|FAIL` (the runner reads exactly that line), findings with severity/disposition; no human `recordTarget` records in Phase 0 (only CI gates, evidence-only); class-level lessons appended; `docs/progress.md` regenerated (current state ≤ 6 lines + last 5 journal entries + metrics per PRD §10.4); `docs/V1.1-BACKLOG.md` for nits; on FAIL the fix tasks + `0.verify.r1` + `0.12.r1a/b/c/d` written physically into PRD §8 with `node ralph/generate-tasks.mjs` and `node ralph/validate-tasks.mjs` green, close rewired to `0.12.r1d`; journal line; commit `wip(0.12.r0d): …` with `<promise>DONE 0.12.r0d</promise>`; `ralph.sh run` integrates, syncs state and runs `0.close` (moves `main`, creates `phase/1`). Reviewers must review `ralph/` (this runner) as hard as `packages/core`; hand them this list of deviations.
5. Then handoff 003 and a rewritten `next-prompt.md`.

## Open Questions

- Whether Grok's headless mode behaves in the container (learned at 0.12.r0c; RUNNER-SPEC §2 host fallback exists).
- Ollama for 5.3b (deferred, PREFLIGHT).

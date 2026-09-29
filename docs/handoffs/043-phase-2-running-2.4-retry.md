# Handoff 043: Phase 2 running, `2.4` under its first retry

Written 2026-09-26 by the principal: the Opus 5.5 session that restarted the runner after `2.1.g1h`, in Claude Code on the Mac Mini. Supersedes `042-phase-2-2.1.g1h-accepted.md` (on `handoff/042`, not in the tree). This commit is on `handoff/043`, **stacked on `handoff/042`** → `handoff/041` → `handoff/040`. `2.10.r0d` cherry-picks `phase/2..handoff/043` as one range. The next handoff is `044-*.md`.

## Current State

- **Branches.**
  - `phase/2` is at `b8d47e5` `task(2.3)`, 212 commits, not on origin (`git ls-remote` lists `main`, `phase/0`, `phase/1`, `ci/2.1/a1`).
  - `main` and origin `main` are at `92a2ec1`.
- **Status.** `Phase 2, 2.4 running; last passed 2.3; gates open: none; plan requests: none; blocked: none`. `doctor` clean; host checkout clean on `phase/2`.
- **Phase 2 progress.**
  - Passed: `2.1`, `2.1.g1`, `2.1.g1h` (ACCEPT), `2.2` (attempt 3, `1671091`), `2.3` (attempt 1, `b8d47e5`).
  - Running: `2.4`, **first retry** (the runner counts it as attempt 1 again), started at runner.log line 155,185.
  - Pending after it: `2.5` through `2.9`, `2.verify`, `2.verifyh`, `2.10.r0a/b/c/d`, `2.close`.
- **2.4 before the retry.** Logs moved aside as `.evidence/tasks/2.4/{1,2,3}.r0.log` (#027).
  - r0 a1 capped at 81 turns ($4.00); recovery commit `d31eaaf` swept implementation only.
  - r0 a2: 92 turns, $3.25, unit suite green (4836), journal `Blocked`; fixed a real `getText()` trailing-newline bug; stopped on the e2e "3:10 hang".
  - r0 a3: 22 turns, $0.49; started the e2e with `run_in_background`, ended its turn to wait, and headless `-p` ended the session → `STUCK 2.4 (no journal entry)`.
  - Principal lesson `8345dea` on `task/2.4` (Fable's reading, verified), then `ralph/ralph.sh retry 2.4`.
- **Runner.** tmux `essaydown:runner` (pid 8940) is running `ralph run --phase 2`. Restart if it exits: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 2 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher.** Stopped at rotation. runner.log was 155,229 lines at this writing; re-read `wc -l < .evidence/runner.log` and set `start` to that + 1, then run `status` and grep the log from line 155,185 for any signal the gap swallowed:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=<count+1>; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  - `<count+1>` is an instruction for this file only; the command you run carries the number. Run it as a persistent `Monitor`, 30 min cap, re-armed with `status` on every expiry.
  - Current marker: `[ralph] 2.4 attempt 1 (loop, sonnet, max-turns 80)`; the next is `2.4 attempt 2` or `2.5 attempt 1`.
- **Expected next stop signal.** `HUMAN_GATE 2.9` (Michael's observation gate), unless `2.4` stops again (`STUCK`/`NO-JOURNAL`).

## Corrections

- `042` (on `handoff/042`) expected the tasks to run through to `2.9`; `2.2` hit `NO-JOURNAL` and `2.4` hit `STUCK` (below).
- `042`'s watcher `start` (150,571) is stale; use the count rule above.

## Decisions

- No DECISIONS entry this block. DECISIONS.md on `phase/2` still ends at #043; #044–#045 are on the stack.
- **`NO-JOURNAL 2.2`** (attempt 2 completed attempt 1's stub and ran no `journal.mjs stub`, lesson [1.29]): principal lesson `7fb6667` on `task/2.2`, runner restarted, no `retry`, no log move (memory: NO-JOURNAL keeps the task `running`). Attempt 3 passed.
- **`STUCK 2.4`, first retry** (no DECISIONS entry needed for a first retry, #038). Fable brief per PRINCIPAL.md (STUCK after three). Fable's reading, verified by the principal: the "hang" is `@wdio/tauri-service`'s `beforeCommand` → `ensureActiveWindowFocus` (installed `dist/esm/index.js` ~3024) calling `browser.tauri.execute`, whose non-embedded path (~3270) loops 100 × (execute + 50 ms) before "Tauri plugin not available", because the app registers `tauri-plugin-wdio-webdriver` only — ~6 s per `$()`/click (the "Failed to get window states" line every ~6 s in r0 a2), which overruns mocha's 60 s per-test timeout. Not container-only: ubuntu-latest CI takes the same route. The lesson directs `browser.execute` polling, `$()` once per real action, `browser.reloadSession()` for "relaunch", one foreground e2e call bounded by `timeout 540`, a new journal stub first. **Deviation from Fable:** Fable proposed raising `mochaOpts.timeout` to 180 s; the lesson keeps 60 s (#039).

## Gotchas

- **Headless attempts that wait end.** An agent that backgrounds a long command and ends its turn to wait is over (2.4 r0 a3). The 2.4 lesson names the foreground form; if another task repeats it, the same lesson shape applies.
- **The 6 s-per-command e2e tax** applies to every shell e2e spec until `tauri-plugin-wdio` is registered (see Open Questions). A later e2e task that times out is probably this, not the driver.
- **Watcher expiry second.** The `NO-JOURNAL 2.2` line landed in the watcher's expiry gap and was caught only by the `status` + grep on re-arm. Always do both.
- **`status` shows finished attempts.** While attempt 2 ran, `status` read `running attempt 1`.
- If `2.4` stops again this is the **second** retry: a DECISIONS entry on `handoff/NNN` first (#038); a third is Michael's.

## Next Steps

1. Session start: `status`, `doctor`, `git status --short`; `wc -l < .evidence/runner.log`; arm the watcher at count + 1; grep from 155,185 for anything missed.
2. On `2.4` passing: nothing to do. On `STUCK`/`NO-JOURNAL 2.4`: read the new `.evidence/tasks/2.4/<n>.log` against lesson `8345dea` (did it poll via `execute`? did `reloadSession` work? per-test wall times), then the #038 DECISIONS entry on the stack before any second retry.
3. On `HUMAN_GATE 2.9`: hand Michael the `scripts/gate.sh 2.9` command.
4. Rotate at every stop signal that ends a working block and before ~150k. `PRINCIPAL 2.10.r0d` is run by a fresh session and cherry-picks `phase/2..handoff/NNN`.

## Open Questions

- **For Michael (not urgent; natural time is the Phase 2 boundary with #045's Windows change):** register the WDIO backend plugin so shell e2e stops paying ~6 s per command — `tauri-plugin-wdio` (already in PRD §4 line 48, debug-only) plus the npm `@wdio/tauri-plugin` frontend import and `withGlobalTauri: true` (neither in PRD §4, so a DECISIONS note and his OK) — as a boundary harness task; or accept the tax on every Phase 2–6 shell spec.

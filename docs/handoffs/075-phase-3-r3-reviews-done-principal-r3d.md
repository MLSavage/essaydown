# Handoff 075: Phase 3, r3 reviews done → `PRINCIPAL 3.7.r3d` (reconciliation, fresh session)

Written 2026-10-07 by the principal, the Opus 5.5 session that continued from 074. It answered `plan.3.verify.r3.g1h.r0` (DECISIONS #058). It then ran the runner through 3.30 and `3.verify.r3.g2`, ran the `3.verify.r3.g2h` gate (ACCEPT a1), and restarted the runner through the r3 reviews. It rotated at `PRINCIPAL 3.7.r3d` because the reconciliation is run by a fresh session. This handoff supersedes `074-phase-3-r3-g1-gate-failed-plan-gate.md`.

This handoff is on `handoff/075`, cut from `phase/3` at `1508473`. 074 and #057 are already in `phase/3` (inside `f87e8c0`, the plan), so the stack is this one commit. Read it with `git show handoff/075:docs/handoffs/075-phase-3-r3-reviews-done-principal-r3d.md`. The next handoff is `076-*.md`.

## Current State

- **Branches.**
  - `phase/3` is at `1508473` `task(3.verify.r3.g2)`, the same as origin (Michael pushed it this block).
  - `main` is at `da7d07b`.
  - `handoff/075` holds only this handoff. `handoff/061`–`074` are stale; delete them after `3.close`.
- **Status:** `Phase 3, 3.7.r3d principal-pending; last passed 3.7.r3b; gates open: none; plan requests: none; blocked: none`. `doctor` is clean.
- **Passed since 074:**
  - the plan `plan.3.verify.r3.g1h.r0` (`f87e8c0`), which carries #057 and handoff 074;
  - **3.30** (sonnet, attempt 1);
  - **3.verify.r3.g2** (sonnet, attempt 1);
  - the gate **3.verify.r3.g2h**, ACCEPT at a1 (ci.yml run 37579169198, evidence `.evidence/ci/3.verify.r3.g2h/`);
  - the reviewers **3.7.r3a** (claude) and **3.7.r3b** (sol), both at attempt 1.
  - `3.verify.r3.g1h` is `superseded`.
- **The runner's spec comes from `phase/3` again.** #057's handoff-ref deviation ended when the plan integrated (`ralph/lib/run.mjs:250`).
- **The r3 reports** are at `.evidence/reviews/3/r3/claude/report.md` and `.evidence/reviews/3/r3/sol/report.md`. Sol's directory also holds its probe and evidence files. Neither report has been read by a principal.
- **WARN 3.7.r3b** (runner.log line 272764): `transcript names a sibling's report of this attempt (claude ×1)`. The quoted context is `… inputs line, every file you read under /logs/reviews/; read no sibling directory of this attempt.","acceptance":"/logs/reviews/3/r3/claude/report.md …`. That looks like `3.7.r3a`'s row in `ralph/tasks.json` echoed in Sol's transcript, which would be a mention, not a read. The reconciliation decides (#025, #044) by reading the transcript around that match.
- **Runner:** idle at `PRINCIPAL 3.7.r3d`, in pane `essaydown:runner` (pid 8940) at `zsh`. `.locks/` is empty, and runner.log is 272766 lines.
  - Restart: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 3 2>&1 | tee -a .evidence/runner.log' Enter`.
  - `.wt/3.7.r3d` on `task/3.7.r3d` was created by the runner.
- **Watcher:** stopped at rotation. After the reconciliation restart, arm a persistent Monitor (30-minute cap). Set `start=` to `wc -l < .evidence/runner.log` + 1, read at restart:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=START; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  - `START` is the number you compute. Write the digits in, never the word.
  - When re-arming mid-block, skip the lines already reported with awk (`NR<=k { seen[$0]=1 }`), where `k` is a count you grepped.
- **Expected next stop:** after a PASS reconciliation, the runner integrates `3.7.r3d` and runs `3.close` (`CLOSED` / the Phase 3→4 boundary). On a blocker, nothing restarts until Michael answers.

## Corrections

- **074, Current State "The slowest per-paragraph test was 7,465 ms on ubuntu, 5,255 ms on macOS and 7,380 ms on Windows":** wrong file. Those are `packages/editor`'s N2 leg. rewrite.test.ts's slowest per-paragraph test is 1,012 / 464 / 1,030 ms (ubuntu / macOS / Windows). #058 records it.
- **074, "The runner's cached spec comes from `handoff/074`" and "the reconciliation `3.7.r3d` must cherry-pick `phase/3..handoff/074`":** stale. Both are in `phase/3` via `f87e8c0`. The reconciliation cherry-picks `handoff/075` (this one commit).
- **074, Next Steps 3–4:** done.

## Decisions

- **DECISIONS #058** (in `f87e8c0`, the plan):
  - The g1h failure went to rule (a), `.g2`. It was deterministic on three OSes; the rules fully determined the route, so it was not raised with Michael.
  - **Fable (written brief), decision A, confidence high:** 3.30 adds only the trailing `30_000` to the per-fixture sum test and the corpus totals test. The CI durations were 13.4 s on the slowest OS against 30 s. The cheaper count pass was rejected: its only possible measured duration is a container number, which #039 forbids, and it would be a "while I'm here" change.
  - The plan appended 3.30 and `3.verify.r3.g2` (whose gate is `3.verify.r3.g2h`). It rewired `3.7.r3a/b`'s producer id to `3.verify.r3.g2` and their evidence path to `g2h`; the generated deps were verified with `node -e`. `EXPECTED_COUNT` 372 → 375.
  - It records #057's handoff-ref deviation as ending at integration.
- **No runner deviation this block.** The plan's integration printed no `WARN`.

## Gotchas

- **The WARN on 3.7.r3b** is the runner's sibling-name scan over the whole transcript. A reviewer that reads its own task row, or `ralph/tasks.json`, echoes the sibling's row and its report path. Decide from the transcript lines around the match, never from the WARN text alone (#044).
- **The reconciliation commit touches only `docs/**`, `ralph/tasks.json` and `ralph/EXPECTED_COUNT`** (RUNNER-SPEC §8.1). It appends its own `- [3.7.r3d] ` journal line in the same commit; check the journal's last byte first. The promise goes only in the commit message.
- `scripts/gate.sh` prints `ROTATE-PRINCIPAL` after every gate. It is advisory; rotate at the next stop that ends a working block or near 150k.
- The host has no pandoc: `docker run --rm -i --entrypoint pandoc essaydown-dev:0.0 -f gfm -t html < file`.

## Next Steps

1. Run `status` (expect `3.7.r3d principal-pending`) and `doctor` (expect clean).
2. **Reconciliation `3.7.r3d`**, in `.wt/3.7.r3d` on `task/3.7.r3d`:
   - `git cherry-pick handoff/075`;
   - read `.evidence/reviews/3/r3/{claude,sol}/report.md` and copy them to `docs/reviews/phase-3-r3-{claude,sol}.md`;
   - decide the `WARN 3.7.r3b` as read or mention (#025, #044), from Sol's transcript around the match;
   - brief Fable in writing on the verdict (PRINCIPAL.md trigger: a review reconciliation's decisions);
   - write DECISIONS `#review-3-r3` and regenerate progress.md's current state;
   - commit `wip(3.7.r3d)` with the promise only in the message and its own `- [3.7.r3d] ` journal line.
   - **On PASS:** no planning rows. Restart, arm the watcher, and `3.close` follows.
   - **On a blocker:** it goes to Michael before any planning commit (#041 D1). The task stays principal-pending until he answers.
3. After `3.close`, at the Phase 3→4 boundary: raise the Open Questions below with Michael, delete `handoff/061`–`075`, and hand Michael the pushes.

## Open Questions

- **Michael (Phase 3→4 boundary, carried from 067–074):**
  - Fable's both-legs rule for e2e/shell tasks.
  - Which re-pointed hard stops become tasks before `4.verify`: the coverage glob G7/U10/C12, `packages/modes` G1, the typescript range U26/G6, and C2 + C13.
  - Whether any line of 3.26's `[3.26, other single-it corpus sweeps on the default budget]` list should be taken before `4.verify`.
  - Whether r1's two riskiest things (the source-view burst during an awaited flush; the §6.2 occurrence-shift between duplicate sentences) become Phase 4 tasks or backlog lines.
  - Whether the `\|`-in-a-cell parse divergence (`#review-3-r2`) becomes a task before `4.verify`.
  - The autosave `:91` 600 ms margin (#056). It did not recur at g1h or g2h.
  - **New (#058):** 3.30's backlog line, a cheaper `cardCountOf` if either `corpus identity totals` test goes over `30_000`. It is listed for information; it has a trigger and needs no decision now.

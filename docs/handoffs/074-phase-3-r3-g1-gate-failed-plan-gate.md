# Handoff 074: Phase 3, `3.verify.r3.g1h` GATE-FAILED a1 → PLAN-GATE `plan.3.verify.r3.g1h.r0`

Written 2026-10-07 by the principal, the Opus 5.5 session that continued from 073. It answered `plan.3.verify.r3h.r0` (DECISIONS #056: 3.29 + `3.verify.r3.g1`), restarted the runner through 3.29 and `3.verify.r3.g1`, corrected #056's missed reviewer rewire on `handoff/074` (DECISIONS #057), and ran the `3.verify.r3.g1h` gate (GATE-FAILED a1). It rotated at `ROTATE-PRINCIPAL` with context past ~150k. This handoff supersedes `073-phase-3-r3-gate-failed-plan-gate.md`.

This handoff is on `handoff/074`, stacked on `16072b3` (the #057 commit), which is cut from `phase/3` at `d75e722`. Neither commit is in `phase/3`. Handoff 073 is already in `phase/3` (inside `957dec9`). Read this handoff with `git show handoff/074:docs/handoffs/074-phase-3-r3-g1-gate-failed-plan-gate.md`. The next handoff is `075-*.md`.

## Current State

- **Branches.**
  - `phase/3` is at `d75e722` `task(3.verify.r3.g1)`. Origin is at `27c6c86`, so `phase/3` is 3 ahead: `957dec9` plan, `c1da6fc` 3.29, `d75e722` 3.verify.r3.g1. Michael pushed `27c6c86` this block.
  - `main` is at `da7d07b`.
  - `handoff/074` holds two commits: `16072b3` (#057) and this handoff. `handoff/061`–`073` are stale; delete them after `3.close`.
- **Status:** `Phase 3, idle; last passed 3.verify.r3.g1; gates open: none; plan requests: plan.3.verify.r3.g1h.r0:pending; blocked: 3.verify.r3.g1h:blocked`. `doctor` is clean.
- **Passed since 073:**
  - the plan `plan.3.verify.r3h.r0` (`957dec9`);
  - **3.29** (sonnet, attempt 1);
  - **3.verify.r3.g1** (sonnet, attempt 1).
  - `3.verify.r3h` is `superseded`.
- **The runner's cached spec comes from `handoff/074`, not `phase/3`** (DECISIONS #057). It was loaded with `ralph/ralph.sh sync-state --ref handoff/074`. In it, `3.7.r3a` and `3.7.r3b` depend on `3.verify.r3.g1h`; `phase/3`'s `ralph/tasks.json` still says `3.verify.r3h`. Any planning commit must carry the #057 rewire:
  - **A runner-integrated plan** syncs from its own candidate. If that candidate lacks #057, the reviewers drop back to the superseded `3.verify.r3h`. While they are `pending` that is allowed but wrong.
  - **The reconciliation `3.7.r3d`** must cherry-pick `phase/3..handoff/074`, or the newest stack. Otherwise the next `sync-state` refuses: once the reviewers pass, it sees changed dependencies (`was mutated`).
- **Gate `3.verify.r3.g1h` a1: GATE-FAILED.** ci.yml run 37575244182, ref `ci/3.verify.r3.g1/a1` at `d75e722`; evidence in `.evidence/ci/3.verify.r3.g1h/a1/`.
  - **e2e-shell:** green on all three OSes. The r3h transients (produce typewriterScroll, autosave `:91`) did not recur.
  - **`test`:** failed on ubuntu, macOS and Windows, with no `cargo-test.log` on any of them (each job stopped at the `test` step). The failure is the same on all three: 1 failed / 7379 passed, `packages/core/test/rewrite.test.ts:199` `applyUseVariant > essay-fixture.md > essay-fixture.md: its paragraphs' counted cards sum to the fixture's card count (corpus identity totals)`, `Test timed out in 5000ms`.
  - **Cause, code-caused and deterministic:** 3.29 added this per-fixture sum test with no trailing timeout, so it ran on Vitest's default 5000 ms. It calls `cardCountOf(name)`, which is uncached at that point. That is a full `stateOf` + `rewriteCards` pass over every paragraph of essay-fixture. The container passed it; CI runners are 6–8× slower (#039).
  - **3.29's split itself works.** The slowest per-paragraph test was 7,465 ms on ubuntu, 5,255 ms on macOS and 7,380 ms on Windows, each against `30_000`. The whole file took 50.6 s on ubuntu.
- **Expected next work:** a `.g2` repair through `plan.3.verify.r3.g1h.r0`: fix task **3.30**, plus **3.verify.r3.g2** and its gate **3.verify.r3.g2h**. The next stop after that plan is `HUMAN_GATE 3.verify.r3.g2h`. After an ACCEPT, the runner runs `3.7.r3a/b` and stops at `PRINCIPAL 3.7.r3d`. `EXPECTED_COUNT` is 372 now and becomes 375 with the three new rows.
- **Runner:** idle, pane `essaydown:runner` (pid 8940) at `zsh`, `.locks/` empty, runner.log 269243 lines.
  - Restart: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 3 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher:** stopped at rotation. On restart, arm a persistent Monitor (30-minute cap) with `start=` set to `wc -l < .evidence/runner.log` + 1, read at restart:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=START; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  `START` is the number you compute. Write the digits in, never the word. When re-arming mid-block, skip the lines already reported with awk (`NR<=k { seen[$0]=1 }`), never with `tail -n +k` on a count you did not grep.

## Corrections

- **073, Current State "Next tasks after the plan … then `3.7.r3a` (claude) and `3.7.r3b`" and "Expected next stop":** stale. The r3 reviewers now follow `3.verify.r3.g2h`, once the next plan lands.
- **DECISIONS #056, "The graph" bullet "`3.7.r3a`/`3.7.r3b` now depend on `3.verify.r3.g1h`":** false as integrated (`957dec9`). It is corrected by #057 on `handoff/074`; DECISIONS is append-only, so #056 is not edited.

## Decisions

- **DECISIONS #056** (in `957dec9`, the plan):
  - The r3h failure went to rule (a) with a `.g1` scoped to rewrite.test.ts, on Fable's written brief (high confidence). The rewrite case was over budget on Windows at r2 and on ubuntu at r3h; the trigger fired, so it was not transient.
  - The two e2e transients were backlogged with second-failure triggers: `[plan.3.verify.r3h.r0, produce typewriterScroll line-0 miss on ubuntu]` and `[plan.3.verify.r3h.r0, autosave :91 at 600 ms on macOS, third instance]`. The autosave line's trigger goes to Michael.
  - 3.29 and `3.verify.r3.g1` were added; `EXPECTED_COUNT` went 369 → 372.
- **DECISIONS #057** (on `handoff/074`, `16072b3`, not yet in `phase/3`):
  - **The defect:** #056's rewire of `3.7.r3a/b` was a no-op. Review rows in PRD §8 name the verifier **producer** (`"3.verify.r3"`), and the planning edit matched the gate id. The runner printed `WARN plan.3.verify.r3h.r0: pre-existing dependents … not rewired`.
  - **The fix:** `"dependencies":["3.verify.r3.g1"]`. It sits on `handoff/074` so `phase/3` stays at the verifier's SHA (§5.1), and it was loaded with `sync-state --ref handoff/074`. The `--dry-run` named `HUMAN_GATE 3.verify.r3.g1h`.
  - **Runner deviation:** the cached spec is loaded from a handoff ref until `3.7.r3d` cherry-picks it. This is a manual procedure under the cut-to-manual rule.

## Gotchas

- **A superseded gate satisfies every dependent** (`ralph/lib/state.mjs:63`), not only the plan's fix tasks. A dependent the plan forgets to rewire becomes ready at once. It was caught here only because `selectNext` reached the new gate first in spec order; otherwise `REVIEW-SHA-MISMATCH` (`run.mjs:351`) would have stopped it.
- **Verify a rewire after `generate-tasks`** by reading the generated `ralph/tasks.json`. Use `node -e` over the dependent ids before committing, never a check on the edited PRD line.
- **The running runner caches the spec in memory** (`ctx._spec`). An external `sync-state` only takes effect for the next `run`.
- **Every new test in a corpus family carries the family's `30_000`, sum and totals tests included.** 3.29's acceptance (4) allowed only `30_000` as a literal, and the agent added a test with none. The 3.30 text should require a trailing `30_000` on every `it` that calls `cardCountOf` or `paragraphCardCountOf`, with a grep that counts them.
- `scripts/gate.sh` prints `GATE-FAILED` / `PLAN-GATE` to its own output, not to runner.log; read the scratchpad output file.
- The host has no pandoc: `docker run --rm -i --entrypoint pandoc essaydown-dev:0.0 -f gfm -t html < file`.

## Next Steps

1. Run `status` (expect `plan requests: plan.3.verify.r3.g1h.r0:pending; blocked: 3.verify.r3.g1h:blocked`) and `doctor` (expect clean). Give Michael the one-line state and `git push origin phase/3` (3 ahead; recount first).
2. PLAN-GATE is on Fable's trigger list. Write Fable a brief:
   - the signal, `GATE-FAILED 3.verify.r3.g1h a1` with `PLAN-GATE plan.3.verify.r3.g1h.r0`;
   - the evidence, `.evidence/ci/3.verify.r3.g1h/a1/test-logs/*/test.log`;
   - the one question: is 3.30's scope exactly a trailing `30_000` on `rewrite.test.ts:199`'s per-fixture sum test, plus the corpus totals test (`toBeGreaterThan(names.length)`), which calls the same uncached `cardCountOf` whenever it runs without the per-fixture tests? Or should the count pass also be made cheaper (one `stateOf(markdown)` per fixture), with a measured duration?
   - The route is rule (a), `.g2`: the failure is deterministic on three OSes, so it is not a rerun.
3. Answer through the plan protocol (`ralph/ralph.sh plan plan.3.verify.r3.g1h.r0`, in `.wt/plan.3.verify.r3.g1h.r0`):
   - **First, cherry-pick `phase/3..handoff/074` (2 commits) into it**, so the plan's candidate carries #057's rewire and this handoff.
   - In PRD §8, append `3.30` (deps `["3.verify.r3.g1h"]`) and `3.verify.r3.g2` (deps `["3.30"]`, `ci/3.verify.r3.g2/a{n}`). Change `3.7.r3a/b`'s `"dependencies":["3.verify.r3.g1"]` to `["3.verify.r3.g2"]` and their `/logs/ci/3.verify.r3.g1h/accepted/` paths to `…g2h…`.
   - Set `EXPECTED_COUNT` to 375. Run `generate-tasks` and `validate-tasks`, then **read the generated deps of `3.7.r3a/b` with `node -e`**.
   - Write DECISIONS `#058`, then commit `wip(plan.3.verify.r3.g1h.r0)` with the promise only in the message.
   - Run `--dry-run` (expect the plan request), restart, and arm the watcher.
   - Once the plan integrates, `phase/3` contains #057 and the cached spec comes from `phase/3` again; then `handoff/074` is in `phase/3` by cherry-pick.
4. Run `scripts/gate.sh 3.verify.r3.g2h`, backgrounded, with its output in a scratchpad file (about 35 minutes). On ACCEPT, restart. The r3 reviews run, then `PRINCIPAL 3.7.r3d`.
5. **At `PRINCIPAL 3.7.r3d`, a fresh session runs the reconciliation** in `.wt/3.7.r3d`:
   - cherry-pick the newest handoff range not yet in `phase/3`;
   - copy `.evidence/reviews/3/r3/{claude,sol}/report.md` to `docs/reviews/phase-3-r3-{claude,sol}.md`;
   - brief Fable in writing on the verdict;
   - decide any WARN as read or mention;
   - write DECISIONS `#review-3-r3` and regenerate progress.md's current state;
   - commit as `wip(3.7.r3d)`, with the promise only in the message and its own `- [3.7.r3d] ` journal line (check the last byte first).
   - On PASS, `3.close` follows. On a blocker, it goes to Michael before any planning commit (#041 D1).
6. At the Phase 3→4 boundary, raise the Open Questions below.

## Open Questions

- **Michael (Phase 3→4 boundary, carried from 067–073):**
  - Fable's both-legs rule for e2e/shell tasks.
  - Which re-pointed hard stops become tasks before `4.verify`: the coverage glob G7/U10/C12, `packages/modes` G1, the typescript range U26/G6, and C2 + C13.
  - Whether any line of 3.26's `[3.26, other single-it corpus sweeps on the default budget]` list should be taken before `4.verify`.
  - Whether r1's two riskiest things (the source-view burst during an awaited flush; the §6.2 occurrence-shift between duplicate sentences) become Phase 4 tasks or backlog lines.
  - Whether the `\|`-in-a-cell parse divergence (`#review-3-r2`) becomes a task before `4.verify`.
  - **New:** the autosave `:91` 600 ms margin (`[plan.3.verify.r3h.r0, autosave :91 …]`). Its trigger is a fourth macOS instance, which goes to Michael. It is raised early only if he wants it settled before Phase 4.

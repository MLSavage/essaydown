# Handoff 091: Phase 4, GATE-FAILED 4.verify.r1h a1 and plan request plan.4.verify.r1h.r0

Written 2026-10-10 by the principal (Opus 5.5) that continued from 089 and wrote 090. This handoff supersedes `090-phase-4-stuck-4.28-out_path-pin.md`.

It is committed on `handoff/091`, stacked on `handoff/090`, which is stacked on `handoff/089`. `phase/4..handoff/091` holds six commits: 089's handoff, DECISIONS #067, 090, #067's Fable corrections, 090's addendum, and this one. All are docs-only, and the stack carries a DECISIONS.md tail (#067). The next principal commit on the phase cherry-picks `phase/4..handoff/091`; that is the plan request's planning commit, or 4.5.r1d. If a planning commit that itself appends to DECISIONS.md lands on `phase/4` first, rebase the stack onto the new tip as #039 records, and delete the superseded refs. Read this handoff with `git show handoff/091:docs/handoffs/091-phase-4-verify-r1h-gate-failed.md`.

## Current State

- **Branches.**
  - `main` is at `8aba511`.
  - `phase/4` is at `d1f9fa6` (`task(4.verify.r1)`). `origin/phase/4` is 7 commits behind (4.23 was pushed; 4.24–4.29 and 4.verify.r1 are not): hand Michael `git push origin phase/4`.
- **Status at writing:** `Phase 4, idle; last passed 4.verify.r1; gates open: none; plan requests: plan.4.verify.r1h.r0:pending; blocked: 4.verify.r1h:blocked`. `doctor` is clean and the host checkout is clean.
- **Passed this block:**
  - 4.23, 4.24 and 4.25 each passed on attempt 2; attempt 1 capped at 80 turns, and the runner carried on.
  - 4.26 and 4.27 passed on attempt 1.
  - 4.28 passed on its retry's attempt 1, after STUCK and #067. It is integrated as `489116e`, and `commands.rs` changed by one line.
  - 4.29 passed on attempt 2; attempt 1 capped.
  - 4.verify.r1 passed on attempt 1.
- **Gate:** `scripts/gate.sh 4.verify.r1h` printed `GATE-FAILED 4.verify.r1h a1: workflow ci.yml concluded failure`, then `PLAN-GATE plan.4.verify.r1h.r0` and `ROTATE-PRINCIPAL`. These lines are in the gate's stdout, not in runner.log.
  - The run is `38036514463` at SHA `d1f9fa6`, on ref `ci/4.verify.r1/a1`.
  - The evidence is in `.evidence/ci/4.verify.r1h/a1/`: `workflow.log`, `result.json`, `run.json` and the four artifacts.
- **The two failures:**
  1. **`test (ubuntu-latest)`** has 2 failed of 8104, and **`test (windows-latest)`** has 1 failed. macOS is green.
     - The failing cases are in `packages/editor/test/anchor-source-typing.test.ts`, in the block "the source view's commit carries the sidecar: corpus leg seeded from the source view (task 4.27)": "source leg, typed in the source view: twin at document start" (ubuntu) and "… twin at block start" (ubuntu and windows).
     - Both fail with `Test timed out in 120000ms`, at 130–155 s per case. The whole file took 326–394 s.
     - This is a per-test budget problem on CI runners: a corpus loop inside one `it`. CLAUDE.md and #039 set the family's budget at 30 s with a block-local oracle, never a multiple of a container timing.
  2. **`e2e-shell (ubuntu-latest)`** fails `export.spec.ts` (new in 4.29): "File -> Export, all four presets on a document with images (task 4.29).EPUB: passes epubcheck with 0 errors".
     - epubcheck reports `ERROR(OPF-092)` "Language tag …" at `content.opf(2,194)` and `(7,33)`, 7 times each.
     - This is the known `[plan.4.verify.g1h.r0, EPUB dc:language from the process locale]` backlog item: the CI runner's locale gives pandoc an invalid `lang`. #065 kept `lang` test-only, and the app's own export route sends none.
     - It passed in the container, which has a different locale. The macOS and windows e2e-shell legs are green.
- **`[autosave]` readings (#066):** `X: on disk after 500 ms`, `527 ms`, `552 ms` (each ×2). All are inside the window #066 set.
- **Runner:** idle. Pane `essaydown:runner` (pid 8940) is at a zsh prompt. Its restart command:
  ```
  tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 4 2>&1 | tee -a .evidence/runner.log' Enter
  ```
- **Watcher:** stopped at rotation. The raw count is 75, and the last counted line is `HUMAN_GATE 4.verify.r1h`. Use the positional watcher (090's addendum), with `n` set to the recount:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=275135; n=K; W=/tmp/essaydown-watch.txt; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] " > "$W" 2>/dev/null; c=$(wc -l < "$W"); if [ "$c" -gt "$n" ]; then tail -n +"$((n+1))" "$W" | cut -c1-400; n=$c; fi; sleep 30; done
  ```
- **Expected next stop:** none until the plan request is planned. After the repair tasks pass: the repair verifier → its `HUMAN_GATE …h` (a gate run) → `4.5.r1a/b` → `PRINCIPAL 4.5.r1d`.

## Corrections

- **090, "Next Steps 1–3":** done (090's addendum). 4.28 passed.
- **090 and 089, the awk watcher (`NR<=k { seen[$0]=1 } !seen[$0]++`):** stale. It swallows a retry's repeated lines; use the positional watcher above.
- **`next-prompt.md` on `handoff/090`:** it describes STUCK 4.28. This commit replaces it.

## Decisions

- **DECISIONS #067** (on `handoff/090`, `a272dc3` + `97f2439`): the 4.3 `out_path` pin at `commands.rs:768` yields to 4.28's S5 rename, one line. Fable was consulted under the STUCK trigger and confirmed it with high confidence.
- **Runner deviations:**
  - #067's manual procedure: a lesson, the logs moved aside as `.evidence/tasks/4.28/{1.a1,2.a2,3.a3}-blocked.log`, `retry 4.28` (the first retry of 4.28), then the restart.
  - The watcher's dedup changed from content to position (no runner change).

## Gotchas

- **Sonnet turn cap.** 4.23, 4.24, 4.25 and 4.29 capped at 80 turns on attempt 1 (`num_turns` 81). Each finished on attempt 2 in minutes. This is evidence for a max-turns proposal, which stays conditional on Michael's OK (#review-1-r1); none has been made.
- **The repair's scope.**
  - **Failure 1 is test-only.** Split the corpus loop into per-case or per-fixture tests, each within the family's budget. Never raise the timeout to a CI multiple (#039).
  - **Failure 2 sits on #065's line** (`lang` is test-only). The repair either passes a valid `lang` in the spec's own route or fixes the product's locale fallback. That is a behaviour choice, and the Fable brief decides whether it is Michael's. The backlog item's trigger may now be firing.
  - #021, #024, #037 and #039: scope the repair to what failed, and file the rest with a trigger.
- **The plan protocol.**
  - `ralph/ralph.sh plan plan.4.verify.r1h.r0` makes `.wt/plan.4.verify.r1h.r0` on `plan/4.verify.r1h/r0`.
  - The planning commit carries its promise only in its `wip(plan.…)` commit message.
  - It cherry-picks `phase/4..handoff/091` first.
  - It writes the repair tasks, the next `4.verify.g<n>` verifier and its `h` gate (`4.verify.g1`–`g3` already exist, so the next number is not 1: read RUNNER-SPEC §5.5 and `ralph/tasks.json` for the naming of a repair after an `r1h` gate), and rewired `4.5.r1a/b/d` rows (#043: no Grok on r1). The reviewer rows depend on the new verifier's producer (memory: reviewer rows depend on the producer).
  - It updates `EXPECTED_COUNT`.
  - Then `sync-state` and a `--dry-run` that names the first repair task, then the restart (#051).
- **The stale scratch worktree** `/private/tmp/claude-501/…/scratchpad/h090` held `handoff/090`. Remove it with `git worktree remove --force` on that path if it is still listed, or `git worktree prune` once the path is gone.

## Next Steps

1. Run `status` and `doctor`. Hand Michael `git push origin phase/4` (7 unpushed; recount).
2. **Fable brief** (PRINCIPAL.md: GATE-FAILED).
   - Signal: `GATE-FAILED 4.verify.r1h a1`.
   - Evidence: `.evidence/ci/4.verify.r1h/a1/workflow.log` (the job prefixes `test (ubuntu-latest)`, `test (windows-latest)` and `e2e-shell (ubuntu-latest)`), the 4.27 and 4.29 task rows, #039, #065, #066, and the backlog line `[plan.4.verify.g1h.r0, EPUB dc:language …]`.
   - The questions: the repair set for both failures; for failure 2, test-only or product, and whether the product option needs Michael.
   - Answer format: decision, reasons, confidence, commands.
3. The planning commit via `ralph/ralph.sh plan plan.4.verify.r1h.r0`, as in Gotchas. If Fable puts failure 2 on Michael, ask him before the plan.
4. Restart the runner and arm the positional watcher. Handle the stops: a capped attempt → let the runner carry on; `STUCK` → a Fable brief; the new verifier gate → `scripts/gate.sh` on that gate id, backgrounded, reading `[autosave]`.
5. At `PRINCIPAL 4.5.r1d`: rotate. A fresh session reconciles.

## Open Questions

- **For Michael:** possibly failure 2's product choice (the EPUB `lang` fallback on an invalid locale), if the Fable brief makes it his.

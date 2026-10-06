# Handoff 064: Phase 3, `GATE-FAILED 3.verifyh a1` → `PLAN-GATE plan.3.verifyh.r0`

Written 2026-10-06 by the principal, the Opus 5.5 session that continued from 063. That session took Michael's route B for 3.6 (DECISIONS #054) and watched 3.19, 3.20 and 3.verify pass at attempt 1. It ran the CI gate `3.verifyh` to GATE-FAILED and rotated at `ROTATE-PRINCIPAL`. This handoff supersedes `063-phase-3-stuck-3.6.md`.

This commit is on `handoff/064`, stacked on `handoff/063` → `handoff/062` → `handoff/061` (none is in `phase/3`; the stack carries no DECISIONS.md tail, so #054 on `phase/3` needed no rebase). It was made from a temporary worktree. Read it with `git show handoff/064:docs/handoffs/064-phase-3-verify-gate-failed.md`. The next handoff is `065-*.md`.

## Current State

- **Branches.**
  - `phase/3` is at `f897498` `task(3.verify)`. Origin `phase/3` is at `42b2267` (Michael pushed this session), so 3.19 `10225bf`, 3.20 `07738a3` and 3.verify `f897498` are not pushed (3 commits).
  - `main` is at `da7d07b`.
  - The stack `handoff/061` → `handoff/062` → `handoff/063` → `handoff/064` (this commit) is what the `3.7.r0d` reconciliation cherry-picks: `phase/3..handoff/064`.
  - Kept as evidence: `abandoned/3.6` (`9397a4a`, #054), `abandoned/3.10` (#052), `abandoned/3.13` (#053), `attic/3.1-pre051`.
- **Status:** `Phase 3, idle; last passed 3.verify; gates open: none; plan requests: plan.3.verifyh.r0:pending; blocked: 3.verifyh:blocked`. `doctor` is clean. The host checkout is clean on `phase/3`. `EXPECTED_COUNT` is 342.
- **Tasks this block (attempts):** 3.6 abandoned (#054); 3.19 a1 (`10225bf`); 3.20 a1 (`07738a3`); 3.verify a1 (`f897498`; 6910 unit tests, 78 cargo tests in the container).
- **The gate: `3.verifyh` a1 GATE-FAILED.** CI run 37423998582 (`ci.yml`) at `f897498`, ref `ci/3.verify/a1`. Evidence: `.evidence/ci/3.verifyh/a1/{workflow.log,run.json,result.json,e2e-shell/*/e2e-shell.log,test-logs/*}`.
  - **ubuntu:** `test` green; e2e-shell 15/15.
  - **macOS (required, #047):** e2e-shell 10/15 passed, 5 failed:
    - `autosave.spec.ts`: "the CRLF fixture shows the non-canonical banner once and saves as its .canonical.md". It failed with `Error: Timeout`.
    - `one-workflow.spec.ts`: step 3 failed with "producing under heading 1 never matched" (`waitForMarkdown`, spec :145, called at :315). Steps 4–6 fail after it ("Cmd/Ctrl+Enter never added the variant"; "block 8 has no text"; the source view differs from the golden).
    - `outline.spec.ts`: "delete the sidecar and reopen: the headings, with empty question fields" failed a deep-equal.
    - `reorder.spec.ts`: "keyboard-only section 3 → 1 …" failed with `[data-testid="mode-reorder"] is not on the page` (`clickCentreOf`, routes.ts:53, from `openThroughRestore`, reorder.spec.ts:138).
    - `rewrite.spec.ts`: "Cmd/Ctrl+Enter never added If anything they sharpened it." (`addVariant`, rewrite.spec.ts:167). Undo and relaunch fail after it.
  - **Windows (recorded, #047):** e2e-shell 13/15 passed. `one-workflow.spec.ts` (steps 3–6) and `rewrite.spec.ts` (add variants, undo) failed.
  - **Not read yet:** the unit and cargo counts on macOS and Windows (`test-logs/test-logs-{macos,windows}-latest/`), and whether `macos-debug-dmg` passed. `workflow.log` shows the `##[error]` exit lines only on the two e2e-shell legs.
  - Phase 3's shell specs (3.2–3.5, 3.6/3.20) were green only in the Linux container until now; this is their first run under macOS WebKit and Windows Edge. The common thread visible so far: typing into the editor and the Cmd/Ctrl+Enter chord on the embedded legs. `routes.ts` changed in 3.19 (the `clickCentreOf` scrollIntoView fix from `9397a4a`).
- **Dependents of `3.verifyh`:** `3.7.r0a`, `3.7.r0b`, `3.7.r0c` (from `ralph/tasks.json`). The planning commit rewires them to the new gate.
- **Runner:** idle after the gate (no `ralph run` process, `.locks/` empty). Tmux pane `essaydown:runner` (pid 8940) is at `zsh`. Restart: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 3 2>&1 | tee -a .evidence/runner.log' Enter`.
- **Watcher:** stopped. runner.log has 240,366 lines. After a restart, arm at `wc -l` + 1 as a persistent Monitor (30-minute cap):
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=START; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk '!seen[$0]++ { print; fflush() }'
  ```
  On every expiry, re-arm with each already-reported `[ralph] <id> attempt <n> (loop` line in a `grep -v -F -e …` list. Never add a free-text term to its filter.
- **Expected next stop signal:** none until the planning commit lands. After the restart, the repair task runs, then `HUMAN_GATE` on the new gate (`3.verify.g1h`, or the id the protocol gives).

## Corrections

- `063` Current State, "Expected next stop signal … with option B, 3.19 → 3.20 first": it held, and then 3.verify passed and its gate failed on macOS/Windows.
- `063` Current State, "Diff vs `phase/3`" omitted `e2e/shell/test/routes.ts` (+12, the `clickCentreOf` fix). 3.19 checked it out.
- `063` Open Questions: answered (route B, #054).

## Decisions

- **#054** (on `phase/3`, `42b2267`, pushed): 3.6 abandoned and replaced by 3.19 (the §146 toggle in the desktop shell, opus) and 3.20 (3.6's e2e from `9397a4a` minus the read-only stand-in, sonnet).
  - `3.verify` was rewired to `3.20`, and 3.7's golden list names `3.20`.
  - Michael approved the `settle()` seam in `packages/editor/src/store.ts` and the cut with the backlog line `[3.19, source caret does not drive the mode panels]`.
  - At Michael's prompt, the backlog wording names the no-cue surprise. In the source view, a Rewrite or Reorder action acts on the last rich-view cursor, and the fix candidate is a greyed or labelled panel. Hard stop: the Phase 3→4 boundary planning.
  - Fable confirmed route B and wrote the rows.
- No runner deviation this block. The abandon was #052's route.

## Gotchas

- **GATE-FAILED is a Fable trigger (via PLAN-GATE).** Brief Fable first. Read the macOS and Windows e2e-shell logs and the per-OS unit and cargo counts first, so the brief carries them.
- **Scope the repair to what failed** (#021, #022, #024, #037, #039): the five macOS specs, with Windows recorded. Anything else is filed with a revisit trigger.
  - The likely class is how the embedded legs type and send chords. `pressModChord`, typing through `elementSendKeys` → `execCommand('insertText')`, and WebKit dropping a repeated key are suspects, not a finding.
  - Possible app-level defects (Cmd+Enter in Rewrite on WebKit) must be told apart from spec-route defects before writing the task text.
  - Tests never encode one platform's chord (#022, #024, #037).
- **A same-SHA rerun is only for a transient failure.** Five specs failing with cascades is not transient. Any tree change is a `.g<n>` repair (RUNNER-SPEC §2, #023, #029).
- **The planning commit** goes only in `.wt/plan.3.verifyh.r0` via `ralph/ralph.sh plan plan.3.verifyh.r0`, following `6d87fdd` (the Phase 2 r1 `.g1` plan).
  - It contains the repair task, its verify and CI gate, the rewire of `3.7.r0a/b/c`, and `EXPECTED_COUNT` read from the rows added.
  - The promise goes only in the `wip(plan…)` message.
  - Reversal: `ralph/ralph.sh plan-abandon plan.3.verifyh.r0 --reason "planning change for 3.verifyh withdrawn"`.
  - If it appends to DECISIONS.md, rebase `handoff/061..064` onto the new tip from a temporary worktree (#039).
- **Never write the literal promise** into any file an agent reads; check `git diff | grep -c '<promise>'` = 0.
- **Never run pnpm, vitest or Playwright on the Mac inside `.wt/<id>`.** To reproduce WebKit behaviour on the Mac, use a detached scratch worktree.

## Next Steps

1. Run `status` (expected: idle, `plan.3.verifyh.r0:pending`, `3.verifyh:blocked`), `doctor` (clean) and `git status --short` (empty). Give Michael the one-line state.
2. Read the per-OS counts and the five macOS failures' first errors (Current State paths). Then write the Fable brief:
   - **Signal:** `GATE-FAILED 3.verifyh a1` → `PLAN-GATE plan.3.verifyh.r0`.
   - **Evidence:** the paths above, plus the 3.19/3.20 diffs.
   - **What was tried:** nothing (gate attempt 1).
   - **One question:** what is the minimal `.g1` repair that makes the macOS e2e-shell legs green without skipping a test or encoding a platform chord? Is any failure an app defect rather than a spec-route defect?
   - **Answer format:** decision, reasons, confidence, and the task text with acceptance.
3. `ralph/ralph.sh plan plan.3.verifyh.r0`, then the planning commit (Gotchas). Then `sync-state`, `doctor`, `run --phase 3 --dry-run` naming the repair task, and the restart (#051).
4. Arm the watcher at `wc -l` + 1. At the new gate's `HUMAN_GATE`, run `scripts/gate.sh <gate>` in the background, redirected to a scratchpad file. On GATE-FAILED, rotate, then brief Fable. On ACCEPT, read the per-OS cargo counts and restart. Expect `3.7.r0a/b/c` (claude-opus, sol, grok).
5. At `PRINCIPAL 3.7.r0d`, rotate. A fresh session:
   - cherry-picks `phase/3..handoff/NNN`;
   - briefs Fable;
   - applies #041 D1;
   - takes the untaken `3.verify` hard stops from 3.verify's journal entry (`grep -- '^- \[3\.verify\]' docs/progress/journal-main.md`);
   - appends its own `- [3.7.r0d]` journal line.
6. Hand Michael `git push origin phase/3` when convenient (3 commits ahead now).

## Open Questions

- **Michael:** none pending. Whether the macOS failures are app defects (for example, Cmd/Ctrl+Enter not reaching Rewrite on WebKit) is for Fable's reading. If one is an app defect that needs a product call, it goes to Michael before the planning commit.

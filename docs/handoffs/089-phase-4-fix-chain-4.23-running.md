# Handoff 089: Phase 4, review r0 FAIL reconciled → fix chain 4.23–4.29 running

Written 2026-10-10 by the principal (Opus 5.5) that continued from 088. This handoff supersedes `088-phase-4-review-4.5-r0d-reconciliation.md`.

It is committed on `handoff/089`, based on `phase/4` `d18d745`. Handoffs 087–088 are already in `phase/4`, because the 4.5.r0d reconciliation carried them. Read this handoff with `git show handoff/089:docs/handoffs/089-phase-4-fix-chain-4.23-running.md`. The next principal commit on `phase/4` (4.5.r1d, or a planning commit) cherry-picks `phase/4..handoff/089`. Delete `handoff/077`–`089` after `4.close`.

## Current State

- **Branches.**
  - `main` is at `8aba511`.
  - `phase/4` is at `d18d745` (`task(4.5.r0d)`). `origin/phase/4` is at `af5daa8`, so 1 commit is unpushed: hand Michael `git push origin phase/4`.
- **Status at writing:** `Phase 4, 4.23 running; last passed 4.5.r0d; gates open: none; plan requests: none; blocked: none`. `doctor` is clean and the host checkout is clean.
- **This block:**
  - Reconciliation `4.5.r0d` gave verdict FAIL, recorded in DECISIONS `#review-4-r0`. The commit was `226d059` on `task/4.5.r0d`, integrated as `d18d745`.
  - Counts: 33 raw findings → 29 unique.
  - Blocking under #041 D1:
    - **U1:** an EPUB with no title fails epubcheck on the product's argv.
    - **U2:** a twin typed in the rendered view takes the anchor.
    - **C4:** the same, in the source view.
    - **S3:** a Lua writer runs through the export `format`.
  - Michael approved the list, plus F4 and F5. For U1 he chose option A: the title goes in the product, sent only when the document has no front-matter `title`, and `lang` stays test-only under #065. For S4 he chose `--embed-resources` on the HTML preset, as its own task.
- **Graph now** (sequential): `4.23` (sonnet, S3+C5+C6) → `4.24` (sonnet, U1) → `4.25` (sonnet, S4 embed) → `4.26` (opus, U2) → `4.27` (opus, C4) → `4.28` (sonnet, S5+C7) → `4.29` (sonnet, export.spec e2e) → `4.verify.r1` (needsCI) → `4.verify.r1h` → `4.5.r1a` (claude) + `4.5.r1b` (sol) → `4.5.r1d` → `4.close`. `EXPECTED_COUNT` is 414.
- **Running:** `4.23` attempt 1 (loop, sonnet, max-turns 80) in `.wt/4.23`, started after the integration (runner.log line 334344).
- **Runner:** live in pane `essaydown:runner` (pid 8940, `node`). Its restart command, if the loop exits:
  ```
  tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 4 2>&1 | tee -a .evidence/runner.log' Enter
  ```
- **Watcher:** stopped at rotation. Re-arm it with `start=275135` and `NR<=k`, where `k` is the RAW grep count at arm time. It was 59 at writing, with the last counted line `[ralph] 4.23 attempt 1 …`; recount it.
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=275135; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk 'NR<=k { seen[$0]=1 } !seen[$0]++ { print; fflush() }'
  ```
  Replace `k` with the number before arming.
- **Expected next stops:**
  - No stop signal while 4.23–4.29 pass. Each new task logs a `[ralph] <id> attempt n` line.
  - Then the `4.verify.r1h` gate: `HUMAN_GATE` or a gate run (`scripts/gate.sh 4.verify.r1h`, per the 4.verify.g3h precedent).
  - After the reviewers, `PRINCIPAL 4.5.r1d`.
  - A `STUCK`, `NO-JOURNAL` or `GATE-FAILED` along the way stops the runner.

## Corrections

- **088, "`handoff/088` is the stack to cherry-pick":** it is now in `phase/4`. The 4.5.r0d commit carried it, so its diff against `phase/4` under `docs/handoffs` is empty. The new base is `phase/4`.
- **088's next-prompt job 8, "k = 58":** k is now 59.
- **`next-prompt.md` at `phase/4`:** it still describes the 4.5.r0d reconciliation. This commit replaces it.

## Decisions

- **DECISIONS `#review-4-r0`** (in `phase/4`, `d18d745`): verdict FAIL, the dispositions, Michael's three answers verbatim, and the graph.
- **Backlog:** one line, `[review-4-r0, dispositions]`, covering C9–C16 and G3–G12 with their triggers. The hard stop is `6.verify`, because `4.close`'s `nextPhase` is 6.
- **Runner deviations:** none.

## Gotchas

- **Fact behind 4.24:** pandoc 3.11 reads a front-matter `title` under `-f gfm`, and `-M title=…` overrides it. So 4.24 sends the stem title only when the document has none. This was probed in `essaydown-dev:0.0`; the scratch is gone.
- **Fact behind 4.25:** `--embed-resources` adds `role="img"`, which fails html-validate's `no-redundant-role`. 4.25 must scope that rule to exported HTML if html-validate can, and otherwise turn it off with a comment.
- **4.29 adds `e2e/shell/test/export.spec.ts`**, so the gate's spec count rises by 1: read it from the directory. It also changes ci.yml's e2e-shell job (epubcheck and html-validate installs). That job's first CI run is at `4.verify.r1h`.
- **4.23 removes `shell:allow-spawn`** and flips the `shell_scope.rs` tests.
  - If a later task or e2e depended on the webview spawn, it fails there. Nothing in the frontend calls it (`shell_scope.rs:7-9`).
- **For 4.5.r1d:** it is a fresh session's job.
  - Cherry-pick `phase/4..handoff/NNN` first.
  - Grok does not review r1+, so the rows are `a`, `b` and `d` (#043).
  - A blocker found in r1 goes to Michael before any fix chain (#041 D1).
  - Read the `[autosave]` readings from the `4.verify.r1h` accepted logs (#066).
- **Long rows:** the task rows are long. A retry lesson orients and never widens scope (#028).

## Next Steps

1. Run `status` (expect `4.2x running`) and `doctor`. Give Michael the one-line state, plus `git push origin phase/4` if it is still unpushed.
2. Re-arm the watcher (recount `k`).
3. Handle each stop signal per PRINCIPAL.md:
   - a capped attempt → a lesson plus `retry` (#027, #038);
   - a gate → `scripts/gate.sh` backgrounded, with its output file read;
   - `PRINCIPAL 4.5.r1d` → rotate, so that a fresh session reconciles.
4. Rotate at every stop that ends a working block, and before context passes about 150k.

## Open Questions

- **For Michael:** none open.

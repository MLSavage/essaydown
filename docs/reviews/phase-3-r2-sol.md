# Phase 3 review — Sol

Reviewer: Codex (GPT-6), reviewer `sol`. Inputs: docs/PRD.md §7/§8 phase 3 and §9, docs/RUNNER-SPEC.md, docs/lessons.md, ralph/tasks.json task 3.7.r2b, docs/DECISIONS.md #025/#041/#review-3-r0/#review-3-r1, docs/V1.1-BACKLOG.md, `git diff da7d07b0d3bc51857d7e18fecdf4f51c60da9421...b56c23caf8393d98bd8ff9d62303344ad2a2db03` (attempt r2), accepted CI for 3.verify.g1h, 3.verify.r1.g1h and 3.verify.r2h, phase 3 task transcripts (including 3.27 and 3.verify.r2), and /logs/human/1.9/accepted.json's payload. No phase 3 human accepted records exist. Coverage baseline: digest-verified 2.verify.r3h. Files read under /logs/reviews/: only /logs/reviews/3/r2/{phase_base_sha,implementation_sha,verification_sha,verifier_id}; no sibling directory read. Cold build: supplied scratch local clone /scratch/sol at implementation_sha. Commands run: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`, `cargo test` (retried with /usr/local/cargo/bin on PATH), `pnpm exec vitest run --maxWorkers=1 packages/core/test/apply-move-block.test.ts packages/editor/test/position-map-inverse.test.ts`, artifact digest recomputation using ralph/lib/util.mjs `digestDir`, and one bounded C14 core-route probe (`node /report/c14-probe.mjs`). No browser drive or new sweep; full-suite execution follows the explicit cold-build request.

## Gate table

| Criterion (from PRD §7) | Result (pass / fail / unverifiable) | Evidence (command + output line, or file:line) |
|---|---|---|
| Phase 3: one-workflow steps 1–6 on Linux and macOS, starting with a fresh Untitled file | pass | /logs/ci/3.verify.r2h/accepted/e2e-shell/e2e-shell-ubuntu-latest/e2e-shell.log:106–111 and e2e-shell-macos-latest/e2e-shell.log:106–111 each mark all six steps passed. Both logs:239 show 15/15 spec files. These are CI results, not local macOS claims. |
| Step 1: fresh folder and Untitled file | pass | e2e/shell/test/one-workflow.spec.ts:255 creates the workspace, then checks Outline mode and exact `# Untitled-1\n`; accepted logs:106. |
| Step 2: outline three questions | pass | one-workflow.spec.ts:267 and accepted logs:107. The first question uses the H1 question field; C11's topic-field distinction remains explicitly deferred in docs/V1.1-BACKLOG.md:182. |
| Step 3: two paragraphs under each heading | pass | one-workflow.spec.ts:288 and accepted logs:108; native editor input and exact Markdown/disk comparisons. |
| Step 4: rewrite a sentence | pass | one-workflow.spec.ts:321 and accepted logs:109; variant creation and Use this, followed by exact store/disk checks. |
| Step 5: reorder sentences | pass | one-workflow.spec.ts:357 and accepted logs:110; drag, exact golden, disk comparison. |
| Step 6: source toggle and back | pass | one-workflow.spec.ts:384 and accepted logs:111; real Cmd/Ctrl+/ route, source bytes, restored rendered view, unchanged snapshot count and disk bytes. |
| Windows recorded; xfail allowed (#047) | pass | Windows e2e-shell.log:239: 15/15 specs, 79 cases. test-logs-windows-latest/test.log:350 records a 30-second timeout in rewrite.test.ts's essay-fixture identity case (7,251 passed, 1 failed); no Windows cargo log was produced. This is not an all-platform green claim. |
| r2 confirmation: C14 fixed with named guards and r1 dispositions preserved | pass | /report/c14-probe.log:1–3: identical bytes and row widths `[2,2]` on all three saves. format.ts:1072 and :1327 cover text and autolink fallback. url-typing.test.ts:306 asserts both routes, ASCII/astral, three saves; :343 covers every cell of six indexed table fixtures. Accepted Ubuntu test.log:95/:103/:105 records url-typing 283, url-bytes 30, positions-corpus 533 passing. docs/progress/journal-main.md:478 records both branch mutations red and restored. Backlog:182–189 retains dispositions and closes C14; C2/C13's fired trigger is expressly left for the principal. |
| Evidence at the reviewed SHA | pass | accepted.json names b56c23caf8393d98bd8ff9d62303344ad2a2db03 and run 37510720877. /report/digests.json: all six phase 3 artifact digests and byte counts match; current test-logs SHA-256 `6c3b036290fb52e774657c4deece7eea4cd154013109f5571289db84e279f123`, e2e-shell `4ab6af7e89c4ab197a1f7bd20be38d8c62462ddcb9fa80d849ccac6c4eaa33ca`. |

## Test counts and coverage

Vitest: local cold run **7,250 passed / 2 failed**, both five-second timeouts (apply-move-block identity and position-map-inverse essay-fixture), /report/test.log:703–728. The unchanged affected files then passed **481/481** with one worker and their original timeout budgets (/report/retest.log). Install and lint passed. Accepted Linux and macOS each passed **7,252/7,252 in 72 files**. Windows: **7,251/7,252**, the recorded timeout above.

cargo test: local **78 passed / 0 failed / 0 ignored**, after correcting PATH; the first invocation could not find cargo (/report/cargo-retry.log). No source or test edits were made, and both /snapshot and /scratch/sol have empty `git status --porcelain` output. Accepted Linux and macOS: **78 passed / 0 failed / 0 ignored** each. e2e: accepted **79 cases across 15/15 spec files on each OS**, including all six workflow steps; not rerun locally in this bounded r2 review.

Coverage delta vs main: statements **99.54% → 99.48% (−0.06 percentage points)**; branches **97.25% → 97.54% (+0.29)**; functions **100% → 100% (0)**; lines **100% → 99.87% (−0.13)**. Baseline is accepted 2.verify.r3h's digest-verified test-logs; its covered source and vitest.config.ts are unchanged through the phase base. Current percentages are from accepted 3.verify.r2h (Ubuntu test.log:243, macOS:248), unchanged from r1. Coverage measures `packages/*/src/**`; it does not measure desktop mode wiring or Rust. The initial local timed-out run did not supply a replacement coverage total.

## Findings (≤ 20, most severe first)

None within task 3.7.r2b's blockers-only scope. Verdict: **PASS**. The C14 reproduction no longer reproduces; no examined disposition premise was falsified. This verdict does not erase the initial local timeout failures or the recorded Windows failure.

## Three riskiest things

1. **Pending source edits during an awaited flush.** docs/DECISIONS.md:1203 already assigns this to Phase 3→4 planning. DocumentPane.tsx settles before entering the asynchronous barrier; document-sync.ts's drain follows committed generations. No new timing probe was run under r2's scope.
2. **Literal-URL fallback and coverage limits.** C2/C13 remain deferred; 3.27 touched literal spans and explicitly fired their trigger (docs/V1.1-BACKLOG.md:189). C14's table guard does not establish that every URL ending or the uninstrumented fallback is covered.
3. **Corpus-test timing and unmeasured UI paths.** Two local default-budget cases timed out but passed at one worker; the accepted Windows rewrite case exceeded even 30 seconds. docs/V1.1-BACKLOG.md:188 records the corpus-budget class. Package-only coverage also leaves the known panel/cursor and undo-key dispositions outside its denominator.

## Class-level lessons (for docs/lessons.md)

- LESSON: preserving the links in a serialization does not prove the surrounding table survived → assert container shape as well as link identity, including input in every header and body cell and three successive saves.
- LESSON: corpus-wide tests can exceed a fixed time budget without an assertion mismatch → preserve the initial failure evidence and distinguish an unchanged, lower-concurrency retry from an all-green cold run.

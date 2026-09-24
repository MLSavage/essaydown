# Phase 1 review — Sol

Reviewer: Codex (GPT-6), reviewer role `sol`. Inputs: docs/PRD.md §7/§8 phase 1/§9; docs/RUNNER-SPEC.md; docs/lessons.md; phase diff `052e206aa8314ee1e4e454668a0496b3b96f4128...3e4a3f6f92479b381e9c6d39c0b897c29afa0bba` (r10, saved as `/report/phase.diff`); targeted r9→r10 diff; DECISIONS #025, #040, #041 and #review-1-r9; docs/V1.1-BACKLOG.md; accepted phase-1 CI manifests/artifacts; /logs/human/1.9/accepted.json and /logs/human/1.9.r1/accepted.json with its referenced a1.md; /logs/tasks/1.67/{1,2}.log, /logs/tasks/1.68/1.log and /logs/tasks/1.verify.r10/1.log. Files read under /logs/reviews/: only `/logs/reviews/1/r10/phase_base_sha`, `implementation_sha`, `verification_sha`, and `verifier_id`. No sibling report read.

Cold build: supplied scratch local clone `/scratch/sol` at implementation_sha. Commands run: `git status --short`, `git rev-parse HEAD`, `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`, `PATH=/usr/local/cargo/bin:$PATH cargo test`, artifact digest recomputation using `digestDir`, source/diff/evidence reads, recursive spec count, final `git status --porcelain`. The initial chained command reached an unavailable `cargo` on PATH; the explicit-PATH run passed. `/report/cargo-final.log` is the final Rust result; the earlier cargo log had overlapping redirections and is not used. Scratch status is empty (`/report/scratch-status.txt`). No source edits, new sweeps, probe generators or browser drives.

Verdict: **PASS within the explicit r10 scope in task 1.10.r10b and DECISIONS #041 D1**: confirm O1/O3 and backlog dispositions, report blockers only. The human trial's shorter length is recorded below, not represented as a completed 1,000-word trial.

## Gate table

| Criterion (from PRD §7) | Result (pass / fail / unverifiable) | Evidence (command + output line, or file:line) |
|---|---|---|
| Vite dev route with dev-only load-fixture / copy-Markdown bar | pass | `apps/desktop/src/dev/DevEditor.tsx:259` implements the load action; `:271` flushes source before copying; the bar follows. Accepted r10 Playwright reports cover the route on all three OSes. |
| Michael writes ~1,000 words in rendered view and toggles to source | unverifiable | `/logs/human/1.9.r1/accepted.json` references `a1.md`; that note explicitly reports about **250 words**, deliberately shortened by Michael, on `287c884`, with the Markdown pane matching the writing. It does not establish the literal ~1,000-word exercise or independently document every toggle action. The accepted record's header SHA is r10; its prose identifies the actual trial tree as r9. |
| Copied Markdown round-trips | pass | Human retry note reports correct rendering in BBEdit/cmark and VS Code. O1's existing regression tests pass locally and in all three accepted CI directories: `packages/editor/test/adjacent-runs.test.ts` **240 tests**, including the 100 ordered mark-pair cells, both deletion routes' named cases, and corpus legs; `packages/core/test/adjacent-attention.test.ts` **4 tests**. No blocking contradiction found within the scoped confirmation. |
| Michael tries Outline prototype and records verdict (#002) | pass | `/logs/human/1.9/accepted.json`, `payload.verdictText`: records the trial, positive decision to build the concept, and three prototype questions. No replacement verdict is inferred from 1.9.r1's empty payload. |
| Phase verification: full suite green on three OSes at implementation SHA | pass | `/logs/ci/1.verify.r10h/accepted.json`: a2, run **35984824027**, SHA **3e4a3f6f92479b381e9c6d39c0b897c29afa0bba**, equal to both review SHA files. Each OS records **4816 passed**, Rust **0 failed**, Playwright **102 passed**. Digests and sizes recomputed and matched. |

O1 confirmation: read `packages/core/src/format.ts:198` and `:259` against installed `mdast-util-to-markdown@2.1.2/lib/handle/{emphasis,strong}.js` and `lib/util/encode-info.js`. The sibling predicate and emitted preceding marker jointly select the alternative delimiter; the stricter underscore encoding branch is retained. Existing tests distinguish adjacent, nested and escaped-literal cases, third-run alternation, and the unmarked following letter. The sweep is **5 × 5 × 4 = 100**, retaining both astral members. Its separator-deletion corpus leg has zero matching fixtures, explicitly disclosed; the generated pair cases supply that route. The promoted join/separator rule occurs once in each of AGENTS.md and CLAUDE.md.

O3 confirmation: `e2e/web/editor-soft-line-breaks.spec.ts:127` bounds the computed-point click to three attempts, recomputes geometry each time, and polls the caret; `:211` retains the caller's final precondition. No measured retry count or timing magnitude is asserted. Task 1.68's transcript records **20/20** for five repeats and **102/102** for the full suite. The accepted r10 reports record the spec passing on three OSes. Recursive directory count is **32 spec files** (31 directly under e2e/web and one nested).

Disposition confirmation: `docs/V1.1-BACKLOG.md:117` corrects L11; `:118` carries O2; `:119` O4; `:120` O5–O6; `:121` O7; `:122` O8; `:123` O9 and its superseded trigger; `:124` records repair-1.9(c) firing. The deferred r9 findings retain their `2.verify` hard stops. No premise was falsified by this scoped read. These deferrals are not claims that the defects have been fixed.

## Test counts and coverage

Vitest: **4816 passed / 0 failed**, **47 files**, local cold run (`/report/test.log`) and each accepted r10 OS log. cargo test: **0 passed / 0 failed** in each of three targets, local (`/report/cargo-final.log`) and CI; this is a vacuous Rust test surface. Lint and frozen install passed; dependency check reports **61 npm + 4 cargo**, all allowlisted. e2e: **102 passed / 0 failed per OS** from accepted CI; no local browser execution under D1.

Coverage delta vs main: accepted Phase 0 final verifier `0.verify.r2h` provides the product baseline: statements **99.45%**, branches **96.98%**, functions **100%**, lines **100%**. Its artifact digest was also verified. R10 local and CI: **99.52% / 97.25% / 100% / 100%**; deltas **+0.07 / +0.27 / 0 / 0 percentage points**. Scope expanded between phases, so these aggregates are not a same-denominator improvement claim. `vitest.config.ts:17` excludes dev routes; browser coverage is not measured by these percentages.

All **22 artifacts** in the available accepted phase-1 CI manifests matched both SHA-256 and byte size (`/report/digests.json`). Current r10: test-logs `669de4e8ea3179f120288b76a3c8d6f576da069a3363310cfd32397d3b639177`, **157237 bytes**; playwright-report `85ba6c68cab20626edea2ca6ec99f168d80e2581102517879f12ce118db0b1c1`, **2329377 bytes**. Both contain all three OS directories.

## Findings (≤ 20, most severe first)

Severity, rated by the consequence for the gate's criterion and never by the size of the fix (DECISIONS #review-1-r1): **blocker** — a gate criterion is not met, or wrong output reaches the user silently (example: Copy Markdown puts stale text on the clipboard and reports "Copied"); **should-fix** — a defect or a missing guard the phase should not close with, while the criterion still holds or the path is not the gate's own instrument (example: a redo chord bound under two names with no test that reads the binding table, so deleting one name stays green); **nit** — wording, citations, style, or an assertion with no behaviour behind it (example: `expect(checked).toBe(Object.keys(index).length)` where both sides are the same list). Mark a should-fix **Required** when the reconciliation should fail without it.

None within the D1 blocker-only confirmation scope.

## Three riskiest things

1. O7–O9 remain live cursor/mark discrepancies. Their acceptance is a deliberate deferral to `2.verify`; future cursor work must preserve their concrete native reproduction routes.
2. O2's block-local bridge remains self-referential, and the separator-deletion corpus leg has no fixture members. Passing the existing tests establishes the enumerated cases, not arbitrary editor transaction closure.
3. The renewed human trial is shorter than the written gate and was performed on r9. It reports no broken round trip, but cannot serve as evidence of a 1,000-word exercise on r10. Reconciliation should preserve those qualifications when copying the record.

## Class-level lessons (for docs/lessons.md)

- LESSON: A delimiter byte can belong to an adjacent sibling, a parent, or escaped text → classify the tree relationship alongside the emitted bytes; keep one guard for each origin.
- LESSON: A corpus traversal can execute for every fixture while its transaction family has zero members → report the actual transaction count and identify the separate cases that exercise that family.
- LESSON: An accepted human record can differ from its task in length and tested SHA → carry the record's actual exercise and provenance into the gate table instead of inferring them from ACCEPT or the wrapper SHA.

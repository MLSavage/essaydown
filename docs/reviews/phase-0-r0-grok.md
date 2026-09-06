# Phase 0 review — Grok

Reviewer: Grok 4.6. Inputs: docs/PRD.md §7/§8 phase 0, docs/RUNNER-SPEC.md, docs/lessons.md, `git diff 660f3aa3ebf605eba2d4c520004c036672dcc9fb...81273f59de38f43d3f4e4347100a66a04cd41b4e` (attempt r0), /logs/ci/0.verify.g1h/accepted/ (gate id; DECISIONS #018; verifier_id `0.verify.g1`), /logs/ci/0.2h/accepted/, /logs/ci/0.verifyh/a1/ (GATE-FAILED, no accepted.json), /logs/tasks/, /logs/human/ absent (no observation/approval gates in phase 0). Cold build: cited /logs/ci/0.verify.g1h/accepted/ (Grok). Commands run: `git rev-parse HEAD`; `git log --oneline 660f3aa…81273f5`; `git diff --stat 660f3aa…81273f5`; `git status`; python `digestDir` over accepted `test-logs`; python fixture/index/golden/FNV inspection. No build, no tests.

## Gate table

| Criterion (from PRD §7) | Result (pass / fail / unverifiable) | Evidence (command + output line, or file:line) |
|---|---|---|
| 45-fixture corpus (fixtures/markdown/index.json) passes invariants A/B/C | pass | 45 sources + 45 `.canonical.md` + 45 index keys (directory listing vs index.json). `packages/core/test/roundtrip.test.ts` is 3 × those files = 135 tests. `/logs/ci/0.verify.g1h/accepted/workflow.log` ubuntu L1652 / macos L3045 / windows L4239 and L4248: `roundtrip.test.ts (135 tests)` and `Tests 431 passed (431)`. |
| Full suite green on 3 OSes at the Phase 0 implementation SHA | pass | `/logs/ci/0.verify.g1h/accepted.json` `sha` = `81273f59de38f43d3f4e4347100a66a04cd41b4e` = `/logs/reviews/0/r0/implementation_sha` = `verification_sha`. `result.json` `conclusion: success`, run 34042388223. workflow.log: ubuntu L1651–1652 16 files / 431 tests; macos L3044–3045 same; windows L4247–4248 same. cargo `0 passed; 0 failed; 0 ignored` ubuntu L2340, macos L3567, windows L4784. lint step `$ eslint .` with empty log (`lint.log` 11 bytes) on the merged artifact; job conclusions success on all three + merge-logs. |
| ralph/ runner: integration mutex | pass | `ralph/lib/util.mjs:79-103` `withLock` O_EXCL on `<root>/.locks/ralph`, stale-pid recovery. `ralph/lib/integrate.mjs:99-106` tags `candidate/<id>` then CAS `update-ref`. Conformance: `ralph/test/conformance.test.mjs:16-91` (read, not re-run). |
| ralph/ runner: CI-gate expansion | pass | `ralph/generate-tasks.mjs:113-124` expands `needsCI` to `<id>h`. 0.12 depends on `0.verify.g1` → generated reviewers depend on `0.verify.g1h`. EXPECTED_COUNT 125. Evidence on disk is `/logs/ci/0.verify.g1h/` (gate id). |
| ralph/ runner: phase-close | pass (unexecuted; code reviewed) | `ralph/lib/close.mjs:29-117`: verdict PASS, source head == reconciliation_sha, allowlist diff, detached suite, one `update-ref --stdin` transaction, intent then finalise. Conformance `ralph/test/conformance.test.mjs:313-358`. |
| ralph/ runner: evidence mount | pass | `docker/compose.yml:39` `${ESSAYDOWN_ROOT}/.evidence:/logs`; review services `:ro` plus `/report` writable (`compose.yml:61-93`). |
| Invariant A (idempotence) | pass | `packages/core/test/roundtrip.test.ts:97-103`; 45/45 on all three OS (workflow.log citations above). |
| Invariant B (semantic preservation, positions stripped) | pass | `packages/core/test/roundtrip.test.ts:105-111`; 45/45 on all three OS. |
| Invariant C (byte fidelity on `.canonical.md` + opaque nodes; CRLF → LF) | pass | `packages/core/test/roundtrip.test.ts:113-134`. `fixtures/markdown/crlf-line-endings.md` is CRLF bytes; sibling canonical is LF-only. windows-latest 135/135 roundtrip after `.gitattributes` (0.13). |
| Five further fixtures hand-verified (not the five 0.4 named) | pass | See findings-adjacent notes below this table (footnote-as-text, image-with-spaces, tabs, front-matter-block-scalar, table-alignment). |
| Golden `expected/essay-fixture.moved.md` hand-verified | pass | Independent line-range move of `sectionsOf` index 2 (H3 “The Patents of the Early Fountain Pen Age”, canonical lines 23–36) to immediately before section 0; derived bytes equal `fixtures/markdown/expected/essay-fixture.moved.md`. Same 177 lines, different order; preamble retained. Matches `packages/core/test/blocks.test.ts:277-287`. |
| Fresh-clone cold build | pass (cited CI) | `/logs/ci/0.verify.g1h/accepted/`: `pnpm install --frozen-lockfile` then lint/test/cargo on ubuntu-latest, macos-latest, windows-latest at `81273f59de38f43d3f4e4347100a66a04cd41b4e`. Artifact `test-logs` digest `9991d3725099f1ec0bfb4bf996d25d8f2a7b929f4d5bf684f0e871762c9936c8` / 18666 bytes matches `digestDir` of `/logs/ci/0.verify.g1h/a1/test-logs`. `/logs/ci/0.2h/accepted.json` digest `9b1a9b61f23631ed7d7685eab7a19e36c7918e27656a5a2b5199d2a0a04c5cc8` / 17242 bytes also matches disk. |

Hand-verified fixtures (source vs canonical vs index.json):

- `footnote-as-text.md`: `[^1]` stays text; canonical re-escapes to `\[^1]` (PRD §6.1). `nodeTypes` paragraph/root/text only. `blockCount` 2.
- `image-with-spaces.md`: `![A nib under magnification](<assets/nib detail/close up.png>)` byte-identical after format. `blockCount` 1.
- `tabs.md`: embedded `\t` in the paragraph is preserved; list nesting tab indent becomes two spaces in canonical. `blockCount` 4 = 2 root children + 2 listItems.
- `front-matter-block-scalar.md`: yaml value including `question: |` is byte-identical. `blockCount` 2.
- `table-alignment.md`: alignment markers padded; 1 table + 3 rows = `blockCount` 4.

`essay-fixture.md`: 4803 `\S+` tokens (4,500–5,500); 12 headings outside fences (index `sectionCount` 12). A `# rough historical…` line sits inside a fenced code block and is not a heading.

## Test counts and coverage

Vitest: 431 passed / 0 failed / 16 files (ubuntu, macos, windows at 0.verify.g1). Breakdown from `/logs/ci/0.verify.g1h/accepted/test-logs/test.log` (one OS only; see finding 1): sidecar 73, undo 31, sentences 91, blocks 39, segment-fallback 21, fixtures-corpus 6, opaque-roundtrip 9, hash 7, roundtrip 135, agent-rules 1, markdown-style 13, plus five package placeholders. cargo test: 0 passed / 0 failed / 0 ignored × desktop_lib, desktop, doc-tests on all three OS. e2e: not in the `pnpm test` include (`vitest.config.ts:6-10`); placeholder specs exist, not run. Coverage delta vs main (`660f3aa`): unverifiable — CI and `ralph/stop-check.sh` do not run `pnpm coverage`; main at the phase base has no suite. `vitest.config.ts:21-29` pins 100% on `packages/core/src/blocks.ts` only when coverage is invoked.

0.2h (SHA `fbde8e2`, pre-core): 6/6 tests on all three OS; `epubcheck` 5.3.0, `html-validate-11.13.0`, `pdfimages` printed on ubuntu/macos/windows (`/logs/ci/0.2h/accepted/workflow.log` L1571–1572, L2957–2958, L4147–4148). 0.verifyh a1 GATE-FAILED (windows 99/419 CRLF); superseded.

## Findings (≤ 20, most severe first)

1. **should-fix** — `.github/workflows/ci.yml:140-149` — `actions/upload-artifact/merge@v4` merges `test-logs-*` without `separate-directories`, so same-named `lint.log`/`test.log`/`cargo-test.log` collide and the accepted `test-logs` tree holds one OS (macOS paths in `test.log`; 18666 bytes ≈ one triple, not three). Fix: set `separate-directories: true` on the merge step, or upload ` ${{ matrix.os }}/lint.log` etc.

2. **should-fix** — `ralph/lib/gate.mjs:11` — `isVerifyGate` is `/^\d+\.verifyh$/`, so `0.verify.g1h` (and any `N.verify.r<k>h` / `N.verify.r<k>.g<n>h`) never emits `ROTATE-PRINCIPAL`. DECISIONS #015 / `ralph/test/conformance.test.mjs:530-547` only cover `N.verifyh`. Fix: `/^\d+\.verify(?:\.r\d+)?(?:\.g\d+)?h$/`.

3. **should-fix** — `ralph/lib/doctor.mjs:37-40` — passed-task check is ancestry only (`integrated_sha` ancestor of the target). A later host commit can delete that task's files while ancestry still holds (DECISIONS #017, `c8b234a` dropped 91 files of 0.4; `59d2d3e` restored them). Fix: for each `passed` commit-producing task, `git diff-tree --name-only -r <integrated_sha>^ <integrated_sha>` and assert those blobs still exist at the target head (or fail `doctor` with a named admin repair).

4. **should-fix** — `docs/RUNNER-SPEC.md:82` — `promote-lessons` is required inside each verifier; `scripts/promote-lessons.ts` is absent and `0.verify` / `0.verify.g1` changed no files. Recurring 0.1/0.2 lessons were not flagged. Fix: add `scripts/promote-lessons.ts` and invoke it from the verifier, or delete the sentence from RUNNER-SPEC §5.5 in the reconciliation commit.

5. **should-fix** — `ralph/stop-check.sh:11-13` and `.github/workflows/ci.yml:118-128` — green bar and CI run `pnpm lint && pnpm test && cargo test` only. Task 0.7's 100% `blocks.ts` threshold in `vitest.config.ts:24-29` is never executed on the candidate or on the three OS. Fix: add `pnpm coverage` to stop-check and to ci.yml (or a coverage job that fails the workflow).

6. **should-fix** — `packages/core/test/sidecar.test.ts:979` — `next.sidecar.orphans[0].entry.variants[0]` does not type-narrow the `orphanSchema` discriminated union (`packages/core/src/sidecar.ts:90-94`). `pnpm --filter @essaydown/core typecheck` is red (journal `[0.11]`); `tsc` is not in the green bar. Fix: `expect(next.sidecar.orphans[0].list).toBe("rewrites")` then read `.entry.variants`, and put `typecheck` in the green bar or stop editing around the error.

7. **should-fix** — `docs/RUNNER-SPEC.md:18` and `:79` plus `ralph/generate-tasks.mjs:118` — CI evidence is described under the producer id (`/logs/ci/<verifier_id>/`, `/logs/ci/${task.id}/a<n>/`). The runner writes `/logs/ci/<gate-id>/` (`ralph/lib/gate.mjs:76`, `ctx.ciDir(t.id)`). `/logs/ci/0.verify.g1/accepted/` does not exist; `/logs/ci/0.verify.g1h/accepted/` does. DECISIONS #018 recorded the gate-id reading and patched the Grok prompt; the spec and the generated gate description still contradict the runner. Fix in the reconciliation commit (docs + `ralph/tasks.json` are on the close allowlist): say gate id everywhere.

8. **should-fix** — `packages/core/package.json:23` — `zod` is a runtime dependency used by `sidecar.ts`, named in PRD §8 task 0.10, absent from the PRD §4 table. Journal `[0.10]` flagged it for reconciliation. Fix: add a §4 row for zod (version pin matching the lockfile).

9. **nit** — `packages/core/src/parse.ts:48-53` — the comment says line endings are normalised to LF on the way in; `parse` only calls `createParser().parse(markdown)` with no `\r\n` rewrite. Micromark drops CR from node values (tests green, including the CRLF fixture). Fix: `markdown.replace(/\r\n?/g, "\n")` before parse, or change the comment to name micromark.

10. **nit** — `fixtures/markdown/` — no source asserts GFM task-list syntax (`- [ ]`) remains text, which PRD §4 and §6.1 claim once footnotes and task lists are not enabled. Footnotes are covered (`footnote-as-text.md`). No autolink-literal fixture either (extension is enabled; `link` coverage is only `link-inline.md`). Fix: add `task-list-as-text.md` and one bare-URL file to the corpus in a later authorised task; do not edit 0.4's files here.

## Three riskiest things

1. Matrix log merge that keeps one OS in `test-logs`. Later consumers (reviewers, 6.2-style artifact readers) can think they have three-OS proof from the named artifact when they have one; only `workflow.log` currently proves the other two.

2. `doctor` ancestry vs silent revert. It already deleted the fixture corpus once during this phase. The next host-checkout commit while the loop is live can do it again without `DOCTOR` firing.

3. Unenforced thresholds: `blocks.ts` 100% coverage and core `typecheck` are documentation unless someone types the extra command. A later task can regress both and stay green.

## Class-level lessons (for docs/lessons.md)

- LESSON: a matrix job that uploads the same log filenames and a merge step without `separate-directories` keeps one OS → prefix paths by OS or enable separate-directories before the first `needsCI` workflow.
- LESSON: identity regexes written as `N.verifyh` do not match the repair grammar `N.verify[.r<k>][.g<n>]h` → write the full verifier-gate grammar in the first test that asserts the signal.
- LESSON: “SHA is an ancestor of HEAD” does not mean the task’s files are still in HEAD → doctor a passed task by its tree, not only by ancestry.
- LESSON: a coverage/typecheck threshold that is not in `pnpm lint && pnpm test && cargo test` is not a threshold → the command that must stay green is the only one that counts.
- LESSON: a byte-identical assertion without a checked-in `eol=lf` / `-text` policy is a Windows-only failure (0.verifyh) → put the policy in bootstrap / BUILD-DEFAULTS before the first CI gate that reads files as bytes.
- LESSON: when RUNNER-SPEC and the runner disagree on an evidence path, recording the reading in DECISIONS does not update the sentences reviewers grep → align the spec in the same planning commit, or the next review cites a directory that does not exist.

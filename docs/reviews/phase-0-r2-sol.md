# Phase 0 review — Sol

Reviewer: Sol (Codex, GPT-6). Inputs: docs/PRD.md §7/§8 phase 0 and §9, docs/RUNNER-SPEC.md, docs/lessons.md, `git diff 660f3aa3ebf605eba2d4c520004c036672dcc9fb...98bee5af6c584840fd9b8fda8c599cf2dc52b926` (attempt r2), /logs/ci/{0.2h,0.verify.g1h,0.verify.r1h,0.verify.r2h}/accepted/, /logs/tasks/ phase 0 transcripts, and docs/DECISIONS.md#review-0-r1. No /logs/human/ directory was supplied; this phase's accepted CI manifests are under /logs/ci/. Cold build: scratch local clone /scratch/sol at implementation_sha 98bee5af6c584840fd9b8fda8c599cf2dc52b926. Commands run: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`, `cargo test`, `bash ralph/test/run.sh`, `node ralph/validate-tasks.mjs`, `bash ralph/check-agent-rules.sh`, digest recomputation, independent Vitest probes, and a disposable-repository lock/doctor probe. Initial bare `cargo test` could not find cargo; the successful invocation prepended /usr/local/cargo/bin to PATH. Versions: Node 22.22.1, pnpm 11.25.0, cargo 1.98.1. Scratch `git status --porcelain` empty at exit; temporary probe test removed.

## Gate table

| Criterion (from PRD §7) | Result (pass / fail / unverifiable) | Evidence (command + output line, or file:line) |
|---|---|---|
| Corpus in fixtures/markdown/index.json passes invariant A, idempotence | pass | Index contains 53 fixtures. `pnpm test`: packages/core/test/roundtrip.test.ts passes its 159 A/B/C cases. The A test checks both repeat formatting and each committed canonical fixed point (packages/core/test/roundtrip.test.ts:97). /report/test.log. |
| Corpus passes invariant B, semantic preservation | pass | Position-stripped source and canonical AST comparison for every fixture, with a non-empty-tree assertion; packages/core/test/roundtrip.test.ts:105. All 53 B cases pass. |
| Corpus passes invariant C, byte fidelity | pass | Canonical output equality, opaque-value presence/absence and equality, and LF assertions for every fixture; packages/core/test/roundtrip.test.ts:113. All 53 C cases pass. LF normalization follows the explicit G9 disposition, not a claim of preserving original CR bytes. |
| Full suite green on three OSes at the implementation SHA | pass | /logs/ci/0.verify.r2h/accepted.json names 98bee5af6c584840fd9b8fda8c599cf2dc52b926, run 34112753627, ref ci/0.verify.r2/a1. Accepted artifact digest recomputes to f204051b13b2550ec387cf0514da25b69eaa37e8b69914a7d6e5c57297491489: MATCH, 91,543 bytes, 10 files. Each test-logs-{ubuntu,macos,windows}-latest directory contains lint, test and cargo-test logs; all report completion, 729 Vitest passes and zero Rust failures. Ubuntu also records 79 runner passes. /report/evidence-check.log. macOS/Windows conclusions come from this accepted evidence, not the Linux scratch run. |
| §8 review check: five further fixtures independently hand-verified | pass | Canonical files and index agree: blockquote-nested = 3 blocks, 0 sections, paragraph lines 1/3/4; list-mixed-ordered-unordered = 6/0, lines 1/2/4/5; multiple-sections = 8/4, lines 3/7/11/15; table-alignment = 4/0, no paragraphs; spanning-mark-first-boundary = 1/0, paragraph line 1. Counts use root children plus listItem/tableRow descendants. Node-type unions also match these five documents. /report/evidence-check.log. |
| §8 review check: moved essay golden independently hand-verified | pass | Direct source/golden diff moves only the third section, “The Patents of the Early Fountain Pen Age,” from original lines 23–36 to immediately after the opening paragraph, before the first heading. Its heading, four paragraphs and three-item ordered list travel together; the rest retains its order and bytes. fixtures/markdown/expected/essay-fixture.moved.md:3; blocks.test.ts exercises moveSection(2,0). |
| §8 review check: runner, evidence boundaries and cold build | pass | Local lint, 729 Vitest tests, cargo build/tests and 79 runner tests complete successfully. Validator reports 150 expanded tasks, acyclic and byte-identical to PRD §8. Independent stale-lock probe refuses acquisition without changing lock bytes or state, doctor reports stale-lock and manual recovery, run refuses, and manual removal permits acquisition. /report/{install,lint,test,cargo-pinned,runner,lock-probe}.log. Review mounts are read-only except the assigned report and scratch work. Previously reconciled single-process/manual-operation limitations remain applicable. |

## Test counts and coverage

Vitest: **729 passed / 0 failed**, 21 files, including 159 corpus A/B/C cases across 53 fixtures. Independent probes: **2 passed / 0 failed** test groups, covering 48 front-matter value/style combinations, eight quoted-key cases, decoded-newline identity, and five spanning-mark shapes with identity and reverse-order assertions. The first probe run used an incorrect barrel import for sentenceMarkdown; it was corrected to the defining module before the recorded successful run. No product file was changed.

cargo test: **0 passed / 0 failed** in each of library, binary and doc-test groups; compilation passed. This remains vacuous behavioral Rust evidence (G13). Runner: **79 passed / 0 failed**, no skipped tests. e2e: no automated e2e cases run; Phase 0 does not claim a completed editing workflow. The scaffold-window observation remains transcript evidence from task 0.21.

Coverage: statements **99.45% (733/737)**, branches **96.98% (451/465)**, functions **100% (150/150)**, lines **100% (643/643)**. blocks.ts is 100% on all four metrics; configured per-file thresholds passed. Coverage delta vs phase-base/main: **not numerically defined**—660f3aa3 has no implementation or test/coverage configuration. Versus r1's recorded 99%/96.3%/100%/99.67%, deltas are **+0.45/+0.68/0/+0.33 percentage points**. Coverage includes packages/*/src, not the desktop UI or runner; runner verification is separately counted above.

All four supplied accepted CI artifact digests matched, including the older 0.2h and 0.verify.g1h artifacts that contain only three files. Those older merged artifacts are not used as current three-OS proof.

r1 dispositions checked against this tree:

- **G1/G2:** quoted-key identity/duplicate refusal and shared raw-character escaping are present in sidecar.ts. Independent writes spanning C0, DEL, C1, U+2028/U+2029, lone surrogates and a supplementary character round-trip through format/parse/read; unrelated front-matter bytes remain. Single/double/escaped quoted title spellings, both alone and beside a plain duplicate, refuse with argument-root identity. /report/sol-probe.test.ts and /report/probes.log.
- **G3:** validated identity reorders and self-replacements return the argument root. Six spanning-mark fixtures exist; independent nested-mark and reverse-order probes preserve each sentence's Markdown under the documented slicing rule. sentences.ts:377 and :438; sentences-spanning-marks.test.ts.
- **G4/G5:** automatic stale-lock breaking is absent. Independent withLock/doctor/run checks pass. util.test.mjs tests live-holder contention, token checks and release, directory-open/fsync failure audit lines, and the success/no-audit case. Its three-actor scenario models the live holder by a file carrying the current PID; it is not a multiprocess stress test or a power-loss experiment.
- **G6:** conformance.test.mjs:580 restores intact artifact bytes and changes only accepted.json.sha, then asserts refusal and no review metadata/reviewer state. This reaches the SHA check rather than failing digest validation. The implementation-SHA comparison is redundant after the preceding verification==implementation check; the test establishes the combined equality contract, not independent execution of two unequal-SHA branches. The reviewer environment anchor resolves to a 160-turn default for all three review services; task default remains 50. Literal `docker compose config` was not rerun because docker is unavailable here.
- **G7/G8:** pending writes are computed before line-break refusal; decoded-newline no-op probe passes. front-matter-boundary.test.ts includes index-driven unchanged-value identity and absent-front-matter cases.
- **G9/G11/G12:** PRD §6.1 explicitly qualifies opaque fidelity by LF normalization, §7 uses index.json, and promotion is the manual RUNNER-SPEC §5.5 procedure.
- **G10/G13:** the removed greet handler's remaining UI invocation is explicitly deferred at docs/V1.1-BACKLOG.md:13; zero Rust tests are explicitly recorded at docs/DECISIONS.md:163. Neither is represented here as fixed.

The final verifier diff contains only one appended rule in each agent-rules file and its journal entry; no dependency manifest or lockfile changed. /logs/tasks/0.23–0.26 and 0.verify.r2 transcripts corroborate the reported regression runs and declared scope/tooling deviations.

## Findings (≤ 20, most severe first)

None. Verdict: **PASS**. No new blocker, should-fix or nit is raised; explicitly deferred r1 items retain their recorded dispositions.

## Three riskiest things

1. The restricted front-matter reader/writer still depends on a manually maintained grammar. These probes establish the repaired boundaries, not general YAML conformance or every Unicode input.
2. The runner's exclusion and recovery guarantees depend on the reconciled single-process/manual-operation procedure. Directory fsync is best effort with an audit record; conformance tests cannot establish crash durability on every host filesystem.
3. Phase 0 coverage is concentrated in the core package. Rust has zero behavioral tests, desktop interaction is not covered by this suite, and Intl.Segmenter has not yet been measured in all target webviews. Later phase gates must supply that evidence.

## Class-level lessons (for docs/lessons.md)

- LESSON: A regression scenario can establish a combined invariant without independently executing every syntactic guard → identify redundant guards explicitly and describe the reachable contract the test proves.
- LESSON: A high aggregate coverage percentage can coexist with zero behavioral coverage in another product layer → report coverage scope, Rust test counts and UI evidence separately at every gate.

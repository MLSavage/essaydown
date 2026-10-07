# Phase 3 review — Claude

Reviewer: Claude Opus 5.5 (claude-opus-5-5), attempt r3. Scope: DECISIONS #041 D1, as written in 3.7.r3a. I was to confirm that C15 is fixed by 3.28 and that the r2 dispositions hold, and to report blockers only.

Inputs:
- docs/PRD.md §7 (the Phase 3 gate row) and §8 Phase 3 (rows 3.28, 3.29, 3.30, 3.verify.r3.g2 and 3.7.r3a, read from ralph/tasks.json).
- docs/RUNNER-SPEC.md, docs/lessons.md (the tail, [3.7.r2d] to [3.30]), docs/reviews/TEMPLATE.md.
- docs/DECISIONS.md #025 and #review-3-r2. Handoff 074.
- docs/V1.1-BACKLOG.md:190–197.
- docs/progress/journal-main.md:481, the [3.28] line.
- `git diff da7d07b0d3bc51857d7e18fecdf4f51c60da9421...150847386a6b9c68d0d79c9742993b6908bef865` (attempt r3). I read the r3 delta as `b56c23c..1508473`. Under packages, apps, e2e, fixtures and .github it touches four files: format.ts (`CELL_CUT` and `cutsCell`, plus doc comments), rewrite.test.ts, url-bytes.test.ts and url-typing.test.ts.
- /logs/ci/3.verify.r3.g2h/: accepted.json, and accepted → a1, containing run.json, result.json, both artifacts and workflow.log.
- /logs/state/summary.md. /logs/tasks/ (listed). /logs/human/ holds no Phase 3 record (1.9, 1.9.r1, 2.25 and 2.9 only).

Files read under /logs/reviews/:
- /logs/reviews/3/r3/implementation_sha, phase_base_sha, verification_sha and verifier_id.
- /logs/reviews/3/r2/verdict.
- /logs/reviews/3/r2/claude/transcript.log, opened only to recover my r2 C15 probe sources (`zz-review-r2-probe`, `-probe3` and `-probe4`).

I opened nothing in a sibling directory (DECISIONS #025). Directory listings showed the names under /logs/reviews/3/, /logs/reviews/3/r0–r3/, /logs/reviews/3/r1/claude/ and /logs/reviews/3/r2/claude/. They included `sol` and `grok` entries, and I opened none of them.

Cold build: the accepted logs stand for it (3.7.r3a). As a cross-check I also used a scratch local clone at implementation_sha (/scratch/claude), cleaned with `git clean -fdx` at exit.

Commands run:
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`, `cargo test`.
- `digestDir` (ralph/lib/util.mjs) over both accepted artifacts.
- My r2 C15 probe, re-run once as one throwaway vitest file and then deleted. It has the r2 legs E (plain insert), T (Typing over `editorPlugins()`, core and editor routes) and L (loaded). For L, I folded r2's probe3 (core saves) and probe4 (editor saves) into three saves per route, and added the astral member `x\|𝒜`.
- One read-only core-route print of the backlogged `<…>` twin, to check its backlog premise.
- `pandoc -f gfm -t html` on the input and on the saved bytes, as the external reader.

No new sweep, generator or browser drive.

## Gate table

| Criterion (from PRD §7) | Result (pass / fail / unverifiable) | Evidence (command + output line, or file:line) |
|---|---|---|
| `e2e/shell/test/one-workflow.spec.ts` steps 1–6 pass in WebdriverIO on a fresh Untitled file on Linux | pass | /logs/ci/3.verify.r3.g2h/accepted/e2e-shell/e2e-shell-ubuntu-latest/e2e-shell.log: `[wry 0.55.1 linux #0-5] » test/one-workflow.spec.ts`, `✓ step 1: open a fresh folder and create a fresh Untitled file` … `✓ step 6: toggle to source view and back; the Markdown is unchanged`, `6 passing (7.6s)`; `Spec Files: 15 passed, 15 total (100% completed)` |
| … on macOS (required, DECISIONS #047) | pass | e2e-shell-macos-latest/e2e-shell.log: `[webkit 605.1.15 macos #0-5]` steps 1–6 ✓, `6 passing (5.4s)`; `Spec Files: 15 passed, 15 total` |
| Windows recorded (xfail allowed) | pass (recorded) | e2e-shell-windows-latest/e2e-shell.log: `[msedge 153.0.0.0 windows #0-5]` one-workflow `PASSED`; `Spec Files: 15 passed, 15 total` |
| Spec-file count read from the directory | pass | `ls e2e/shell/test \| grep -c 'spec.ts$'` → 15, which equals `15 total` on every OS. `git log -- e2e/shell/test/one-workflow.spec.ts`: last changed at 3.21, and the e2e tree has no diff since r2 |
| Evidence is for the implementation SHA, and the digests match | pass | accepted.json: `"sha": "150847386a6b9c68d0d79c9742993b6908bef865"`, run `37579169198`, ref `ci/3.verify.r3.g2/a1`; result.json `"conclusion": "success"`. `digestDir` gives test-logs `04f42006…5311` / 262526 B / 10 files and e2e-shell `c9876185…2902` / 54840 B / 3 files, both equal to accepted.json |
| Full suite green on ubuntu and macOS (windows recorded) | pass | test.log on all three OSes: `Test Files 72 passed (72)`, `Tests 7380 passed (7380)`. cargo-test.log is present on every OS this time: `78 passed` on ubuntu and macOS, `75 passed` on Windows. lint.log ends `apps/desktop typecheck: Done`. ubuntu ralph-test.log: `# pass 140`, `# fail 0` |
| No lockfile or manifest change since r2 | pass | `git diff --stat b56c23c 1508473 -- pnpm-lock.yaml Cargo.lock '**/package.json' '**/Cargo.toml' package.json docker` → empty |
| C15 fixed by 3.28: the loaded cell `\| c https://a.b/x\|y \| d \|` saves byte-identical to its canonical form with two cells on three saves, by both routes | pass | r2 probe re-run, leg L. `L core 1..3` and `L edit 1..3` all equal `"\| a                  \| b \|\n\| ------------------ \| - \|\n\| c https://a.b/x\\\|y \| d \|\n"`, cells `[2, 2]`, and the tree after each save equals the input's tree. The only difference from the unpadded input is the column padding, and the cell bytes are as loaded. The astral member `x\|𝒜` gives the same result. At r2 the same leg printed `https\://a.b/x\\\\\\\|y`. pandoc -f gfm reads both input and save 3 as `<a href="https://a.b/x\|y">https://a.b/x\|y</a>`, and the astral twin as `<a href="https://a.b/x\|𝒜">` |
| 3.27's typed member keeps its escape | pass | Legs E and T (ASCII and astral): every save is `\| c https\\://a.b/x\\\|y \| d \|` with `[2, 2]` cells, stable on core and editor saves 2–3, as at r2 |
| C15's named guards exist and are green | pass | url-bytes.test.ts:321–343 (guards 1 and 2: three core saves, `[2, 2]`, node count, links, `unresolved` `[]`), guard 3 at :345 and onward, guards 4–5; url-typing.test.ts guard 6 (two cases). Titles are quoted in journal [3.28] (journal-main.md:481), with the mutation `bytes.includes("\|")` red on 4 tests and then restored. Accepted test.log on all three OSes: `url-bytes.test.ts (35 tests)`, `url-typing.test.ts (285 tests)`, `positions-corpus.test.ts (533 tests)`, all ✓ |
| The fix reads the tokenizer's rule | pass | format.ts:1251 `CELL_CUT = /(?:^\|[^\\])(?:\\\\)*\|/`, :1264–1266 `cutsCell`, with the doc comment citing `bodyRowData` → `bodyRowEscape` and the head twins. It is applied at :1075 (the raw span) and :1340 (the post-`safe` `<…>` value) |
| The r2 dispositions hold | pass | V1.1-BACKLOG.md:190 `[review-3-r2, a \`\\|\` in a table cell's link url]`. Its premise still holds: my twin print `\| c [https://a.b/x\\\\\\\|y](https://a.b/x\\\\\\\|y) \| d \|` is item (a) as written. :191 has C2 + C13 re-pointed (hard stop `4.verify`), :192 the Windows budget line, which :196 `[3.29, …]` closes, and :193 `[3.28, C15 fixed]`. lessons.md:587–588 hold the two r2 lessons. The rewrite budget held on every OS: the `corpus identity totals` sum test ran 12165 ms on ubuntu, 4170 ms on macOS and 13515 ms on Windows, each against `30_000` (3.30) |

## Test counts and coverage

- **Vitest:**
  - My scratch run: 7380 passed, 0 failed, 72 files.
  - Accepted ubuntu, macOS and Windows: 7380/7380 each.
  - The suite grew by +128 since r2 (7252). Those tests are in 3.28's guards and in 3.29's per-paragraph split of rewrite.test.ts, which now has 206 tests.
- **cargo test:**
  - My scratch run: 78 passed, 0 failed.
  - Accepted: 78 on ubuntu, 78 on macOS, 75 on Windows. All Windows legs ran; at r2 the Windows log was absent.
- **e2e:** e2e-shell 15/15 spec files on ubuntu, macOS and Windows, with one-workflow steps 1–6 ✓ on all three. e2e/web is not in this gate's artifacts.
- **Coverage** (scratch, and the same in all three accepted logs): All files 99.48 / 97.54 / 100 / 99.87. That is a delta of 0 / 0 / 0 / 0 against r2 (`b56c23c`), and −0.06 / +0.29 / 0 / −0.13 against the phase base, as my r0 report recorded it.

## Findings (≤ 20, most severe first)

None. Scope is blockers only (DECISIONS #041 D1, 3.7.r3a). My r2 C15 probe does not reproduce, by either route or with either member, and no other wrong bytes, lost text, crash or security issue turned up on the C15 route or in the r3 delta.

## Three riskiest things

1. **The backlogged `<…>` twin still changes the href on save, silently.** I confirmed `[review-3-r2, …]` item (a). The loaded `| c <https://a.b/x\|y> | d |` is written as the resource form `[https://a.b/x\\\|y](https://a.b/x\\\|y)`, so other GFM readers get a different href from the one in the file Typora wrote. The premise is true and the item is recorded with hard stop `4.verify`, so it is not a finding. It is the next live member of this family once a table reaches the user path.
2. **`CELL_CUT` judges each span's bytes alone, not the bytes as joined with their neighbours.** At the handleText site the regex reads only the literal's raw span. Suppose a literal ends in `\` and the next sibling begins with a `|`, which the cell's `safe` escapes to `\|`. The joined bytes would then hold `\\|`, which is an even run, so the row is cut, and the span test cannot see that. I read this and did not run it. I have not checked whether GFM's literal tokenizer can end a literal on `\`. The case is unchanged by 3.28 (at 3.27 the span held no `|`, so the answer is the same), so it is not C15 and not a finding. It is the per-child rewrite class (CLAUDE.md M1) that the next `cutsCell` change should enumerate.
3. **The rewrite corpus budgets are the same as at r2, with nothing to spare beyond them.** On Windows, rewrite.test.ts took 58.8 s and the uncached `corpus identity totals` test 13.5 s, each `it` against `30_000`. 3.30's backlog trigger (either totals test over `30_000`) is the right tripwire. The filtered `-t` path runs about twice the sum test, and no CI job runs it.

## Class-level lessons (for docs/lessons.md)

- LESSON: a predicate that stands in for a tokenizer's cut decision was tested on bytes one span at a time, while the tokenizer reads the joined row, so an escape run formed across a span boundary is invisible to it → a cut predicate is applied to the bytes as joined, at the boundary the parent's rewrite touches (the M1 rule), and its guard set includes one member whose backslash run straddles two children.
- LESSON: three `.g` repairs in a row came from per-`it` budgets on one corpus file, each failing on a test the previous repair added or left unbudgeted → a task that adds an `it` to a budgeted corpus family greps for the trailing budget on every `it` in that file as part of its acceptance (3.30's awk check), not only on the `it` the task's text names.

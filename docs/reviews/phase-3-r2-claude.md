# Phase 3 review — Claude

Reviewer: Claude Opus 5.5 (claude-opus-5-5), attempt r2. Scope: DECISIONS #041 D1 as written in 3.7.r2a. I was to confirm that C14 is fixed by 3.27 and that the r1 dispositions hold, and to report blockers only.

Inputs:
- docs/PRD.md §7 (the Phase 3 gate row) and §8 Phase 3 (rows 3.27, 3.verify.r2, 3.7.r1d, 3.7.r2a, read from ralph/tasks.json).
- docs/RUNNER-SPEC.md §5.
- docs/lessons.md (the tail, [3.25] to [3.27]).
- docs/DECISIONS.md #025, #041, #044 and #review-3-r1.
- docs/V1.1-BACKLOG.md, lines 182 and 189.
- docs/progress/journal-main.md, the [3.27] and [3.verify.r2] lines.
- `git diff da7d07b0d3bc51857d7e18fecdf4f51c60da9421...b56c23caf8393d98bd8ff9d62303344ad2a2db03` (attempt r2). I read the r2 delta as `4dfce92..b56c23c`, which is 3.27 = `85b4341` plus docs.
- /logs/ci/3.verify.r2h/accepted/ (→ a1): accepted.json, run.json, result.json, both artifacts. Also /logs/ci/3.verify.r1.g1h/accepted/test-logs/ for a timing comparison.
- /logs/tasks/ (listed). /logs/human/ holds no Phase 3 record.

Files read under /logs/reviews/:
- /logs/reviews/3/r2/implementation_sha, phase_base_sha, verification_sha, verifier_id.
- /logs/reviews/3/r1/claude/report.md and status.json.
- /logs/reviews/3/r1/claude/transcript.log, opened only to recover my r1 C14 probe sources and their printed output.

I opened nothing in a sibling directory. Directory listings showed the names under /logs/reviews/3/r0/*, /logs/reviews/3/r1/sol/ and /logs/reviews/3/r2/sol/ (`transcript.log` only), and I opened none of those files (DECISIONS #025).

Cold build: the accepted logs stand for it (3.7.r2a). As a cross-check I also used a scratch local clone at implementation_sha (/scratch/claude), cleaned with `git clean -fdx` at exit.

Commands run:
- `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm lint`, `cargo test`.
- `digestDir` (ralph/lib/util.mjs) over both accepted artifacts.
- My r1 C14 probe re-run once as throwaway vitest files, then deleted. It has three legs: plain `insertText`, `Typing` over `editorPlugins()` with the core and editor routes, and the r1 probe's loaded-file leg `L`. I added the astral member beside the ASCII one.
- Two follow-ups on leg `L`'s output only: its parse tree over four saves, and the editor route.
- `pandoc -f gfm -t html` on the two byte strings leg `L` printed, as the external reader.

No new sweep, generator or browser drive.

## Gate table

| Criterion (from PRD §7) | Result (pass / fail / unverifiable) | Evidence (command + output line, or file:line) |
|---|---|---|
| `e2e/shell/test/one-workflow.spec.ts` steps 1–6 pass in WebdriverIO on Linux | pass | /logs/ci/3.verify.r2h/accepted/e2e-shell/e2e-shell-ubuntu-latest/e2e-shell.log: `[wry 0.55.1 linux #0-5] » test/one-workflow.spec.ts`, `PASSED in undefined - file:///test/one-workflow.spec.ts`; `Spec Files: 15 passed, 15 total (100% completed)` |
| … on macOS (required, DECISIONS #047) | pass | e2e-shell-macos-latest/e2e-shell.log: `[webkit 605.1.15 macos #0-5] » test/one-workflow.spec.ts`, `PASSED`; `Spec Files: 15 passed, 15 total` |
| Windows recorded (xfail allowed) | pass (recorded) | e2e-shell-windows-latest/e2e-shell.log: `[msedge 153.0.0.0 windows #0-5]` one-workflow `PASSED`; `Spec Files: 15 passed, 15 total` |
| Spec-file count read from the directory | pass | `ls e2e/shell/test/ \| grep -c 'spec.ts$'` → 15, which equals `15 total` on every OS |
| Evidence is for the implementation SHA, and the digests match | pass | accepted.json: `"sha": "b56c23caf8393d98bd8ff9d62303344ad2a2db03"`, run `37510720877`, ref `ci/3.verify.r2/a1`; result.json `"conclusion": "success"`. `digestDir` gives test-logs `6c3b0362…f123` / 232541 B / 9 files and e2e-shell `4ab6af7e…33ca` / 54838 B / 3 files, both equal to accepted.json |
| Full suite green on ubuntu and macOS (windows recorded) | pass (Windows red, recorded) | ubuntu and macOS test.log: `Test Files 72 passed (72)`, `Tests 7252 passed (7252)`; cargo-test.log 78/78 on both; lint.log ends `apps/desktop typecheck: Done`; ubuntu ralph-test.log `# pass 140`, `# fail 0`. Windows test.log: `1 failed \| 7251 passed`, `packages/core/test/rewrite.test.ts > applyUseVariant > essay-fixture.md: the no-op variant … (corpus identity)` `Test timed out in 30000ms` (35443 ms). No Windows cargo-test.log is in the artifact. See risk 2 |
| No lockfile or manifest change since r1 | pass | `git diff --stat 4dfce92..b56c23c -- pnpm-lock.yaml Cargo.lock '**/package.json' '**/Cargo.toml' package.json` → empty. The only product file changed since r1 is packages/core/src/format.ts |
| C14 fixed by 3.27: the typed member saves byte-identical with two cells on three saves, by the editor route and the core route | pass | r1 probe re-run. `T s1` = `T core s2` = `T edit s2` = `"\| a                   \| b \|\n\| ------------------- \| - \|\n\| c https\\://a.b/x\\\|y \| d \|\n"` with `[2, 2]` cells, and every save equals the one before. The astral member `x\|𝒜` gives the same result. The plain-insert leg (`E s1..s3`) gives the same bytes. At r1 this probe printed save 2 `<https://a.b/x\|y>` with `[2, 3]` cells |
| C14's named guards exist and are green | pass | url-bytes.test.ts guards 3, 4 (two cases) and 5 (two cases); url-typing.test.ts guards 1, 2 and 6 (titles quoted in journal [3.27]). Guard 7 is positions-corpus.test.ts, unchanged. Accepted test.log on all three OSes: `url-typing.test.ts (283 tests)`, `url-bytes.test.ts (30 tests)`, `positions-corpus.test.ts (533 tests)`, all ✓ |
| No new defect on the C14 route (the r1 probe's own legs) | **fail** | Leg `L` of the r1 probe takes a loaded cell `\| c https://a.b/x\\\|y \| d \|`. It printed a byte-stable cell at r1 and is now rewritten to `https\://a.b/x\\\\\\\|y` (`https\://a.b/x\\\|y` in the file). See finding 1 |
| The r1 dispositions hold | pass | #review-3-r1 records Claude's riskiest-things 2 and 3 for the Phase 3→4 boundary, and Sol's three riskiest are the r0 dispositions. V1.1-BACKLOG.md:182 still holds every r0 item with its trigger. The `[3.27, C14 fixed]` line is at :189. It records that the C2 + C13 trigger fired in 3.27 and was left for the principal. That premise is unchanged ("the same mdast"), so it is not a finding |

## Test counts and coverage

- **Vitest:**
  - My scratch run: 7252 passed, 0 failed, 72 files.
  - Accepted ubuntu and macOS: 7252/7252.
  - Accepted Windows: 7251 passed, 1 failed (a budget timeout, recorded runner).
  - The suite grew by +16 tests since r1 (7236), all in 3.27's two test files.
- **cargo test:** 78 passed, 0 failed (scratch, ubuntu, macOS). The Windows log is absent from the artifact.
- **e2e:** e2e-shell 15/15 spec files on ubuntu, macOS and Windows, with one-workflow PASSED on all three. e2e/web is not in this gate's artifacts.
- **Coverage** (scratch, and the same in the ubuntu and macOS accepted logs): All files 99.48 / 97.54 / 100 / 99.87. That is a delta of 0 / 0 / 0 / 0 against r1 (`4dfce92`: 99.48 / 97.54 / 100 / 99.87) and −0.06 / +0.29 / 0 / −0.13 against the phase base as my r0 report recorded it.

## Findings (≤ 20, most severe first)

1. **blocker** — packages/core/src/format.ts:1254–1256 (`cutsCell`), applied at :1074 (`handleText`'s span filter, branch ii) and :1328 (`keepsAutolink`, branch i). 3.27 introduced this regression. `cutsCell` treats any `|` in the bytes as one that would cut the cell, including a `|` that is already escaped. As a result, a table cell that holds a GFM-escaped pipe inside a URL is rewritten on any save, and every GFM reader then loses the link and shows a stray backslash.
   - **Input:** `| a | b |\n| - | - |\n| c https://a.b/x\|y | d |\n`. This is how GFM, and so Typora or GitHub, writes the C14 URL in a cell.
   - **Parse:** micromark parses it as `link{url:"https://a.b/x\\|y", autolinkLiteral}`, keeping the backslash.
   - **At r1:** my r1 probe's leg `L` printed `| c https://a.b/x\|y | d |`, which is byte-stable.
   - **At b56c23c:**
     - The core route (`format(parse(·))`) and the editor route (`format(pmToMdast(mdastToPM(parse(·))))`) both write `| c https\://a.b/x\\\|y | d |`.
     - Essay Down's own parse of the result is the same tree on saves 1–4, so the app's invariant B holds.
     - `pandoc -f gfm` reads the original cell as `<a href="https://a.b/x|y">https://a.b/x|y</a>` and the saved cell as the plain text `https://a.b/x\|y`.
   - **Consequence:** the link is gone and a backslash is visible in the cell. The cell was untouched, the change happens on the next save of any edit, and nothing says that its meaning changed. Michael's own route is editing in Typora and Essay Down in turn (the Phase 2 human gate).
   - **Read, not run:** the `<…>` twin, `<https://a.b/x\|y>` in a cell, takes the resource form `[…\\\|…](…\\\|…)` through the same `cutsCell` at :1328.
   - **Why the guards missed it:** every guard member in url-bytes.test.ts and url-typing.test.ts has a raw `|` in a tree url. None has a `\|` already in the tree.
   - **Fix:** in `cutsCell`, count only a `|` not preceded by an odd run of backslashes, for example `/(?:^|[^\\])(?:\\\\)*\|/.test(bytes)`. A literal whose `|` is already escaped then keeps r1's raw bytes, which were a fixed point. Update the doc comments at :1062–1066 and :1276–1290 to say so.
   - **Guards:** one each for the loaded literal `| c https://a.b/x\|y | d |` and the loaded `<https://a.b/x\|y>`, each saved three times by the editor route and the core route and byte-identical to the input's canonical form. Add the astral member `x\|𝒜`, and the absence case `x\\|y` (an even backslash run, so the `|` still cuts) keeping 3.27's escape. Record the mutation of the regex red, then restored.

## Three riskiest things

1. **micromark keeps the backslash of `\|` inside a cell's autolink literal; the GFM spec does not.** GFM §4.10 strips the pipe escape before inline parsing, and pandoc agrees. The app therefore shows `https://a.b/x\|y` in the editor for a file every other reader shows as `https://a.b/x|y`. This predates 3.27. Finding 1 is where that divergence starts being written to disk. A fix that only narrows `cutsCell` restores r1's byte stability but leaves the visible backslash in the editor. The divergence belongs in the backlog with a trigger, whatever the reconciliation decides about finding 1.
2. **The Windows `test` job is red at the gate SHA on a 30 s per-`it` corpus budget.**
   - `rewrite.test.ts:180` (`30_000`) ran in 19.3 s on Windows at r1 and in 35.4 s at r2. ubuntu was at 28.0 s at r1 and 23.6 s at r2.
   - This is runner variance on a budget that is already near its limit (the #039 class that 3.26 fixed in `sentences-zero-width`), not a 3.27 slowdown.
   - The job is recorded (#047), and its failure also removed the Windows cargo-test.log from the artifact, so cargo on Windows is unobserved at this SHA.
3. **The `tableCell` exception is the first container-specific branch in the literal path, and it decides on bytes, not on the parser's reading.** `cutsCell` is a substring test standing in for "the table tokenizer would cut here". Finding 1 is one place where those two disagree. A `|` inside a code span within the same cell is another place to read: gfm-table's wrapped `inlineCode` handler already escapes it. Any later change to `cutsCell` should carry the escaped and unescaped members together.

## Class-level lessons (for docs/lessons.md)

- LESSON: a guard that decides whether a character "would cut" a container was written as a substring test, and every guard member held that character raw in the tree, so an already-escaped `\|` that the tokenizer never cuts was escaped a second time → a predicate that stands in for a tokenizer's decision is tested on both members of the escape pair (raw and already-escaped, odd and even backslash runs), each loaded from a file as well as typed, and a fix whose guards only hold trees the editor produces also asserts byte stability for the trees the parser produces from another GFM editor's output.
- LESSON: Essay Down's invariant B is defined against its own parser, so a save that preserves micromark's tree can still change what every other GFM reader shows → when a fix changes bytes for a construct where micromark diverges from the GFM spec (an escape inside a table cell), the guard also reads the before and after bytes with an external GFM reader (pandoc is in the container) and asserts the same rendered text.

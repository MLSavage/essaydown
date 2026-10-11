# Phase 4 review — Claude

Reviewer: Claude Opus 5.5 (claude-opus-5-5), attempt r2. Scope as set by 4.5.r2a (DECISIONS #041 D1): confirm that Claude r1 finding 1 is fixed by 4.32, and that the r1 and r0 dispositions hold. Blockers only.

Inputs:
- docs/PRD.md: §7 phase 4 row; §8 phase 4 (4.5, 4.32, 4.verify.r2, 4.5.r2a); §9.
- docs/RUNNER-SPEC.md; docs/lessons.md.
- docs/DECISIONS.md #025 and #review-4-r1.
- docs/V1.1-BACKLOG.md lines 205–221.
- `git diff 8aba511bdd4060a59413c4e9bf03e4782fd2983b...2e4248a3699132163912a3fde987e44994201103`, read closely for `3332d60..2e4248a` (4.5.r1d, 4.32, 4.verify.r2).
- /logs/ci/4.verify.r2h/ (accepted → a1): accepted.json, run.json, result.json and all four artifacts.
- /logs/tasks/ lists 4.32 and 4.verify.r2. The journal lines of both were read in the tree.
- There is no /logs/human/<id> for phase 4.

Files read under /logs/reviews/:
- /logs/reviews/4/r2/{implementation_sha, phase_base_sha, verification_sha, verifier_id}.
- /logs/reviews/4/r1/claude/report.md and status.json.
- Disclosure: my first orientation command ran `ls` on `/logs/reviews/4/r2/sol/` and printed one file name (`transcript.log`). I opened no file in it, and nothing in this report comes from it.

Cold build: the accepted logs stand for it (4.5.r2a). I also ran the suite in a scratch local clone at implementation_sha (/scratch/claude). The probe file was deleted, the clone was cleaned with `git clean -fdx`, `git status --porcelain` is empty, and HEAD is 2e4248a.

Commands run:
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`, `cargo test`.
- `digestDir` (ralph/lib/util.mjs) over the four accepted artifacts.
- My r1 finding-1 reproduction, run once on the product's route for its three spellings. Each document was `---\ntitle<spelling>\nauthor: x\n---\n\n# Heading\n\nSome text.\n`, with spellings `title:`, `title: ""` and `title: ~`, plus `title: My Own Essay` for the "keeps a front-matter title" clause.
  - The title came from the real `exportDocument` (export-sync.ts), with a fake IO whose `readDoc` returns the document.
  - The argv was `pandoc_args` (export.rs:165) for `epub`, with that title token, run under `LANG=en_US.UTF-8`.
  - The output was checked with `epubcheck` and `unzip -p … EPUB/content.opf`.
- `readFrontMatter` + `hasPandocReadableTitle` evaluated on three further front-matter strings. This is a pure-function read with no pandoc run (finding 1).

## Gate table

| Criterion (from PRD §7) | Result (pass / fail / unverifiable) | Evidence (command + output line, or file:line) |
|---|---|---|
| Step 7: the **DOCX** of the fixture essay passes its validators | pass | `export-validation/*/unzip-t.txt`: `No errors detected in compressed data` on macOS, ubuntu and windows. e2e-shell logs: export.spec.ts passes on all three (`Spec Files: 16 passed, 16 total`). |
| Step 7: the **PDF** passes its validators and has headings, table, image, code block | pass | `pdfimages-list.txt` gives 2 rows (`4 0 image 320 240 icc 3`, `5 1 image 320 240 icc 1`) and `pdfinfo.txt` gives `Pages: 10`, on all three. integration.test.ts (31 tests) is green on ubuntu and macOS. |
| Step 7: the **HTML** passes its validators | pass, under #065's `lang` exception | `html-validate.txt` is empty on all three (the ci.yml argv; see the r1 CI-argv-drift disposition). The product's argv is proven by export.spec.ts on all three OSes. |
| Step 7: the **EPUB** passes its validators | pass for the fixture essay and for the three r1 spellings; **fail for `title:` / `""` / `~` in a front-matter block the app's grammar calls malformed** (finding 1) | `epubcheck.txt`: `Messages: 0 fatals / 0 errors / 0 warnings / 0 infos` on all three. The r1 reproduction is in the scope (1) row below. |
| Scope (1): Claude r1 finding 1 fixed by 4.32 for `title:`, `title: ""`, `title: ~`; a front-matter title pandoc reads is kept | **confirmed for the r1 documents; not for every document whose front matter carries those spellings** (finding 1) | Reproduction output, three spellings: `title sent="r1-probe" pandoc rc=0 stderr="" dc:title="r1-probe" epubcheck: Messages: 0 fatals / 0 errors / 0 warnings / 0 infos`. Own title: `title sent=undefined … dc:title="My Own Essay" … 0 errors`. CI ubuntu: `✓ title: gets the stem as its title token and passes epubcheck with dc:title the stem` and the nine sibling legs, plus the three true-row legs, are green. For `---\ntitle:\ntags:\n- essay\n---`, `readFrontMatter` returns `{"reason":"malformed","value":null}` and `hasPandocReadableTitle` returns `true`, so `titleSent=undefined`. |
| Scope (2): r1 dispositions present with triggers; premises hold | confirmed | V1.1-BACKLOG.md:220 `[review-4-r1, block-scalar title]`, trigger "first block-scalar reader … any user report, or before export is declared done / the first public release". Its premise "the app never writes `title`" holds: the only `writeFrontMatter` callers are outline.ts:150 and dev/outline-document.ts:41, both `{ question }`. :221 `[review-4-r1, CI export-validation argv drift]`, trigger "next task that touches `buildPandocArgs` …". Its premise holds: ci.yml:199 and `commands.txt` have no `--embed-resources` on the HTML line. |
| Scope (2): r0 dispositions present with triggers | confirmed | V1.1-BACKLOG.md:212–219 are unchanged since r1: the `3332d60..2e4248a` diff of the file is two appended lines only. |
| ciAcceptance: full suite plus every spec under e2e/shell/test/ green on ubuntu and macOS (windows recorded) | pass | `ls e2e/shell/test/*.spec.ts \| wc -l` gives 16. `Spec Files: 16 passed, 16 total` on macOS, ubuntu and windows. `Tests 8883 passed (8883)` on ubuntu and macOS. Windows has `4 failed \| 8879 passed`: three `Test timed out in 5000ms` (blocks.test.ts, url-typing.test.ts ×2) and one `20000ms` (integration EPUB of essay-fixture), recorded under #047. result.json `"conclusion": "success"`, run 38052929350, sha `2e4248a3…`. |
| ciAcceptance: 4.32's title legs of integration.test.ts green on ubuntu and macOS | pass | `✓ packages/export/test/integration.test.ts (31 tests)` on both. 13 title legs listed by name in the ubuntu test.log. |
| ciAcceptance: tauri-build lists `typst` beside `pandoc` | pass | macOS `pandoc-version.log`: `desktop`, `pandoc` (190159728), `typst` (45029488). Windows: `./target/release/pandoc.exe` and `./target/release/typst.exe`. |
| Runner conformance | pass | ubuntu `ralph-test.log`: `# tests 141`, `# pass 141`, `# fail 0`. |
| Evidence is for the implementation SHA, and the digests match | pass | `digestDir`: test-logs `b68918cd…`/393967/9, e2e-shell `de18fe91…`/58900/3, export-validation `4a79a5ec…`/653332/39, tauri-build `91ed25b3…`/48097/6. All equal accepted.json and run.json; `diff -r a1 accepted` is empty (a symlink). |

## Test counts and coverage

Vitest:
- Scratch (aarch64 container): `Test Files 83 passed (83)`, `Tests 8883 passed (8883)`, rc 0.
- CI: 8883/8883 on ubuntu and macOS; windows 8879/8883 (timeouts, windows recorded).

cargo test: 129 passed / 0 failed (scratch; ubuntu and macOS CI identical).

pnpm lint: rc 0 (scratch).

e2e: 16/16 spec files on ubuntu, macOS and windows (accepted e2e-shell logs); not run in scratch.

Coverage (All files, scratch = CI ubuntu): 75.87 / 76.88 / 67.42 / 76.39. Against r1's 75.8 / 76.78 / 67.39 / 76.34 that is +0.07 / +0.10 / +0.03 / +0.05. It is still not comparable with main, because 4.10 widened the denominator (#review-4-r0).

## Findings (≤ 20, most severe first)

Severity, rated by the consequence for the gate's criterion and never by the size of the fix (DECISIONS #review-1-r1): **blocker** — a gate criterion is not met, or wrong output reaches the user silently (example: Copy Markdown puts stale text on the clipboard and reports "Copied"); **should-fix** — a defect or a missing guard the phase should not close with, while the criterion still holds or the path is not the gate's own instrument (example: a redo chord bound under two names with no test that reads the binding table, so deleting one name stays green); **nit** — wording, citations, style, or an assertion with no behaviour behind it (example: `expect(checked).toBe(Object.keys(index).length)` where both sides are the same list). Mark a should-fix **Required** when the reconciliation should fail without it.

1. **blocker** — `packages/core/src/sidecar.ts:1384` (with :1315) — `hasPandocReadableTitle` returns `true` for every entry whose `value` is `null`. That includes the whole-block `malformed` entry (:1315), which `readFrontMatter` returns for `title:`, `title: ""` or `title: ~` whenever any *other* line of the block is outside the app's line grammar. So export-sync sends no stem, and the EPUB gets the empty title r1 finding 1 reported, and is reported as exported. This is U1's class again, and r2 scope (1)'s own three spellings.
   - The commonest trigger is a YAML compact block sequence under a sibling key: `tags:` followed by `- essay` at column 0. That is valid YAML, and it is what PyYAML's default dump and many static-site templates write. Its `- essay` line fails `KEY_LINE` (:966) and is not `INDENTED` (:968), so `scanFrontMatter` sets `malformed` (:1019).
   - Observed in scratch: `---\ntitle:\ntags:\n- essay\n---` → `entry={"key":"title","writable":false,"reason":"malformed","value":null} hasPandocReadableTitle=true titleSent=undefined`; `---\ntitle: ~\ntags:\n- essay\n---` → `true`.
   - A second, rarer route is the quoted key `"title":`. It gives `{"reason":"malformed","value":""}` → `true`, because an unsupported empty string falls through every `false` rule (:1385–1389).
   - From there, pandoc reads `title:` / `~` as null whatever the sibling keys are. That gives an empty `dc:title`, epubcheck RSC-005, and rc 0. This was established by my r1 reproduction, by the principal's #review-4-r1 probe and by 4.32's own `title:` leg. The pandoc run on the malformed-block document itself was **not** run, because 4.5.r2a allows no new probe; this is read, not run.
   - 4.32's doc comment and task text enumerate `value === null` as "a block scalar, a multi-line continuation, an unreadable quote" only. The fourth source, a malformed block, was never in the predicate's table.
   - Fix:
     - In `readFrontMatter`'s `entryFor`, a malformed block still reports the `title` line's own trimmed raw value. Report `value: null` only when that line is `continued` or is followed by a column-0 `- ` item, which is a title that is itself a list.
     - In `hasPandocReadableTitle`, an unsupported entry whose trimmed value is `""` returns `false`.
     - Guards in tests/export-sync.test.ts, one per case:
       - `title:`, `title: ""` and `title: ~`, each beside `tags:\n- essay` → the stem;
       - `title:\n- a` → `undefined`;
       - `"title":` → the stem.
     - Add one integration.test.ts epubcheck leg for `title:` beside a compact `tags` sequence, built with the title export-sync computes, asserting 0 errors and `dc:title` equal to the stem.

## Three riskiest things

1. The title fallback is still decided by the app's own line grammar, not by pandoc's YAML reader (finding 1). Any front matter the grammar refuses wholesale turns every title spelling "opaque", and opaque reads as "the user's title". The predicate's correctness depends on an enumeration of the ways `value` can be `null`, and that enumeration lives in a doc comment, not in a corpus case. A grammar change in sidecar.ts can silently add a fifth.
2. The EPUB `dc:language` still comes from the process locale on the app's route. Linux CI stays green only because of the `LANG` pins (#065/#068, ci.yml e2e-shell Linux step). This is recorded with a trigger at Linux packaging (V1.1-BACKLOG.md:209, :219), and Phase 6 inherits it first.
3. Windows `integration.test.ts`' EPUB-of-essay-fixture leg timed out at 20000 ms in this run (`4 failed | 8879 passed`). That is recorded under #047, but it is the Phase 6 target OS for the same export, and 4.32's 13 title legs have no green Windows record.

## Class-level lessons (for docs/lessons.md)

- LESSON: a predicate that treats "the parser gave no value" as one case (`value === null` → opaque → the user's own title) inherits every route by which the parser can give no value. The route here was the whole-block `malformed` verdict, which has nothing to do with the key being asked about → enumerate the producers of the sentinel from the producer's code (every `value: null` return in `readFrontMatter`), give each a guard at the consumer, and let a block-level failure carry the key's own line where it can.
- LESSON: a fix scoped to "the spellings of one key" was tested only in front matter holding that key alone → each spelling's guard also runs beside a sibling key in each shape the app's grammar refuses (a compact sequence, a quoted key), because the neighbour decides the parser's branch.

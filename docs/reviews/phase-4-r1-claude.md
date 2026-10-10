# Phase 4 review — Claude

Reviewer: Claude Opus 5.5 (claude-opus-5-5), attempt r1, scope as set by 4.5.r1a (DECISIONS #041 D1: confirm that the r0 blockers are fixed and that the dispositions hold; blockers only).

Inputs:
- docs/PRD.md §7 (phase 4 row), §8 phase 4 (4.3, 4.4, 4.23–4.31, 4.verify.r1, 4.verify.r1.g1, 4.5.r1a), §9; docs/RUNNER-SPEC.md; docs/lessons.md.
- docs/DECISIONS.md #025, #065, #review-4-r0, #067, #068; docs/V1.1-BACKLOG.md lines 209–219.
- `git diff 8aba511bdd4060a59413c4e9bf03e4782fd2983b...3332d60e7a9dac7f1ec3be4415a5e406ffcdd8ac`, read closely for `af5daa8..3332d60` (the r0 fix chain).
- /logs/ci/4.verify.r1.g1h/accepted/ (= a1): accepted.json, run.json, result.json, all four artifacts.
- /logs/ci/4.verify.r1h/ (the GATE-FAILED a1, through #068's account); /logs/tasks/4.23–4.31, 4.verify.r1*.
- There is no /logs/human/<id> for phase 4.

Files read under /logs/reviews/:
- /logs/reviews/4/r1/{implementation_sha, phase_base_sha, verification_sha, verifier_id}.
- /logs/reviews/4/r0/claude/report.md, status.json and transcript.log. From the transcript I took only my r0 probe source for findings 3 and 4.
- Disclosure: my first orientation command ran `ls` on `/logs/reviews/4/r1/sol/` and printed its file names. I opened no file in it, and nothing in this report comes from it.

Cold build: the accepted logs stand for it (4.5.r1a). I also ran the suite in a scratch local clone at implementation_sha (/scratch/claude). Probe files were removed afterwards and the clone was cleaned with `git clean -fdx`; `git status --porcelain` is empty, and HEAD is 3332d60.

Commands run:
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`, `cargo test`.
- `digestDir` (ralph/lib/util.mjs) over the four accepted artifacts.
- The r0 export-validator invocation, re-run on the product's argv: `pandoc_args` as export.rs builds it for each preset, with `--embed-resources` for html and `--metadata title=essay-fixture` (the stem; the fixture has no front matter). The outputs were checked with `epubcheck`, `html-validate --config .htmlvalidate.json`, `pdfimages -list`, `pdfinfo`, `unzip -t`/`-l`.
- My r0 reproductions of findings 3 and 4, rebuilt from the r0 transcript. The source-view fake is now a real `@codemirror/state` `EditorState`, because 4.27 reads CodeMirror's own change log.
- C10's third member, once.
- One targeted check of U1's own claim, "a titled EPUB for a title-less document", on two title-less front-matter spellings (finding 1).

## Gate table

| Criterion (from PRD §7) | Result (pass / fail / unverifiable) | Evidence (command + output line, or file:line) |
|---|---|---|
| Step 7: the **DOCX** of the fixture essay passes its validators | pass | Re-run on the product's argv: `unzip -t` gives `No errors detected`; `unzip -l` lists 2 `word/media/` members. In CI, `unzip-t.txt` is clean on all three OSes, and `export.spec.ts` `✓ DOCX: unzip -t reports no errors and the archive holds 2 word/media/ members` passes on macOS, ubuntu and windows (line 73 of each e2e-shell.log). |
| Step 7: the **PDF** passes its validators and has headings, table, image, code block | pass | Re-run: `Pages: 10`; `pdfimages -list` gives 2 rows (`4 0 image 320 240 icc 3`, `5 1 image 320 240 icc 1`). CI `pdfimages-list.txt` gives the same 2 rows on all three. The app route passes `✓ PDF: pdfimages -list holds 2 rows and pdftotext holds every heading title` on all three (line 75). |
| Step 7: the **HTML** passes its validators | pass, under #065's `lang` exception | Re-run on the product's argv (`--embed-resources`, no `lang`): the only html-validate error is `2:2 error <html> is missing required "lang" attribute`. With `--rule element-required-attributes:off`, rc=0. 2 `<img src="data:…">`. App route: `✓ HTML: passes html-validate (4.25's config) and every <img> is an embedded data: URI` on all three (line 74). |
| Step 7: the **EPUB** passes its validators | pass for the fixture essay; **fail for a title-less document whose front matter has an empty `title:`** (finding 1) | Re-run on the product's argv: `Messages: 0 fatals / 0 errors / 0 warnings / 0 infos`. App route: `✓ EPUB: passes epubcheck with 0 errors` on all three (line 76). For `---\ntitle:\n---` (and for `title: ""` and `title: ~`), export-sync sends no title, so pandoc exits 0 and epubcheck reports `2 errors` (RSC-005 ×2). |
| ciAcceptance: full suite plus every spec under e2e/shell/test/ green on ubuntu and macOS (windows recorded) | pass | `ls e2e/shell/test/*.spec.ts \| wc -l` gives 16. `Spec Files: 16 passed, 16 total` on macOS, ubuntu and windows. test.log `Tests 8830 passed (8830)` on ubuntu and macOS. Windows `1 failed \| 8829 passed`: url-typing.test.ts essay-fixture `Test timed out in 5000ms`, recorded under #047. accepted.json `"sha": "3332d60e…"`, run 38046460346; result.json `"conclusion": "success"`. |
| ciAcceptance: validators green on all three on the product's argv plus `lang` and the Linux `LANG` pin | pass via the app route; the ci.yml shell step's HTML line is not the product's argv | `commands.txt`: the HTML line has no `--embed-resources` (ci.yml:199). The product's argv is validated by export.spec.ts through the app on all three OSes, and by integration.test.ts:184/204/230 (`buildPandocArgs` + `LANG_EXCEPTION`). Not reported as a finding under the r1 scope (should-fix class). |
| ciAcceptance: tauri-build lists `typst` beside `pandoc` | pass | tauri-build artifact digest matches accepted.json (`057369fd…`, 48097 B, 6 files). Its content is unchanged from r0's verified layout (same byte count). |
| Evidence is for the implementation SHA, and the digests match | pass | `digestDir`: test-logs `e7bec0b8…`/383359/9, e2e-shell `ab5718ab…`/58890/3, export-validation `e90b8ddc…`/653332/39, tauri-build `057369fd…`/48097/6. All equal accepted.json and run.json; `diff -r a1 accepted` is empty. |
| r1 scope (1) S3 + C5 + C6 by 4.23 | confirmed | commands.rs:224 `validate_format` runs before any resolution. commands.rs:231 `reject_overwriting_source` runs after both paths resolve. IPC tests at commands.rs:576–740 cover the format grammar, `..`, absolute, symlink, empty, out-of-workspace, `out_path == path` and `== sidecar`, each by variant. capabilities/default.json no longer holds `shell:allow-spawn` (4 permissions, none shell). |
| r1 scope (2) U1 by 4.24 | **not confirmed for every title-less document** (finding 1) | Stem title works for no front matter (re-run: 0 errors) and a front-matter title is kept (export-sync.test.ts:104). The tests' argv equals `buildPandocArgs` plus `LANG_EXCEPTION` (integration.test.ts:31, 295–296). An empty or null `title:` counts as "has a title" at export-sync.ts:63. |
| r1 scope (3) S4 by 4.25 | confirmed | export.rs `pandoc_args` pushes `--embed-resources` for `html` only (cargo guard `pandoc_args_carries_embed_resources_for_html_and_no_other_preset`). Re-run: 2 `data:` image URIs, so the file is independent of its directory. integration.test.ts:204 exports to another directory. |
| r1 scope (4) U2 by 4.26, C4 by 4.27 | confirmed (my r0 reproductions no longer reproduce) | r0 F3, rendered: `Same line here. Same line here.`, rewrite on [0,1], type `Same line here. ` at 1, save and reload → text `"Same line here. Same line here. Same line here.\n"`, **POS [0,2]**. r0 F4, source: type `Same line here.\n\n` above both twins one character per CodeMirror transaction, settle, save and reload → **POS [3,0]**. Both assertions green. |
| r1 scope (5) S5 + C7 by 4.28; C2 = G2 + C8 by 4.29 | confirmed | export.rs `#[serde(rename_all = "camelCase")]` + `export_outcome_serializes_with_camel_case_keys`; export-sync.test.ts wire-spelling case; document-sync.test.ts "guard 5 (export, C7)" exports inside the window and asserts `LOCAL`. export.spec.ts drives all four presets plus the missing-image toast (`✓ a document with a dangling image reference shows the missing-image toast, dialog closed`, line 77, all three). |
| r1 scope (6) r0 dispositions with triggers | confirmed | V1.1-BACKLOG.md:212 lists C9–C16 and G3–G12, each with a trigger; :213–219 cover 4.23–4.27 and 4.31. No premise found false. |
| C10 third member `https://a.b/x_[t](u)` | no tree change | parse∘format: bytes `<https://a.b/x_[t>]\(u)`, tree before and after identical (`link https://a.b/x_[t` + text `](u)`). Not a blocker. |

## Test counts and coverage

Vitest:
- Scratch (aarch64 container): `Tests 1 failed | 8829 passed (8830)`, 83 files. The one failure is sentences-zero-width.test.ts essay-fixture `Test timed out in 5000ms`, run while my pandoc probes were using the same machine. Re-run alone: `Tests 83 passed (83)`.
- CI: 8830/8830 on ubuntu and macOS; windows 8829/8830 (a url-typing 5 s timeout, windows recorded).

cargo test: 129 passed / 0 failed (scratch; ubuntu and macOS CI identical).

pnpm lint: rc 0 (scratch).

e2e: 16/16 spec files on ubuntu, macOS and windows (accepted e2e-shell logs); not run in scratch.

Runner conformance: `# tests 141`, `# pass 141`, `# fail 0` (ubuntu ralph-test.log).

Coverage (CI ubuntu, All files): 75.8 / 76.78 / 67.39 / 76.34, against r0's 74.54 / 75.39 / 65.87 / 75.16, a change of +1.26 / +1.39 / +1.52 / +1.18. Still not comparable with Phase 3 or main, because 4.10 added `apps/desktop/src` to the denominator (#review-4-r0). The scratch run printed no table, because the run failed.

## Findings (≤ 20, most severe first)

Severity, rated by the consequence for the gate's criterion and never by the size of the fix (DECISIONS #review-1-r1): **blocker** — a gate criterion is not met, or wrong output reaches the user silently (example: Copy Markdown puts stale text on the clipboard and reports "Copied"); **should-fix** — a defect or a missing guard the phase should not close with, while the criterion still holds or the path is not the gate's own instrument (example: a redo chord bound under two names with no test that reads the binding table, so deleting one name stays green); **nit** — wording, citations, style, or an assertion with no behaviour behind it (example: `expect(checked).toBe(Object.keys(index).length)` where both sides are the same list). Mark a should-fix **Required** when the reconciliation should fail without it.

1. **blocker** — `apps/desktop/src/workspace/export-sync.ts:63` — U1's fix treats any `title` *key* as the document's own title, so an EPUB of a document whose front matter has an empty or null title is still invalid and is reported as exported. This is U1's class, silent and on the app's own route.
   - `readFrontMatter(…).title` is non-null whenever the key is present. sidecar.ts:1305–1331 returns `{writable: true, value: ""}` for `title:` and `title: ""`, and an `unsupported` entry for `title: ~`. So `hasOwnTitle` is true, no `--metadata title=` is sent, and pandoc's yaml reader supplies an empty or null title.
   - Reproduced in this container (pandoc 3.11, the product's EPUB argv with no title tokens):
     - `---\ntitle:\nauthor: x\n---\n\n# Heading\n\nSome text.\n` → rc 0, no stderr; epubcheck `ERROR(RSC-005): … content.opf(5,44): … element "dc:title" invalid; must be a string with length at least 1 (actual length was 0)` and `ERROR(RSC-005): … nav.xhtml(13,65): … Heading elements must contain text`, `0 fatals / 2 errors`.
     - `title: ""` and `title: ~` give the same 2 errors.
     - `readFrontMatter` on the first two (scratch, vitest) returned `{"key":"title","writable":true,"value":"",…}`, so `hasOwnTitle= true`.
   - An empty `title:` is the shape of common note templates (Obsidian, Jekyll), and this is the synced folder the PRD §3 workflow opens. export.rs then reports success (`Terminated` code 0, no `Could not fetch resource`), so the user gets "exported" and an EPUB a reader or store rejects.
   - export-sync.test.ts:97–108 tests only "no front matter" and `title: My Own Title`.
   - Fix:
     - Send the stem unless the front matter carries a title pandoc will read as a non-empty string. At export-sync.ts:63, treat `title` as present only when the entry is non-null and not (writable with `value.trim() === ""`) and not a YAML null spelling (`~`, `null`, the `CORE_SCHEMA_NULL` resolver).
     - Add one export-sync guard per spelling: `title:`, `title: ""`, `title: '  '`, `title: ~`, `title: null` → `title` is the stem; `title: My Own Title` and a block-scalar title → `undefined`.
     - Add one integration.test.ts epubcheck leg on a `title:` document through `buildPandocArgs` with the title export-sync computes.

## Three riskiest things

1. U1's predicate is "the key exists", not "pandoc will read a title" (finding 1). Every title-less spelling a user's template carries yields an invalid EPUB reported as success. The fixture essay has no front matter, so no gate instrument can see it.
2. The EPUB `dc:language` still comes from the process locale on the app's route. A Linux desktop session with `LANG=C.UTF-8` gets `OPF-092` on every EPUB, silently. CI is green only because of the `LANG` pins (ci.yml e2e-shell Linux step, #065/#068). This is recorded, with a trigger at the Linux packaging task, and its premise holds; it is the first thing Phase 6 inherits.
3. The CI export-validation shell step (ci.yml:197–200) still writes its own argv and no longer matches the product's for HTML (no `--embed-resources`). The product's HTML is validated only by export.spec.ts and integration.test.ts. A future gate reader trusting `export-validation/*/html-validate.txt` is reading a different file from the one the app writes.

## Class-level lessons (for docs/lessons.md)

- LESSON: a fix that sends a fallback "only when the document has no X" was keyed on the presence of X's key, while the downstream tool reads X's value (empty, whitespace or YAML null count as absent to pandoc's writer) → decide the fallback by what the consumer will read, and enumerate the empty, quoted-empty and null spellings as guards beside the absent and present cases.
- LESSON: a gate whose shell step hand-writes the product's argv drifts the moment a fix adds a token in the builder (`--embed-resources`) → the CI validator step derives its argv from the builder (or is deleted in favour of the app-route spec), never a copy.

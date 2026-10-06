# AGENTS.md — Essay Down (rules for every agent; CLAUDE.md is identical below this line)

Essay Down is a Tauri 2 + React Markdown essay editor (PRD: `docs/PRD.md`), built by a Ralph loop (`ralph/ralph.sh`, protocol `docs/RUNNER-SPEC.md`). These rules bind every agent on it and outrank task text: if a task conflicts with them, stop, write the conflict to the journal, and do not decide.

## Non-negotiables (docs/PRINCIPAL.md, PRD §9)

- Subscription logins only. No API key anywhere, in any container, for any reviewer or build agent. The only key in the product is the end user's optional coach key, in the OS keyring.
- The container never pushes. Gates never commit. Passed tasks are never edited. `main` moves only at `N.close`.
- Phases and implementation tasks are strictly sequential; one lock; the only parallelism is a review set's three reviewers.
- Scope is the task text. No unrequested features, no "while I'm here" refactors, no dependencies beyond PRD §4 without a `docs/DECISIONS.md` note and Michael's OK. Zero new dependencies in any `verify` task.
- Reviewers never edit code. Human gates are real: never write a DECISIONS entry attributed to Michael.
- When the runner contradicts itself, cut the feature to a manual procedure and record it in `docs/DECISIONS.md`; never add machinery to fix machinery.

## Read next

- By role. A task agent's procedure is `ralph/PROMPT.md`, its prompt, and that file holds the only copy of the iteration steps. A reviewer's is its entrypoint prompt. The principal's is `docs/PRINCIPAL.md`.
- By path. Before you change or review a file under a path below, read the file named; its rules bind as this file's do, and a lesson promoted for those paths is appended there.
  - `docs/rules/markdown-roundtrip.md`: `packages/core/src/parse.ts`, `format.ts`, `positions.ts`; `packages/editor/`; `packages/modes/`; `fixtures/markdown/`; `e2e/`.

## The container

- Evidence is under `/logs`, read-only except your own transcript or report. The host checkout is never your working copy; the repo is also visible at its host path, which is how git worktrees resolve — do not touch it.
- Toolchain is pinned in `docker/versions.env` (Node 22, pnpm, Rust, tauri-driver, pandoc, typst, epubcheck, html-validate, poppler, JDK). CI (task 0.2) reads the same file. The container is Linux: never claim a macOS or Windows pass from inside it.
- A long command (an e2e suite or spec, anything that can pass two minutes) runs as one foreground Bash call bounded by `timeout 540` with the tool timeout 600000, its output redirected to a file that is then grepped for the summary; never `run_in_background`, a wakeup, a pipe into `tail` beside a backgrounded Xvfb (its orphan holds the pipe open past the bound), or ending the turn to wait — a headless attempt that ends its turn is over, and its work is lost (DECISIONS #049).

## Code rules (PRD §4, §6, §9; BUILD-DEFAULTS §9)

- `packages/core` is pure TypeScript: no DOM, no module-level config; pure functions with injected state. Content ids are FNV-1a 64 as 13-char base-36. Sentence segmentation is `Intl.Segmenter` + abbreviation filter with the rule-based fallback.
- Markdown AST is mdast via remark with the individual GFM extensions in PRD §4; footnotes and task lists stay plain text; `html` and `yaml` are opaque and byte-identical (PRD §6.1 rules for the two app-owned front-matter keys).
- Invariants A (idempotence), B (semantic preservation), C (byte fidelity) are tested on every fixture; golden files are created and committed by the task that first asserts against them.
- Every custom Rust command that takes a path enforces the `WorkspaceRoot` contract (PRD §6.4): workspace-relative paths only, canonicalised, traversal/symlink/junction/case-fold tests; `ErrorKind` assertions, not string matches.
- Tests assert relationships and shape (both summands present, presence and absence cases), never magnitudes copied from one dataset. Counts referenced by acceptance (45 fixtures, 12 headings, 30 cases) are read from their index files where the task says so.
- Tauri e2e uses WebdriverIO + tauri-driver under xvfb here; Playwright only for the pure-web dev routes under `e2e/web/`. Exported artifacts are validated by an external reader (`pdfimages`, `pdftotext`, `epubcheck`, `html-validate`).
- Workflows named in a task's `ci` object trigger on `push` to `ci/**` refs (the gate pushes `ci/<id>/a<n>` at the integrated SHA) and upload exactly the `artifactNames` listed; they read tool versions from `docker/versions.env`.
- Record every compiler-forced behaviour decision in the commit body rather than silencing it. JSON schemas allow `_note` string fields.
- Secrets: `.claude/settings.local.json` is gitignored; scan the whole working tree, not just tracked files; the repo is public (DECISIONS #011), so nothing personal enters the tree — the fixture essay is agent-written.
- Every core operation of the shape f(root, …) → root has a corpus-wide identity test: the no-op argument (identity permutation, a sentence replaced by its own text, an unchanged front-matter value) re-serialises byte-identically for every fixture in fixtures/markdown/index.json.
- Code that partitions a string or a node list into adjacent half-open slices states its ownership rule for zero-width items once, in the doc comment, and tests the first, middle and last positions.
- A fix that adds several guards has one test per guard, enumerated from the diff rather than from the acceptance sentences, and the journal names the test that discharges each guard; a rule promoted into a rules file names, in the promoting task's journal entry, the test that discharges each of its clauses.
- A fix for one member of a stated invariant asserts the invariant over the corpus and enumerates instances only as named guards on top of it.
- Every reader of the document store that is not an editing surface (copy, undo/redo, toggle, unmount, save, export) settles the pending source burst before it reads, and a new reader's test is an action inside the coalescing window; a read that can lag the buffer by a window is a stale-read defect, not a timing quirk.
- A helper that must finish before state is dropped (a save before a switch, a close or a rename) returns a checked outcome — clean, saved, or why not — and never resolves alike on success and failure; every caller that discards state proceeds only on success, and has one test per not-saved outcome (DECISIONS #review-2-r0 U1).
- A fix that adopts external state — a disk value that won a reconciliation — moves the parsed value and its raw baseline together in one owner, and its test asserts the adopted value after the second write and after a reload, never only after the first (DECISIONS #review-2-r1 U5).
- A checked outcome that permits discarding state covers the latest generation, not the one its write started with — a helper that writes while edits can still arrive writes again until the disk holds the newest edit or the result is not a success — and its test injects the edit during the awaited write, never only before it (DECISIONS #review-2-r2 W1).

## Runner facts (DECISIONS #009, #012)

- `ralph/tasks.json` is immutable to you; status lives in `/logs/state/`.
- Stop signals (`STUCK`, `CONFLICT`, `INTEGRATION-FAILED`, `HUMAN_GATE`, `PRINCIPAL`, `REPLAN`, `PLAN-GATE`, `DOCTOR`, `CLOSE-DRIFT`, `NO-JOURNAL`, `NO-COMMIT`, `USAGE-LIMIT`) are the runner's, not yours; you only ever print the DONE promise.

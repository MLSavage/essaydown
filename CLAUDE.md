# CLAUDE.md — Essay Down (rules for every agent; AGENTS.md is identical below this line)

You are one agent in a Ralph loop on Essay Down, a Tauri 2 + React Markdown essay editor (PRD: `docs/PRD.md`). The runner (`ralph/ralph.sh`, protocol `docs/RUNNER-SPEC.md`) hands you exactly one task id; you never pick another. These rules outrank task text: if a task conflicts with them, stop, write the conflict to the journal, and do not decide.

## Non-negotiables (docs/PRINCIPAL.md, PRD §9)

- Subscription logins only. No API key anywhere, in any container, for any reviewer or build agent. The only key in the product is the end user's optional coach key, in the OS keyring.
- The container never pushes. Gates never commit. Passed tasks are never edited. `main` moves only at `N.close`.
- Phases and implementation tasks are strictly sequential; one lock; the only parallelism is a review set's three reviewers.
- Scope is the task text. No unrequested features, no "while I'm here" refactors, no dependencies beyond PRD §4 without a `docs/DECISIONS.md` note and Michael's OK. Zero new dependencies in any `verify` task.
- Reviewers never edit code. Human gates are real: never write a DECISIONS entry attributed to Michael.
- When the runner contradicts itself, cut the feature to a manual procedure and record it in `docs/DECISIONS.md`; never add machinery to fix machinery.

## Where you are

- Worktree `/work/.wt/<id>` on branch `task/<id>`, cut from the phase branch. The host checkout is never your working copy. Evidence is under `/logs` (read-only for you except your own transcript); the repo is also visible at its host path, which is how git worktrees resolve — do not touch it.
- Orientation order: this file → `/logs/state/summary.md` → your entry in `ralph/tasks.json` → `docs/lessons.md` → any `/logs/human/<id>/accepted.json` your task names (read its `payload` fields, never the runner outcome).
- Toolchain is pinned in `docker/versions.env` (Node 22, pnpm, Rust, tauri-driver, pandoc, typst, epubcheck, html-validate, poppler, JDK). CI (task 0.2) reads the same file. The container is Linux: never claim a macOS or Windows pass from inside it.

## Every iteration

1. `git status`; commit a dirty tree first as `wip(<id>): recovery of uncommitted changes`. Never rebase; the runner rebases once, at integration.
2. Implement, then verify every acceptance sentence. From task 0.1 onward `pnpm lint && pnpm test && cargo test` must be green (root `Cargo.toml` is a workspace so `cargo test` runs from the root). Never `.skip()` a test to get green; file the gap in the journal instead.
3. Append one entry to `docs/progress/journal-main.md` (template in `docs/progress.md`; never a commit SHA; never edit `docs/progress.md`, it is generated). Append to `docs/lessons.md` (`[<id>] <ISO> LESSON: <root cause> → <do instead>`) when you learned something; never edit an old line.
4. Commit `wip(<id>): …` — every iteration, including failed ones. After 5 tool calls debugging one problem: clean break (notes to lessons + journal, commit, stop without DONE).
5. Print `<promise>DONE <id></promise>` only when acceptance is fully met and the suite is green. The runner squashes your branch into one `task(<id>): …` commit and re-runs the suite on the candidate before the phase branch moves.

## Code rules (PRD §4, §6, §9; BUILD-DEFAULTS §9)

- `packages/core` is pure TypeScript: no DOM, no module-level config; pure functions with injected state. Content ids are FNV-1a 64 as 13-char base-36. Sentence segmentation is `Intl.Segmenter` + abbreviation filter with the rule-based fallback.
- Markdown AST is mdast via remark with the individual GFM extensions in PRD §4; footnotes and task lists stay plain text; `html` and `yaml` are opaque and byte-identical (PRD §6.1 rules for the two app-owned front-matter keys).
- Invariants A (idempotence), B (semantic preservation), C (byte fidelity) are tested on every fixture; golden files are created and committed by the task that first asserts against them.
- Every custom Rust command that takes a path enforces the `WorkspaceRoot` contract (PRD §6.4): workspace-relative paths only, canonicalised, traversal/symlink/junction/case-fold tests; `ErrorKind` assertions, not string matches.
- Tests assert relationships and shape (both summands present, presence and absence cases), never magnitudes copied from one dataset. Counts referenced by acceptance (45 fixtures, 12 headings, 30 cases) are read from their index files where the task says so.
- Tauri e2e uses WebdriverIO + tauri-driver under xvfb here; Playwright only for pure-web dev routes (Phases 0–1). Exported artifacts are validated by an external reader (`pdfimages`, `pdftotext`, `epubcheck`, `html-validate`).
- Record every compiler-forced behaviour decision in the commit body rather than silencing it. JSON schemas allow `_note` string fields.
- Secrets: `.claude/settings.local.json` is gitignored; scan the whole working tree, not just tracked files; the repo is public (DECISIONS #011), so nothing personal enters the tree — the fixture essay is agent-written.

## Runner facts you rely on (DECISIONS #009, #012)

- `ralph/tasks.json` is immutable to you; status lives in `/logs/state/`. A dependency counts as satisfied when it is `passed` (and `ACCEPT` for human gates); a `superseded` gate counts as satisfied only for the fix tasks the planning commit appended after it.
- Review attempts after `r0` (`<id>.r<k>a/b/c/d`), verifier repairs (`N.verify.g<n>`) and approval retries (`<A>.r<n>`) are written as explicit physical tasks in PRD §8 by the principal's planning commit; the generator expands only `review-set` and `needsCI`.
- An `interactive-principal` task or a plan request is done when a commit on its branch carries `<promise>DONE <id></promise>` in its message.
- Stop signals (`STUCK`, `CONFLICT`, `INTEGRATION-FAILED`, `HUMAN_GATE`, `PRINCIPAL`, `REPLAN`, `PLAN-GATE`, `DOCTOR`, `CLOSE-DRIFT`, `NO-JOURNAL`, `NO-COMMIT`) are the runner's, not yours; you only ever print the DONE promise.

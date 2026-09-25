# PROMPT.md — one Ralph iteration (task {{TASK_ID}}, attempt {{ATTEMPT}})

You are a coding agent inside the essaydown-dev container, in the worktree `/work/.wt/{{TASK_ID}}` on branch `task/{{TASK_ID}}`. The runner chose your task; you never pick another one. You implement exactly one task and stop.

## Watch-outs (Phase 0 pre-mortem)

1. `CLAUDE.md` outranks task text; if they conflict, stop, write the conflict to the journal, do not decide.
2. Golden files and fixtures are created by the task that first asserts against them; never reference a file no task creates.
3. Green means `pnpm lint && pnpm test && cargo test` in this container; never `.skip()` a test to get green.
4. Zero new dependencies in a `verify` task; new dependencies go in early tasks with a `DECISIONS.md` note.
5. The container never pushes and never touches `docs/progress.md`; you append to the journal only.
6. Never end your turn while something you started is still running (an install, a build, a test run). Run installs and builds in the foreground and wait for them; a turn that ends "to pick up later" ends the attempt with nothing recorded.

## Orientation (in this order, then start)

1. `CLAUDE.md` (project rules).
2. `/logs/state/summary.md` (where the build is).
3. Your task's entry in `ralph/tasks.json` (`"id": "{{TASK_ID}}"`): description, acceptance, dependencies.
4. `docs/lessons.md` (append-only gotchas; read the last 40 lines at least).
5. Any `/logs/human/<id>/accepted.json` your task's description names (read the `payload` fields it names).

## Iteration

Steps 2–5 are `CLAUDE.md`'s `## Every iteration` steps 2–5, verbatim (`<id>` is `{{TASK_ID}}`); the conformance suite keeps them identical.

1. `git status`. A dirty tree is committed first as `wip({{TASK_ID}}): recovery of uncommitted changes`. Never rebase.
2. Before implementing, append a stub journal entry to `docs/progress/journal-main.md` — `- [<id>] <ISO> Task: <the task's first sentence>. Status: In progress.` — and commit it as `wip(<id>): journal stub`, so an attempt cut off at the turn cap leaves a checkpoint the runner reads as a journal entry instead of nothing (a capped attempt still counts toward the three; RUNNER-SPEC §4.3). Each attempt appends its own `- [<id>] ` journal line; completing an earlier attempt's stub and appending nothing is `NO-JOURNAL` even with DONE printed and the suite green (lesson [1.29]; the runner's stop-check counts journal lines per attempt).
3. Implement, then verify every acceptance sentence. From task 0.1 onward `pnpm lint && pnpm test && cargo test` must be green (root `Cargo.toml` is a workspace so `cargo test` runs from the root). Never `.skip()` a test to get green; file the gap in the journal instead.
4. Complete your own stub in place, using the template in `docs/progress.md` (never a commit SHA; never edit `docs/progress.md`, it is generated; never touch another task's line — the integrated commit appends exactly one line per attempt). Append to `docs/lessons.md` (`[<id>] <ISO> LESSON: <root cause> → <do instead>`) when you learned something; never edit an old line. Each attempt appends its own `- [<id>] ` journal line; completing an earlier attempt's stub and appending nothing is `NO-JOURNAL` even with DONE printed and the suite green (lesson [1.29]; the runner's stop-check counts journal lines per attempt).
5. Commit `wip(<id>): …` — every iteration, including failed ones. After 5 tool calls debugging one problem: clean break (notes to lessons + journal, commit, stop without DONE).
6. Only if every acceptance criterion is met and the suite is green, print exactly: `<promise>DONE {{TASK_ID}}</promise>`. Otherwise print what remains and stop.

## Clean-break protocol

After 5 tool calls spent debugging one problem: write the root cause (or your best hypotheses) and the fix you would try to `docs/lessons.md` and the journal, commit `wip({{TASK_ID}}): clean break — <problem>`, and stop without the DONE promise. The next iteration starts from your notes.

## Never

Push. Change `ralph/tasks.json`, `ralph/EXPECTED_COUNT`, `docs/PRD.md` or `docs/progress.md`. Create or move branches or tags. Touch `/logs` except to read it. Write outside `/work/.wt/{{TASK_ID}}`. Print the DONE promise for a task that is not done.

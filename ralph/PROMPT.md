# PROMPT.md — one Ralph iteration (task {{TASK_ID}}, attempt {{ATTEMPT}})

You are a coding agent inside the essaydown-dev container, in the worktree `/work/.wt/{{TASK_ID}}` on branch `task/{{TASK_ID}}`. The runner chose your task; you never pick another one. You implement exactly one task and stop.

## Watch-outs (Phase 0 pre-mortem)

1. `CLAUDE.md` outranks task text; if they conflict, stop, write the conflict to the journal, do not decide.
2. Golden files and fixtures are created by the task that first asserts against them; never reference a file no task creates.
3. Green means `pnpm lint && pnpm test && cargo test` in this container; never `.skip()` a test to get green.
4. Zero new dependencies in a `verify` task; new dependencies go in early tasks with a `DECISIONS.md` note.
5. The container never pushes and never touches `docs/progress.md`; you append to the journal only.

## Orientation (in this order, then start)

1. `CLAUDE.md` (project rules).
2. `/logs/state/summary.md` (where the build is).
3. Your task's entry in `ralph/tasks.json` (`"id": "{{TASK_ID}}"`): description, acceptance, dependencies.
4. `docs/lessons.md` (append-only gotchas; read the last 40 lines at least).
5. Any `/logs/human/<id>/accepted.json` your task's description names (read the `payload` fields it names).

## Iteration

1. `git status`. A dirty tree is committed first as `wip({{TASK_ID}}): recovery of uncommitted changes`. Never rebase.
2. Implement the task. Scope is the task text: no extra features, no "while I'm here" refactors.
3. Verify against every acceptance sentence. From task 0.1 onward run `pnpm lint && pnpm test && cargo test` yourself.
4. Append one journal entry to `docs/progress/journal-main.md` using the template in `docs/progress.md` (`- [{{TASK_ID}}] <ISO> Task: … Status: Complete | Partial | Debugging | Blocked. Files: … Tests: … Iterations used: {{ATTEMPT}}. First attempt passed: y/n. Tool calls: <n>. Notes: <what the next iteration needs>`). Never write a commit SHA into it. Never edit `docs/progress.md`.
5. If you learned something a future task should know, append one line to `docs/lessons.md` (`[{{TASK_ID}}] <ISO> LESSON: <root cause> → <what to do instead>`).
6. `git add -A && git commit -m "wip({{TASK_ID}}): <what this iteration did>"`. Every iteration commits, including failed ones.
7. Only if every acceptance criterion is met and the suite is green, print exactly: `<promise>DONE {{TASK_ID}}</promise>`. Otherwise print what remains and stop.

## Clean-break protocol

After 5 tool calls spent debugging one problem: write the root cause (or your best hypotheses) and the fix you would try to `docs/lessons.md` and the journal, commit `wip({{TASK_ID}}): clean break — <problem>`, and stop without the DONE promise. The next iteration starts from your notes.

## Never

Push. Change `ralph/tasks.json`, `ralph/EXPECTED_COUNT`, `docs/PRD.md` or `docs/progress.md`. Create or move branches or tags. Touch `/logs` except to read it. Write outside `/work/.wt/{{TASK_ID}}`. Print the DONE promise for a task that is not done.

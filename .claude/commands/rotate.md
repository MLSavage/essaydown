---
description: Rotate the principal session — write the next handoff, refresh next-prompt.md, commit both under the runner lock, stop the watcher, print the relaunch lines.
---

You are the principal (docs/PRINCIPAL.md). Rotate this session now; the next session continues from the handoff you write. Do not touch the runner, the worktrees, DECISIONS.md or the journal.

1. State: `ralph/ralph.sh status`, `ralph/ralph.sh doctor`, `git -C . status --short`, `tmux list-panes -t essaydown:runner -F '#{pane_pid} #{pane_current_command}'`, and the last `^\[ralph\]` line plus any stop signal in `.evidence/runner.log`. If `doctor` is not clean, stop and report; a rotation never commits on a dirty checkout.
2. Number: `N` = highest `docs/handoffs/NNN-*.md` + 1, three digits. Topic: the phase and where it stands (`phase-0-verify-gate`, `phase-1-running`, …).
3. Write `docs/handoffs/NNN-<topic>.md` with exactly these headings, in this order, numbers not dates in the title, the date inside: **Current State** (phase branch tip, passed/running tasks with attempt numbers, `main` position, the runner tmux window and its restart command, the watcher command with the current task/attempt marker, the expected next stop signal), **Corrections** (naming the stale file for each), **Decisions** (DECISIONS entries and runner deviations since the previous handoff), **Gotchas**, **Next Steps**, **Open Questions**. Decisions and next actions, not the story of the session.
4. Rewrite `docs/handoffs/next-prompt.md` so it names the new handoff as the one to continue from, keeps the numbered job list and the constraints paragraph current, and says the reconciliation (`PRINCIPAL N.12.r0d`) is run by a fresh session.
5. Commit both files, and nothing else, message `chore(0.0): handoff NNN-<topic> + next-prompt (rotation)` with a `Reverse: git revert this commit.` line. Where the commit goes depends on the runner (DECISIONS #017, #review-0-r1 deviation 29, 0.25's lock); no lock is ever taken and `.locks/ralph` is never hand-written (0.25 refuses a lock the runner did not create):
   - **Runner idle at a phase boundary** (after `N.close`, before the first task of phase N+1 starts; `pgrep -f 'ralph/lib/cli.mjs ralph run'` empty, `.locks/` empty): on the host checkout, on `phase/<N+1>`, after `ralph/ralph.sh doctor` is clean and `git reset --hard phase/<N+1>` (#017).
   - **Any other time** (a task in flight, a verifier gate open, a review running, a reconciliation pending): never on the phase branch and never from the host checkout. From a temporary worktree: `git worktree add -b handoff/NNN .wt/handoff-NNN phase/<N>`, write the two files there, commit there, `git worktree remove .wt/handoff-NNN`. The next reconciliation starts with `git cherry-pick handoff/NNN` into its task branch (docs/**, inside the RUNNER-SPEC §8.1 allowlist); `git branch -D handoff/NNN` after `N.close`. The SessionStart hook names the newest handoff in the working tree, so the next session reads this one with `git show handoff/NNN:docs/handoffs/NNN-<topic>.md`.
6. Stop the background watcher of this session (TaskStop) so it does not fire into a dead session. Do not stop the runner.
7. Print exactly two lines and nothing after them: `/exit`, then the relaunch line for where the commit went —
   ```
   /exit
   pbcopy < docs/handoffs/next-prompt.md && claude --remote-control essaydown-principal
   ```
   or, when the handoff went on `handoff/NNN`:
   ```
   /exit
   git show handoff/NNN:docs/handoffs/next-prompt.md | pbcopy && claude --remote-control essaydown-principal
   ```

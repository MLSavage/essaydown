---
description: Rotate the principal session — write the next handoff, refresh next-prompt.md, commit both under the runner lock, stop the watcher, print the relaunch lines.
---

You are the principal (docs/PRINCIPAL.md). Rotate this session now; the next session continues from the handoff you write. Do not touch the runner, the worktrees, DECISIONS.md or the journal.

1. State: `ralph/ralph.sh status`, `ralph/ralph.sh doctor`, `git -C . status --short`, `tmux list-panes -t essaydown:runner -F '#{pane_pid} #{pane_current_command}'`, and the last `^\[ralph\]` line plus any stop signal in `.evidence/runner.log`. If `doctor` is not clean, stop and report; a rotation never commits on a dirty checkout.
2. Number: `N` = highest `docs/handoffs/NNN-*.md` + 1, three digits. Topic: the phase and where it stands (`phase-0-verify-gate`, `phase-1-running`, …).
3. Write `docs/handoffs/NNN-<topic>.md` with exactly these headings, in this order, numbers not dates in the title, the date inside: **Current State** (phase branch tip, passed/running tasks with attempt numbers, `main` position, the runner tmux window and its restart command, the watcher command with the current task/attempt marker, the expected next stop signal), **Corrections** (naming the stale file for each), **Decisions** (DECISIONS entries and runner deviations since the previous handoff), **Gotchas**, **Next Steps**, **Open Questions**. Decisions and next actions, not the story of the session.
4. Rewrite `docs/handoffs/next-prompt.md` so it names the new handoff as the one to continue from, keeps the numbered job list and the constraints paragraph current, and says the reconciliation (`PRINCIPAL N.12.r0d`) is run by a fresh session.
5. Commit both files, and nothing else, on the current phase branch while holding the runner lock, message `chore(0.0): handoff NNN-<topic> + next-prompt (rotation)` with a `Reverse: git revert this commit.` line:
   ```
   until (set -o noclobber; echo "$$ $(date -u +%FT%TZ)" > .locks/ralph) 2>/dev/null; do sleep 1; done; git add docs/handoffs/; git commit -q -F <msgfile>; rm -f .locks/ralph
   ```
   Keep the hold under a few seconds: the runner's `withLock` gives up after 30 s.
6. Stop the background watcher of this session (TaskStop) so it does not fire into a dead session. Do not stop the runner.
7. Print exactly these two lines and nothing after them:
   ```
   /exit
   pbcopy < docs/handoffs/next-prompt.md && claude --remote-control essaydown-principal
   ```

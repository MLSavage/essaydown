# DECISIONS.md — Essay Down

Append-only log of decisions. Planning-time entries are numbered `#000`; build-time entries use the ids named in the PRD (`#002-outline-feel`, `#003-coach-prompts`, `#004-pdf-pipeline`, `#005-v1-acceptance`, `#006-mac-sync-smoke`, `#007-claude-cli-sandbox`, `#008-visual-baselines`, `#009-retro-approval`, `#review-N-r<k>`), written by reconciliation commits from accepted human-gate records (RUNNER-SPEC §2, §5).

## #000-lock-decisions (2026-09-04, planning; recorded by the principal from Michael's stated answers)

- Fixture essay: Michael supplies his own ~5,000-word essay as `docs/fixture-essay.md` (PREFLIGHT item). Task 0.5 uses it; the agent writes a neutral essay only if the PREFLIGHT item is marked "agent writes".
- Undo across the sidecar: Cmd/Ctrl+Z after "Use this" in Rewrite restores both the sentence and the sidebar's chosen variant (PRD §6.5). Michael accepted the default ("I'll figure out if that's not fine when I use it"); revisit only from real use, as a v1.1 backlog item if needed.
- Coach access to the writing room: context-only (PRD §4, task 5.3c). Full agentic access is out of scope for v1 and would require an explicit opt-in feature.
- Coach release: ships in v0.2.0 (Phase 5, after v0.1.0), never in v0.1.0.
- Stated fallbacks (not tasks): Linux on Electron if WebKitGTK parity fails (decided at 6.2r); PDF pipeline per #004; `claude-cli` provider removed if `claude -p` leaves subscription coverage.
- Reviewers: Claude Opus, GPT-5.6 Sol, Grok 4.6, all on subscription; no API keys anywhere.
- Name: working codename Essay Down; identifiers fixed (`com.savagesystems.essaydown`, `.essaydown.json`, config dir `essaydown`); a rename is a find-and-replace.

## #010-push-policy (2026-09-05, task 0.0; recorded by the principal from Michael's stated policy)

- `MLSavage/essaydown` is **public**. A GitHub ruleset blocks force-push and deletion on `main`.
- Push policy: branches (`phase/*`, `task/*`, `plan/*`) and `ci/*` refs are pushed freely from the host; `main` and `v*` tags are pushed only by Michael, by hand, per `docs/PUBLISH.md`. Containers never push (RUNNER-SPEC §2; PRD §9.12).
- Enforced on the principal's own tool use by `.claude/settings.json` (project scope) `permissions.deny`: `git push --force*`, `git push -f*`, `git push --delete*`, `git push*:*` (any explicit refspec), `git tag -d*`, `gh release*`. Consequence: the principal never pushes a refspec or deletes a ref itself; `scripts/gate.sh` (run by Michael on the host) is the only thing that pushes `ci/<id>/a<n>` refs and deletes them at `gc`.
- Reversal: delete the six lines from `.claude/settings.json` and the ruleset on GitHub; nothing else depends on them.

## #011-ci-minutes (2026-09-05, task 0.0; recorded by the principal from Michael's stated decision)

- The repo was made public to get **unmetered GitHub Actions minutes** for the three-OS matrix (15 CI gates, macOS runners are the expensive leg).
- Consequence for content: nothing personal enters the tree. `docs/fixture-essay.md` is **agent-written** (neutral topic, PRD task 0.5's fallback: the history of the fountain pen), never Michael's own essay. This supersedes the first bullet of `#000-lock-decisions` and closes the PREFLIGHT "fixture essay" item as "agent writes the fixture".
- Leak rule restated for a public repo (BUILD-DEFAULTS §8): scans cover the whole working tree and all history; `.evidence/`, `.ext/`, `.claude/settings.local.json` stay gitignored.

## #009-bootstrap-commits (2026-09-05, task 0.0; principal)

- Where 0.0's commits go: `phase/0` is cut from the seed `main` (`660f3aa`). The principal commits 0.0's work there in small atomic commits — `chore(0.0): <part>` for policy/checklist commits, `wip(0.0): <part>` for the parts in this order: Dockerfile + compose.yml + versions.env → entrypoints → generate-tasks.mjs + validate-tasks.mjs → gate.sh → ralph.sh → conformance suite → bootstrap.sh → CLAUDE.md/AGENTS.md → .gitattributes/.gitignore. `ralph/bootstrap.sh` makes the final `task(0.0): bootstrap` commit (tool versions and EXPECTED_COUNT in the message, every 0.0 check quoted in the journal entry) and initialises `.evidence/state/` with 0.0 passed. Reversal at any point before Phase 0 runs: `git branch -D phase/0 && rm -rf .evidence` — `main` is untouched.
- Runner decisions taken while implementing RUNNER-SPEC 1.7 (each is the smallest reading of the spec that runs; none adds a feature):
  - **Lock.** The host is macOS, which has no `flock` binary; the one lock is `.locks/ralph` created with `O_EXCL` (pid + time inside) with stale-pid recovery. Same semantics, no dependency.
  - **Worktrees across the bind mount.** Git worktree metadata stores absolute host paths, so the repo is mounted in the container at `/work` *and* at its host path (`compose.yml`); nothing rewrites paths. Consequence: `ESSAYDOWN_ROOT` must be the absolute checkout path (the root `compose.yml` defaults it to `PWD` from the repo root).
  - **Principal completion signal.** An `interactive-principal` task or a plan request is complete when a commit on its branch carries `<promise>DONE <id></promise>` in its message (the transcript promise has no equivalent for a human-driven branch). The runner then applies the same stop-check and integration transaction.
  - **Superseded dependencies.** A gate that a resolved plan request superseded counts as a satisfied dependency. Every other dependent was rewired by the planning commit; the only tasks still naming it are the fix tasks that commit appended after the producer (the generator rewrites `X` → `Xh`, so a fix task written as depending on `X` depends on the superseded gate). The runner warns (`WARN plan.…`) when a pre-existing pending dependent was not rewired.
  - **Close-record drift.** RUNNER-SPEC §8.0 says every ref must "still equal" its intended OID; `main` advances at the next close and the next phase branch advances on its first integration, so branch refs are checked by ancestry (intended OID still reachable) and tags by equality. Doctor uses the same rule.
  - **Reviewer parallelism.** The three reviewers are detached child processes whose exit codes land in `reviews/<phase>/r<k>/<reviewer>/exit-code`; the runner polls those files (no event loop is needed, so the rest of the runner stays synchronous).
  - **Physical review attempts.** The generator expands only `review-set` (into `r0`) and `needsCI`; `r<k≥1>` attempts, `.g<n>` repairs and `.r<n>` approval retries are written as explicit physical tasks by the planning commit (fields `execution`, `reviewer`, `reviewSet`, `reviewAttempt` on reviewer tasks). Fixtures may pin `phase` on a raw task; the real PRD never needs to.
  - **Human gate CLI.** `scripts/gate.sh <id> --outcome ACCEPT|REJECT [--payload k=v]… (--note text | --file path)`; observation gates accept only ACCEPT. The record is `human/<id>/a<n>.md` with a header (recordTarget, gateKind, outcome, sha, payload) and the note as body.
  - **CI adapter.** `gh` + `git push` on the host behind one adapter object; `RALPH_CI_ADAPTER=fake` (conformance suite) records runs and refs in `.ci-fake/`. Artifact digests are per-artifact directory digests (sorted file paths + SHA-256 of each file), recorded in `run.json`/`accepted.json` and re-verified by every consumer.
  - **Version fields for release closes** are read from `package.json`, `apps/desktop/src-tauri/tauri.conf.json` and `apps/desktop/src-tauri/Cargo.toml` at the proposed commit (all present must agree with `releaseVersion`).
  - **Stop-check pre-0.1.** `ralph/stop-check.sh` exits 1 when a tree has no `package.json`, so task 0.1 cannot integrate until it produces the scaffold; 0.0 is the only task that skips the suite.

## #012-container-credentials (2026-09-05, task 0.0; principal, verified on the Mini)

- PREFLIGHT §0.5 assumed the host's `~/.claude`, `~/.codex` and `~/.grok` could be bind-mounted read-only into the container. Verified false for Claude Code on macOS: its login lives in the macOS Keychain, not in `~/.claude`, and the CLI writes to its config dir on every run. Grok's `~/.grok` also holds its binary and caches next to `auth.json`.
- Cut, not machinery: each CLI logs in **once inside the container** (`docker compose run --rm claude-login | codex-login | grok-login`, subscription accounts, no API keys) and its state persists in a container-owned named volume (`essaydown-claude-home`, `essaydown-codex-home`, `essaydown-grok-home`) mounted as that CLI's home directory. Nothing from the host's `~/.ssh`, `~/.config/gh`, `~/.claude`, `~/.codex` or `~/.grok` is ever mounted; `boundary-check` proves the git/gh side of the boundary and its output is quoted in the 0.0 journal entry. The 0.0 acceptance phrase "credentials mounted read-only" is therefore satisfied in spirit (the host's login state is never exposed) and not literally (the container's own login state is writable, because the CLIs rotate tokens).
- Reversal: `docker volume rm essaydown-claude-home essaydown-codex-home essaydown-grok-home` and log in again.

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

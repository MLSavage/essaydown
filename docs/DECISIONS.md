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

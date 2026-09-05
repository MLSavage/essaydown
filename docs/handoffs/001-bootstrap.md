# Handoff 001 — Bootstrap (planning locked → task 0.0)

Written 2026-09-05 by the outgoing principal (planning session, Claude in Cowork on the MacBook Pro). Role, reading order and rules: `docs/PRINCIPAL.md`. Next handoff: `002-*.md`.

## Current State

Planning is **locked** at PRD v14 / RUNNER-SPEC 1.7 / BUILD-DEFAULTS 1.11.0 after eleven Sol audits. No code, no repo on GitHub, no `.evidence/`. The docs in `~/Developer/essaydown` on the MacBook Pro are the seed; `docs/PREFLIGHT.md` §0 pushes them to GitHub from the MacBook and the Mac Mini (the host from now on) clones them. Graph: 86 raw tasks → 122 expanded, acyclic, checked with a throwaway script; the real `ralph/validate-tasks.mjs` is part of 0.0.

Git after PREFLIGHT §0: `main` = seed commit (docs only). Nothing else exists.

## Corrections

- `docs/PREFLIGHT.md` (pre-§0 version) said the host is the MacBook Pro. Verified 2026-09-05: the **Mac Mini** is the host. Ollama for 5.3b may stay on the MacBook Pro.

## Key Decisions

- Audit #11 resolved by cuts, not machinery: publication is manual (`docs/PUBLISH.md`), no intents (`doctor` + `admin`), gates never commit. Reason: the ten-round audit budget.
- Principal = one `claude --remote-control` session inside tmux on the Mini; Michael talks to it from his phone. The runner gets its own tmux window, started by the principal at the end of 0.0.
- Where 0.0's commits go: `phase/0` is cut from the seed `main`; the principal commits 0.0's work there in small atomic commits (`wip(0.0): <part>`); `bootstrap.sh` makes the final `task(0.0): bootstrap` commit that records tool versions and `EXPECTED_COUNT` and initialises state with 0.0 passed. Record this as `DECISIONS.md#009-bootstrap-commits`. Reversal at any point before Phase 0 runs: `git branch -D phase/0 && rm -rf .evidence` — `main` is untouched.

## Gotchas

- `bootstrap.sh` validates the external clone with `node scripts/validate-defaults.mjs`; that script does not exist yet. Create it in `.ext/build-defaults` (checks: version line parses as semver, the §11 retro log contains that version, every `## N.` heading 0–11 present; exit 1 with the failing check named), commit it there, and have Michael push it before bootstrap.
- `EXPECTED_COUNT` must come out at 122 (86 raw + 21 review-set + 15 CI gates). If the generator disagrees, find the bug in the generator or in a task before touching the number.
- Pasted blocks of commands break when one command is interactive (`claude`, `codex login`, `grok`, `tmux new` swallow the rest of the paste). PREFLIGHT §0 keeps those on separate steps; keep it that way when you give Michael commands.
- Grok's login state (`~/.grok`) is mounted read-only; if `grok -p` refuses to run that way, use the host fallback in RUNNER-SPEC §2 for Grok only and say so in DECISIONS.
- The credential-boundary check in 0.0's acceptance (`git ls-remote` of the private authcheck repo must fail inside the container) is the first thing to verify after the image builds; everything downstream assumes it.
- 0.0 is far bigger than one task (image, runner, generator, validator, gate.sh, conformance suite, bootstrap). Expect it to span sessions: write `002` at half context, not at the end.

## Next Steps (Full Roadmap)

1. Michael: `docs/PREFLIGHT.md` §0 (repos from the MacBook, verify/install on the Mini, clone, logins, tmux, Remote Control), then the checklist.
2. Principal + Michael: `scripts/validate-defaults.mjs` in build-defaults, then task 0.0 on `phase/0`.
3. `ralph/bootstrap.sh` → handoff 002 → `ralph.sh run --phase 0`; watch the first three transcripts in `.evidence/tasks/` (RUNNER-SPEC §11).
4. Phase 0 review set → `0.close`; phases 1–4, 6 (v0.1.0), 5 (v0.2.0) per PRD §7.
5. Manual publication per `docs/PUBLISH.md` after `6.close` and `5.close`.
6. Retrospective (post.1–post.4) updates `build-defaults`; `docs/RETRO-CARRYFORWARD.md`.

## Files Produced

- `docs/PRD.md` v14, `docs/RUNNER-SPEC.md` 1.7, `docs/PUBLISH.md`, `docs/PRINCIPAL.md`, `docs/PREFLIGHT.md`, `docs/DECISIONS.md`, `docs/lessons.md`, `docs/progress.md`, `docs/reviews/TEMPLATE.md`, `BUILD-DEFAULTS.md` 1.11.0 → `MLSavage/essaydown` seed commit.
- `docs/handoffs/001-bootstrap.md`, `docs/handoffs/next-prompt.md` → `MLSavage/essaydown`.

## Open Questions

- `docs/fixture-essay.md`: Michael's ~5,000-word essay, or the PREFLIGHT line "agent writes the fixture".
- Exact Grok login-state path after first login (PREFLIGHT line); needed for the read-only mount in `compose.yml`.

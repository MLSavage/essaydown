# Handoff 002 — Phase 0 (task 0.0 bootstrapped → runner started)

Written 2026-09-05 by the principal (Claude Code, Remote Control session in tmux `essaydown`, window `principal`, on the Mac Mini). Role, reading order and rules: `docs/PRINCIPAL.md`. Previous: `001-bootstrap.md`. Next: `003-*.md`.

## Current State

- Task **0.0 is passed** (`task(0.0): bootstrap` = `d8f493e`). `phase/0` carries the 0.0 work as atomic `chore(0.0)`/`wip(0.0)` commits (DECISIONS #009) and the final `task(0.0): bootstrap` commit made by `ralph/bootstrap.sh`; its journal entry (`docs/progress/journal-main.md`) quotes every acceptance check. `main` is untouched at the seed `660f3aa`.
- `.evidence/state/` is initialised (0.0 passed, Phase 0 base = `660f3aa`, external `build-defaults` state at `8573e0e`). `ralph/ralph.sh run --dry-run` → `next: 0.1 (loop, sonnet) on task/0.1 from phase/0`; `doctor` clean.
- Image `essaydown-dev:0.0` built on OrbStack (arm64). Boundary check passed: no `*_API_KEY`/`GH_TOKEN`, no credential helper, no SSH socket, no `~/.ssh`/`~/.config/gh`, `git ls-remote` of the private authcheck repo → `fatal: Authentication failed`.
- Conformance suite: 59/59 (`ralph/test/run.sh`, ~90 s). Validator: 122 expanded tasks, byte-identical to PRD §8.
- Runner: tmux window `runner` in session `essaydown` waits for the container's Claude login, then runs `ralph/ralph.sh run --phase 0`. **Container logins are Michael's next action** (one interactive command each; DECISIONS #012).
- Repo is **public** (DECISIONS #011); push policy in `.claude/settings.json` (DECISIONS #010). Evidence backup: launchd agent `com.savagesystems.essaydown.evidence-backup` (hourly to iCloud Drive; `docs/RESTORE.md`).
- `.ext/build-defaults` has one unpushed local commit `8573e0e` (`scripts/validate-defaults.mjs`); Michael pushes it (`git -C .ext/build-defaults push`).

## Corrections

- `001-bootstrap.md` and `docs/PREFLIGHT.md` §0.5 assumed the host's `~/.claude`/`~/.codex`/`~/.grok` are bind-mounted read-only. False on macOS: Claude Code's login lives in the Keychain. Each CLI now logs in once **inside the container** and keeps its state in a named volume (DECISIONS #012). The 001 gotcha about Grok's read-only mount is moot; the RUNNER-SPEC §2 host fallback for Grok still exists if `grok -p` misbehaves in the container.
- `001-bootstrap.md` Open Questions are both closed: fixture essay = agent-written (DECISIONS #011); Grok login state = `$HOME/.grok/auth.json` on the host (irrelevant to the container now).

## Key Decisions (all in `docs/DECISIONS.md`)

- **#009-bootstrap-commits**: commit convention, reversal (`git branch -D phase/0 && rm -rf .evidence`), and the runner readings taken in 0.0 — O_EXCL lock (no `flock` on macOS), repo mounted at `/work` and at its host path (git worktree absolute paths), principal completion = `<promise>DONE <id></promise>` in a commit message, superseded gate counts as satisfied for its fix tasks, close-record branch refs checked by ancestry (tags by equality), reviewers as detached children polled by exit-code files, `r≥1`/`.g<n>`/`.r<n>` tasks written physically by planning commits, gate.sh human-record CLI, CI adapter with a fake for tests, release version files, stop-check refuses trees without `package.json` (so 0.1 must scaffold before it can integrate).
- **#010-push-policy**, **#011-ci-minutes**, **#012-container-credentials** as above.
- `run` stops at **every** stop signal, including `HUMAN_GATE` (RUNNER-SPEC §10.1 "blockedOnHuman tasks pause the loop"); it also exits after 15 iterations. Restart it after every gate; `ralph.sh run` returns exit 3 on any signal, 0 on `COMPLETE`.

## Gotchas

- Before the runner can do anything: `docker compose run --rm claude-login` (then `/login` inside, `/exit`), `docker compose run --rm codex-login` (device code), `docker compose run --rm grok-login`. Each is interactive: **one command per message**. The runner window polls `claude auth status` in the container and starts only when it says logged in.
- Expected first STOP signals in order: `HUMAN_GATE 0.2h` (after 0.1 and 0.2 pass) → Michael runs `scripts/gate.sh 0.2h` on the host (it pushes `ci/0.2/a1`, waits for `ci.yml`, fetches `test-logs`). Then restart `ralph/ralph.sh run --phase 0`. 0.verifyh is the second gate; then the review set (`PRINCIPAL 0.12.r0d` after the three reviewers) and `0.close` (automatic within `run`).
- `ci.yml` (task 0.2) must trigger on `push` to `ci/**` (CLAUDE.md says so). If the gate finds no run, `findRun` times out after 5 min with a clear message; the fix is a `.g1` repair through the plan request, never a rerun.
- Watch the first three transcripts: `.evidence/tasks/0.1/1.log` etc. (stream-json). `ralph.sh status` for the one-line state. `NO-JOURNAL <id>` means the agent ended without a journal line (or `claude -p` failed, e.g. not logged in) — check the transcript before retrying.
- Reviewer entrypoints (`claude-review`, `codex-review`, `grok-review`) are untested against real models until 0.12; the runner side (snapshot worktrees, parallel launch, report check) is covered by the conformance suite with fakes. If Grok's `-p` output format differs, `grok-review` falls back to extracting `report.md` from the NDJSON transcript; if that fails, use the RUNNER-SPEC §2 host fallback and record it.
- `ESSAYDOWN_ROOT` must be the absolute checkout path for every `docker compose` command (the root `compose.yml` defaults it from `PWD`; `ralph.sh`/`gate.sh` export it).
- Interactive-principal tasks (`0.12.r0d`, later `4.0r`, `6.2r`, `5.0`): the runner creates `.wt/<id>` on `task/<id>`, emits `PRINCIPAL <id>`; I work there, append a journal line, commit `wip(<id>): …` whose message contains `<promise>DONE <id></promise>`, then `ralph.sh run` integrates. Reconciliation verdict is read from `docs/DECISIONS.md#review-0-r0` (`verdict: PASS|FAIL`); a FAIL requires the r1 tasks in PRD §8 + regenerated `ralph/tasks.json` in the same commit.
- `boundary-check` prints `tauri-driver MISSING (USAGE: …)`: the binary is present at `/usr/local/cargo/bin/tauri-driver` (its usage text is what printed); `cargo install --list` reads the agent's empty `CARGO_HOME`. Cosmetic; fix rides with the next task that touches `docker/` (0.2 or later), never by editing 0.0.
- `.claude/settings.json` denies me `git push …:…`, `--delete`, `-f`, `git tag -d`, `gh release`; `scripts/gate.sh` does its own pushes (not matched by the deny prefix).

## Next Steps (Full Roadmap)

1. Michael: three container logins (one command each), `git -C .ext/build-defaults push`, then confirm the runner window started 0.1 (`tmux attach -t essaydown`, window `runner`).
2. Principal: read `.evidence/tasks/0.1/1.log`, `0.2/1.log`, `0.3/1.log` as they appear (RUNNER-SPEC §11 "watch the first 3 transcripts"); on `STUCK`/`NO-JOURNAL` read the transcript, fix PROMPT.md/CLAUDE.md if the cause is prompt-level (a `wip(0.0)`-style docs commit on phase/0 is fine before 0.1 integrates; after that, lessons.md + the next task), `ralph.sh retry <id>`.
3. `HUMAN_GATE 0.2h` → `scripts/gate.sh 0.2h`; `HUMAN_GATE 0.verifyh` → `scripts/gate.sh 0.verifyh`; restart `run` after each.
4. Review set 0.12 (three reviewers in parallel from the snapshot) → `PRINCIPAL 0.12.r0d` → reconciliation commit (reports copied, DECISIONS #review-0-r0 with verdict, lessons, regenerated progress.md) → `run` integrates and syncs state → `0.close` moves `main`, creates `phase/1` → handoff 003.
5. Phases 1–4, 6 (v0.1.0), 5 (v0.2.0) per PRD §7; manual publication per `docs/PUBLISH.md` after `6.close` and `5.close`.

## Files Produced (all on `phase/0`)

`.claude/settings.json`; `scripts/launchd/*`, `docs/RESTORE.md`; `docs/PREFLIGHT.md` (checklist filled); `docker/{Dockerfile,compose.yml,versions.env,entrypoints/*}`, root `compose.yml`; `ralph/{generate-tasks,validate-tasks}.mjs`, `ralph/tasks.json`, `ralph/EXPECTED_COUNT` (122); `ralph/lib/*.mjs` (util, state, ci, gate, integrate, run, close, doctor, summary, cli, bootstrap-state); `ralph/{ralph.sh,sync-state.sh,stop-check.sh,bootstrap.sh,check-agent-rules.sh,PROMPT.md}`; `ralph/test/*` (harness, fakes, validator + conformance tests, run.sh); `scripts/{gate.sh,fetch-ci-logs.sh}`; `CLAUDE.md` ≡ `AGENTS.md`; `.gitattributes`, `.gitignore`; `docs/progress/journal-main.md`; `docs/DECISIONS.md` #009–#012; `docs/lessons.md` (0.0 section). In `.ext/build-defaults`: `scripts/validate-defaults.mjs` (unpushed).

## Open Questions

- None blocking Phase 0. Ollama for 5.3b is deferred (PREFLIGHT last item). Whether Grok's headless mode behaves in the container is learned at 0.12.r0c.

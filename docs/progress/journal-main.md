# journal-main.md — Essay Down (append-only; RUNNER-SPEC §10)

One entry per iteration, keyed `- [<task-id>] <ISO>`; never edited, never pruned, never carries its own commit SHA. Template in docs/progress.md. `/logs/state/summary.md` (generated) shows the last five; `docs/progress.md` is regenerated only in reconciliation commits.

- [0.0] 2026-09-05T16:32:39Z Task: bootstrap — image, entrypoints, generator/validator, gate.sh, ralph.sh, conformance suite, bootstrap, agent rules. Status: Complete. Files: docker/, ralph/, scripts/, CLAUDE.md, AGENTS.md, .gitattributes, .gitignore. Tests: conformance suite ; validator 122 tasks. Iterations used: 1 (interactive, principal + Michael). First attempt passed: y. Tool calls: n/a. Reviewer overturned: pending (Phase 0 review set). Notes: versions DEBIAN_CODENAME=bookworm NODE_VERSION=22.22.1 PNPM_VERSION=11.25.0 RUST_TOOLCHAIN=1.98.1 TAURI_DRIVER_VERSION=2.0.6 PANDOC_VERSION=3.11 TYPST_VERSION=0.15.1 EPUBCHECK_VERSION=5.3.0 HTML_VALIDATE_VERSION=11.13.0 CLAUDE_CODE_VERSION=2.1.261 CODEX_VERSION=0.153.4 GROK_VERSION=1.0.13 . Checks (quoted from ralph/bootstrap.sh):
    == docker compose build
        #12 DONE 289.5s
        #13 [ 8/13] RUN . /etc/essaydown/versions.env     && mkdir -p /opt/grok-home /opt/grok/bin     && HOME=/opt/grok-home GROK_BIN_DIR=/opt/grok/bin bash -c 'curl -fsSL https://x.ai/cli/install.sh | bash -s "$0"' "$GROK_VERSION"     && chmod -R a+rX /opt/grok-home /opt/grok     && ln -sf /opt/grok/bin/grok /usr/local/bin/grok     && HOME=/opt/grok-home grok --version
        #13 1.497 Installing Grok 1.0.13 (linux-aarch64)...
        #13 1.500   Downloading grok 1.0.13...
        #13 73.51   Binary linked to /opt/grok/bin/grok and /opt/grok/bin/agent.
        #13 73.52 Grok 1.0.13 installed to /opt/grok/bin/grok
        #13 73.52   Symlinked /usr/local/bin/grok -> /opt/grok/bin/grok
        #13 73.52   Symlinked /usr/local/bin/agent -> /opt/grok/bin/agent
        #13 73.53   Updated /opt/grok/bin in PATH in /opt/grok-home/.bashrc.
        #13 73.53 
        #13 73.53 Run 'grok' or 'agent' to get started!
        #13 73.53 grok 1.0.13 (5e9a58528b76)
        #13 DONE 73.6s
        #14 [ 9/13] RUN git config --system user.name "essaydown-agent"     && git config --system user.email "agent@essaydown.invalid"     && git config --system --add safe.directory '*'     && git config --system init.defaultBranch main     && git config --system pull.rebase true
        #14 DONE 0.1s
        #15 [10/13] COPY entrypoints/ /usr/local/bin/
        #15 DONE 0.0s
        #16 [11/13] RUN chmod 0755 /usr/local/bin/claude-task /usr/local/bin/claude-review /usr/local/bin/codex-review                /usr/local/bin/grok-review /usr/local/bin/boundary-check /usr/local/bin/essaydown-common.sh
        #16 DONE 0.1s
        #17 [12/13] WORKDIR /work
        #17 DONE 0.0s
        #18 [13/13] RUN mkdir -p /home/agent/.claude /home/agent/.codex /home/agent/.grok /home/agent/.cargo /home/agent/.local/share/pnpm
        #18 DONE 0.1s
        #19 exporting to image
        #19 exporting layers
        #19 exporting layers 0.7s done
        #19 writing image sha256:495338f3c9740067a20aead35ab1e136d7c91f75c41e9dbbf55c821199ef0dd2 done
        #19 naming to docker.io/library/essaydown-dev:0.0 done
        #19 DONE 0.7s
        #20 resolving provenance for metadata file
        #20 DONE 0.0s
         Image essaydown-dev:0.0 Built 
    PASS docker compose build
    == docker compose run claude-task --version
         Container essaydown-claude-task-run-1c00608f894c Creating 
         Container essaydown-claude-task-run-1c00608f894c Created 
        2.1.261 (Claude Code)
    PASS docker compose run claude-task --version
    == docker compose run codex-review --version
         Container essaydown-codex-review-run-f5b299673100 Creating 
         Container essaydown-codex-review-run-f5b299673100 Created 
        codex-cli 0.153.4
    PASS docker compose run codex-review --version
    == docker compose run grok-review --version
         Container essaydown-grok-review-run-cd4dd0cd480e Creating 
         Container essaydown-grok-review-run-cd4dd0cd480e Created 
        grok 1.0.13 (5e9a58528b76)
    PASS docker compose run grok-review --version
    == credential boundary (boundary-check → BOUNDARY-OK; includes pdfimages -v)
         Container essaydown-boundary-check-run-d6cf660de021 Creating 
         Container essaydown-boundary-check-run-d6cf660de021 Created 
        == versions
        node --version         v22.22.1
        pnpm --version         11.25.0
        cargo --version        cargo 1.98.1 (797e8a9bc 2026-08-05)
        rustc --version        rustc 1.98.1 (48a229cea 2026-09-01)
        pandoc --version       pandoc 3.11
        typst --version        typst 0.15.1 (9dfd3a08)
        epubcheck --version    EPUBCheck v5.3.0
        pdfimages -v           pdfimages version 22.12.0
        pdftotext -v           pdftotext version 22.12.0
        java -version          openjdk version "17.0.20.1" 2026-08-18
        html-validate --version html-validate-11.13.0
        claude --version       2.1.261 (Claude Code)
        codex --version        codex-cli 0.153.4
        grok --version         grok 1.0.13 (5e9a58528b76)
        git --version          git version 2.39.5
        tauri-driver           MISSING (USAGE: tauri-driver [FLAGS] [OPTIONS])
        == poppler-utils (apt) 22.12.0-2+deb12u3
        == environment
        PASS no *_API_KEY / GH_TOKEN / GITHUB_TOKEN in env
        PASS no SSH_AUTH_SOCK
        == git credential helpers
        PASS git config --show-origin --get-all credential.helper is empty
        == mounts
        PASS /home/agent/.ssh absent
        PASS /home/agent/.config/gh absent
        PASS /root/.ssh absent
        PASS no ~/.ssh or ~/.config/gh in /proc/self/mounts
        == private remote
        remote: Repository not found.
        fatal: Authentication failed for 'https://github.com/MLSavage/essaydown-private-authcheck/'
        PASS git ls-remote of the private authcheck repo failed (rc=128)
        == pdfimages
        PASS pdfimages -v runs: pdfimages version 22.12.0
        BOUNDARY-OK
    PASS credential boundary (boundary-check → BOUNDARY-OK; includes pdfimages -v)
    == node ralph/validate-tasks.mjs (EXPECTED_COUNT 122)
        validate-tasks: OK 122 expanded tasks (EXPECTED_COUNT 122), phases 0,1,2,3,4,5,6, acyclic, byte-identical to PRD §8
    PASS node ralph/validate-tasks.mjs (EXPECTED_COUNT 122)
    == ralph/test/run.sh conformance suite (RUNNER-SPEC §12)
          ...
        # Subtest: validator rejects: phase without an initial verifier
        ok 39 - validator rejects: phase without an initial verifier
          ---
          duration_ms: 0.082375
          type: 'test'
          ...
        # Subtest: validator rejects: phase without a close
        ok 40 - validator rejects: phase without a close
          ---
          duration_ms: 0.075333
          type: 'test'
          ...
        # Subtest: validator rejects: unknown model
        ok 41 - validator rejects: unknown model
          ---
          duration_ms: 0.076708
          type: 'test'
          ...
        # Subtest: validator rejects: shell-unsafe id
        ok 42 - validator rejects: shell-unsafe id
          ---
          duration_ms: 0.075083
          type: 'test'
          ...
        # Subtest: review attempt chain must be linear and the close must depend on the newest d
        ok 43 - review attempt chain must be linear and the close must depend on the newest d
          ---
          duration_ms: 0.157375
          type: 'test'
          ...
        1..43
        # tests 59
        # suites 0
        # pass 59
        # fail 0
        # cancelled 0
        # skipped 0
        # todo 0
        # duration_ms 77399.785333
    PASS ralph/test/run.sh conformance suite (RUNNER-SPEC §12)
    == ralph/check-agent-rules.sh
        check-agent-rules: OK (CLAUDE.md ≡ AGENTS.md below line 1)
    PASS ralph/check-agent-rules.sh
    == merge=union lessons.md merges two branches cleanly (fixture repo)
        Auto-merging docs/lessons.md
        merge=union: both lines present after merging a into b
        # lessons
        - [b] LESSON: line from b
        - [a] LESSON: line from a
    PASS merge=union lessons.md merges two branches cleanly (fixture repo)
    == external clone .ext/build-defaults (clean, refs/heads/main present, validate-defaults.mjs passes)
        validate-defaults: OK version 1.11.0, 12 sections, 12 retro entries
        external build-defaults at 8573e0ecf117000c669a07a11fa3ab5140cdaa36 (refs/heads/main)
    PASS external clone .ext/build-defaults (clean, refs/heads/main present, validate-defaults.mjs passes)
    == journal entry + task(0.0) commit

- [0.1] 2026-09-06T06:18:56Z Task: scaffold monorepo (pnpm workspaces, packages/core|editor|modes|coach|export, apps/desktop Tauri 2 + React + Vite, Vitest + @vitest/coverage-v8 with per-file thresholds, ESLint/Prettier, e2e/web Playwright + e2e/shell WebdriverIO placeholders, tests/agent-rules.test.ts). Status: Complete. Files: eslint.config.js, vitest.config.ts, .gitignore (this iteration); rest of the scaffold already present from prior wip commits (pnpm-workspace.yaml, packages/*, apps/desktop, e2e/*, tests/agent-rules.test.ts). Tests: pnpm test 6/6 passed (one placeholder test per package + agent-rules test); cargo test 0/0/0 (no Rust tests yet, workspace compiles clean); pnpm lint clean; pnpm coverage prints a per-file table (100% on the 5 placeholder files) after adding coverage.reporter [["text",{skipFull:false}],"html"] and test.reporters ["default"] to vitest.config.ts — the bare reporter:["text"] config from a prior attempt printed only the summary with an empty per-file table; pnpm tauri dev under Xvfb :99 opened a window verified titled "Essay Down" via a throwaway Xlib probe compiled with system gcc/libX11 (no wmctrl/xdotool available in the container and no root to install one), then the tauri/vite/cargo processes and Xvfb were killed. Iterations used: 1 (this session; four prior attempts recorded in docs/lessons.md left the scaffold mostly built but never reached DONE). First attempt passed: n (this is the attempt that completed it). Tool calls: ~20. Notes: coverage/ (vitest html output) had been committed by a prior wip commit — removed with `git rm -r --cached coverage` and gitignored plus excluded in eslint.config.js; nothing else pending for 0.1's acceptance. Next task should not add editor code or CI per 0.1's scope note.

- [0.2] 2026-09-06T06:28:46Z Task: CI workflow .github/workflows/ci.yml (pnpm lint, pnpm test, cargo test on ubuntu-latest/macos-latest/windows-latest; installs JDK via actions/setup-java, poppler-utils, and pinned epubcheck/html-validate versions read from docker/versions.env; caches pnpm store and cargo via actions/cache; triggers only on push to ci/** per CLAUDE.md; test-logs artifact assembled from per-OS uploads via actions/upload-artifact/merge). Status: Blocked. Files: .github/workflows/ci.yml (new), docs/DECISIONS.md (#013-actionlint-gap), docs/lessons.md. Tests: pnpm lint clean; pnpm test 6/6 passed; cargo test 0/0/0 (workspace compiles, no Rust tests yet) — all green in-container. `versions in the workflow match docker/versions.env` verified by direct comparison (NODE_VERSION, PNPM_VERSION, RUST_TOOLCHAIN, EPUBCHECK_VERSION, HTML_VALIDATE_VERSION); YAML hand-checked (no tabs, consistent 2-space indent) since no YAML parser is available without adding one. Iterations used: 1. First attempt passed: n. Tool calls: ~30. Notes: acceptance's other clause — "ci.yml lints under actionlint locally and act --dryrun resolves the three jobs" — is NOT verified: neither tool is in the essaydown-dev image (docker/Dockerfile, task 0.0), no version is pinned for either in docker/versions.env, and Docker itself is unavailable in-container so act could not run even if fetched. Adding either tool is a new pinned dependency, which CLAUDE.md gates on a DECISIONS note *and Michael's OK*; a loop task has no channel to get that OK, so none was added (see docs/DECISIONS.md #013-actionlint-gap for the manual procedure). Next iteration/principal: either get Michael to run actionlint+act on his host and report back, or explicitly authorize pinning them into docker/versions.env + docker/Dockerfile in a follow-up task, then re-verify 0.2's full acceptance and print DONE.

- [0.2] 2026-09-06T06:32:00Z Task: CI workflow .github/workflows/ci.yml (attempt 2, re-orientation). Status: Blocked (unchanged from attempt 1). Files: none changed this iteration. Tests: pnpm lint clean; pnpm test 6/6 passed; cargo test 0/0/0 (workspace compiles) — re-verified green in-container. Iterations used: 2. First attempt passed: n. Tool calls: ~10. Notes: re-checked for anything that would unblock the remaining acceptance clause ("ci.yml lints under actionlint locally and act --dryrun resolves the three jobs") — /logs/human does not exist (no accepted.json for 0.2 or 0.2h), docker/versions.env and docker/Dockerfile are unchanged (no actionlint/act pin), docs/DECISIONS.md #013-actionlint-gap already records the finding and manual procedure accurately. ci.yml itself (150 lines) is unchanged and still matches its task description: pnpm lint/test + cargo test on 3 OSes, JDK/poppler/epubcheck/html-validate installed and versions read from docker/versions.env (verified again by direct comparison), triggers only on push to ci/**, per-OS logs merged into one test-logs artifact. No new dependency was added (CLAUDE.md requires a DECISIONS note *and Michael's OK* for that, and a loop task has no channel to obtain the OK). Next iteration: nothing changes here until either Michael runs actionlint/act on his own host and reports the result, or gives explicit OK (via an interactive-principal task) to pin actionlint+act into docker/versions.env + docker/Dockerfile — do not re-attempt this from a loop task; re-read DECISIONS #013 first instead of re-deriving the same conclusion from scratch.

- [0.2] 2026-09-06T06:33:00Z Task: CI workflow .github/workflows/ci.yml (attempt 3, re-orientation). Status: Blocked (unchanged from attempts 1-2). Files: none changed this iteration. Tests: pnpm lint clean; pnpm test 6/6 passed; cargo test 0/0/0 (workspace compiles, no Rust tests yet) — re-verified green in-container. Iterations used: 3. First attempt passed: n. Tool calls: ~8. Notes: per attempt 2's own instruction, did not re-derive the actionlint/act conclusion from scratch — read docs/DECISIONS.md #013-actionlint-gap directly, confirmed docker/Dockerfile and docker/versions.env still have no actionlint/act reference and /logs/human/0.2/accepted.json still does not exist, so nothing has changed that would unblock the remaining acceptance clause ("ci.yml lints under actionlint locally and act --dryrun resolves the three jobs"). ci.yml itself is unchanged from attempt 1 and still matches its task description. No new dependency added (CLAUDE.md requires a DECISIONS note *and Michael's OK*, unobtainable from a loop task). Next iteration: same as attempt 2 — nothing changes here until Michael runs actionlint/act on his own host and reports the result, or an interactive-principal task gets his explicit OK to pin actionlint+act into docker/versions.env + docker/Dockerfile. A fourth loop attempt on this task will find the identical state; consider routing 0.2 to a human gate or principal task instead of another loop attempt.

- [0.2] 2026-09-06T06:37:30Z Task: CI workflow .github/workflows/ci.yml (attempt 4, re-verification after image fix). Status: Complete. Files: none changed this iteration (ci.yml unchanged since attempt 1; docker image and DECISIONS.md were updated by a principal commit between attempts, not by this agent). Tests: `actionlint .github/workflows/ci.yml` exits 0, no findings; `act --list -W .github/workflows/ci.yml` lists both jobs (test, merge-logs) for the push trigger — warns about no Docker socket but does not fail, consistent with DECISIONS #014's in-container reading (matrix expansion and the 3-OS proof happen at the real `0.2h` CI gate, not here); versions in ci.yml (NODE_VERSION, PNPM_VERSION, RUST_TOOLCHAIN, EPUBCHECK_VERSION, HTML_VALIDATE_VERSION, all read via `docker/versions.env` sourced into $GITHUB_ENV rather than hardcoded) match docker/versions.env by construction. `pnpm lint` clean; `pnpm test` 6/6 passed; `cargo test` 0/0/0 (workspace compiles, no Rust tests yet) — all green in-container. Iterations used: 4 (3 prior attempts blocked on the actionlint/act gap per DECISIONS #013; the gap was resolved by `fix(image) befc9b2` + DECISIONS #014, a principal action, before this attempt started). First attempt passed: n. Tool calls: ~10. Notes: task 0.2's acceptance is now fully met; no remaining work. The next task should not re-touch ci.yml, docker/Dockerfile or docker/versions.env for actionlint/act — they are pinned and installed as of this phase.

- [0.2] 2026-09-06T06:45:15Z Task: CI workflow .github/workflows/ci.yml (attempt 5, final re-verification after conflict resolution). Status: Complete. Files: none changed this iteration — a principal commit (de84774) had removed conflict markers a bad cherry-pick left in docs/DECISIONS.md (both the agent's #013-actionlint-gap entry and the principal's #014-act-dryrun entry landed; #014 restates #013's finding as resolved), and a prior wip commit (de1b0cf) had already re-verified once. This iteration independently confirmed: scanned the whole tree for `<<<<<<<`/`=======`/`>>>>>>>` markers (none found), `git status` clean. Tests: `actionlint .github/workflows/ci.yml` exits 0 with no findings; `act --list -W .github/workflows/ci.yml` lists both jobs (test, merge-logs) for the push trigger (Docker-socket warning only, per DECISIONS #014's in-container reading — the 3-OS proof is the real `0.2h` CI gate); every `docker/versions.env` key ci.yml reads (NODE_VERSION, PNPM_VERSION, RUST_TOOLCHAIN, EPUBCHECK_VERSION, HTML_VALIDATE_VERSION) matches by construction (workflow sources the file directly via `$GITHUB_ENV`, cross-checked by grep). `pnpm lint` clean; `pnpm test` 6/6 passed; `cargo test` 0/0/0 (workspace compiles, no Rust tests yet). Iterations used: 5. First attempt passed: n. Tool calls: ~10. Notes: task 0.2's acceptance is fully met and independently re-verified; printing DONE.

- [0.3] 2026-09-06T07:08:10Z Task: docs/MARKDOWN-STYLE.md (11 numbered style rules + 12 machine-read examples) and the canonical parser/formatter in packages/core/src/{parse,format}.ts — remark-parse + remark-frontmatter(yaml) + the three individual GFM extensions of PRD §4 (table, strikethrough, autolink-literal; footnotes and task lists deliberately absent), remark-stringify configured to the style doc, and byte-preserving `html`/`yaml` handlers for the opaque set of PRD §6.1. Status: Complete. Files: docs/MARKDOWN-STYLE.md (new), packages/core/src/parse.ts (new), packages/core/src/format.ts (new), packages/core/src/index.ts (re-exports), packages/core/test/markdown-style.test.ts (new), packages/core/test/opaque-roundtrip.test.ts (new), packages/core/test/fixtures/front-matter/{quoted,commented,block-scalar,duplicate,malformed}.md (new), packages/core/package.json + pnpm-lock.yaml (PRD §4 remark/mdast/micromark deps). Tests: `pnpm lint` clean; `pnpm test` 28/28 passed (22 of them new in packages/core); `cargo test` 0/0/0 (workspace compiles, no Rust tests yet) — all green in-container. Acceptance mapped one-to-one: 12 assertions read the twelve examples out of docs/MARKDOWN-STYLE.md by fence extraction (plus a guard asserting the numbers are exactly 1..12, so the count comes from the doc and not from the test) and compare `format(parse(input))` to the listed output byte-for-byte; 2 assertions cover an html node and a yaml block being byte-identical after the trip (node value before, node value after, and the whole file unchanged); 1 assertion covers `[^1]` reaching the tree as plain `text` with no footnote node anywhere; 5 assertions round-trip the quoted, commented, block-scalar, duplicate and malformed front-matter fixtures byte-identical (plus a guard asserting exactly those five files are present). Iterations used: 1. First attempt passed: y. Tool calls: ~20. Notes: (1) the front-matter fixtures live in packages/core/test/fixtures/front-matter/, NOT in fixtures/markdown/ — task 0.4 owns that directory and its acceptance counts exactly 44 files with 44 `.canonical.md` siblings, so putting five sibling-less files there would have broken it; 0.4 should write its own front-matter fixtures in fixtures/markdown/ and may reuse the bodies here. (2) The `yaml` handler has one branch not exercised by the five fixtures: empty front matter (`---\n---`) is emitted without the blank line that a naive `---\n${value}\n---` would produce; verified by hand this iteration, and 0.4 should add an empty-front-matter fixture so the branch is covered by the corpus. (3) `packages/core` gained two type-declaration devDependencies, `@types/mdast` (the AST PRD §4 mandates) and `@types/node` (needed because packages/core/tsconfig.json includes `test`, and the tests read the style doc and fixtures from disk); both are declarations for things §4 already names, neither ships any runtime code, and `pnpm --filter @essaydown/core typecheck` is clean. (4) The processors are built per call in `createParser`/`createFormatter` rather than held at module level, per the PRD §9 "no module-level config" rule; if 0.6's invariant suite on 45 fixtures turns out slow, the fix is an injected processor argument, not a module-level singleton. (5) `pnpm format` (prettier) was already failing on 26 pre-existing files before this task and is not part of the green bar or of ci.yml; docs/MARKDOWN-STYLE.md is deliberately not prettier-formatted, because prettier rewrites `*emphasis*` to `_emphasis_` and would corrupt the twelve examples the test reads.

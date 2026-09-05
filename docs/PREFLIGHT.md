# PREFLIGHT.md — before task 0.0 (bootstrap)

Michael completes this checklist on the **Mac Mini** (host: node v22.22.1, git 2.50.1, tmux 3.6a) (the always-on host; decided 2026-09-05, handoff 001); 0.0 does not start until every line is true. It lives outside the task graph because the graph's own tooling does not exist yet (RUNNER-SPEC §2).

## §0 Setup (numbered steps; each `bash` block is one paste, and every interactive command is its own step because a pasted block dies at the first program that takes over the terminal)

The seed goes to GitHub from the MacBook Pro first, then the Mini clones it; nothing is copied machine to machine.

**0.1 On the MacBook Pro — create the repo from the seed** (needs `gh`; if `gh --version` fails: `brew install gh && gh auth login` first):

```bash
cd ~/Developer/essaydown \
&& printf '.DS_Store\n.ext/\n.evidence/\nlogs/\n.claude/settings.local.json\n' > .gitignore \
&& git init -b main && git add -A && git commit -m "docs: planning locked (PRD v14, RUNNER-SPEC 1.7, BUILD-DEFAULTS 1.11.0)" \
&& gh repo create MLSavage/essaydown --private --source=. --remote=origin --push \
&& gh repo create MLSavage/essaydown-private-authcheck --private \
&& rm -rf /tmp/bd && mkdir -p /tmp/bd && cp BUILD-DEFAULTS.md /tmp/bd/ \
&& (cd /tmp/bd && git init -b main && git add -A && git commit -m "BUILD-DEFAULTS 1.11.0" && gh repo create MLSavage/build-defaults --private --source=. --remote=origin --push) \
&& echo SEED-OK
```

Expected last line: `SEED-OK`. Reversal: `gh repo delete MLSavage/<name> --yes` per repo and `rm -rf .git .gitignore`. From here on the MacBook copy is a normal clone; edit on the Mini.

**0.2 On the Mini — verify what is already there** (read-only; paste, then compare with the notes after it):

```bash
gh auth status; echo "---"; which -a codex claude grok tmux node docker; echo "---"; codex --version; claude --version; node --version; docker compose version
```

Notes: `gh auth status` must say "Logged in to github.com". A `codex` that is listed by `which` but fails to run usually means it was installed under a Node version manager whose Node is no longer the default; `npm install -g @openai/codex` reinstalls it under the current Node. Codex refuses to run as root and warns in directories it does not trust: always run it as your user inside a project directory. If `claude --version` fails, install it in 0.3.

**0.3 On the Mini — install only what 0.2 showed missing:**

```bash
brew install node                                   # only if node --version failed
brew install --cask orbstack                        # only if docker compose version failed
curl -fsSL https://claude.ai/install.sh | bash       # only if claude --version failed
npm install -g @openai/codex                        # only if codex --version failed
curl -fsSL https://x.ai/cli/install.sh | bash        # Grok Build CLI (not installed yet)
open -a OrbStack && sleep 20 && docker compose version
```

**0.4 On the Mini — clone:**

```bash
mkdir -p ~/Developer && cd ~/Developer && gh repo clone MLSavage/essaydown && cd essaydown \
&& mkdir -p .ext && gh repo clone MLSavage/build-defaults .ext/build-defaults \
&& git status --short && ls docs .ext/build-defaults && echo CLONE-OK
```

**0.5 Logins, one at a time** (each opens a browser; finish it before the next):

- `cd ~/Developer/essaydown && claude` → accept workspace trust, type `/login` (subscription), then `/exit`. This first run in the repo directory is what Remote Control needs.
- `codex login` (subscription), then `codex --version`.
- `grok` → X-account login; then `/exit` and note the login-state directory (`ls -la ~/.grok`) on the checklist line below.
- Check nothing disables Remote Control: `env | grep -E 'DISABLE_TELEMETRY|DO_NOT_TRACK|CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC|DISABLE_GROWTHBOOK|ANTHROPIC_BASE_URL'` must print nothing.

**0.6 On the Mini — the principal session**, two steps:

- `cd ~/Developer/essaydown && tmux new -s essaydown -n principal`
- inside tmux: `claude --remote-control essaydown-principal` → pick the model with `/model` (Opus or Fable), then scan the QR code with the Claude iPhone app. Paste the contents of `docs/handoffs/next-prompt.md` as the first message.

Later: `tmux attach -t essaydown` brings the windows back (from the Mini, or over ssh from the phone with Termius/Blink once Remote Login is on; Tailscale makes that work away from home and is worth a separate ten minutes). If the `claude` process died, `claude --continue` in the repo directory reconnects the same conversation.

## Checklist

- [x] GitHub repo `MLSavage/essaydown` created and added as `origin` on the Mini checkout at `~/Developer/essaydown`; `main` pushed with the planning docs (§0.1, cloned in §0.4). Seed commit `660f3aa`. Made **public** 2026-09-05 (DECISIONS #010/#011).
- [x] Private empty repo `MLSavage/essaydown-private-authcheck` created (`gh repo view` → isPrivate true, 2026-09-05).
- [x] `MLSavage/build-defaults` cloned to `~/Developer/essaydown/.ext/build-defaults` (origin https, main at `5bba495` BUILD-DEFAULTS 1.11.0).
- [x] OrbStack running (Docker Engine 29.4.0); `docker compose version` → Docker Compose version v5.1.2.
- [x] Claude Code CLI installed and logged in (`claude auth status` → loggedIn true, authMethod claude.ai); `claude --version` recorded here: 2.1.261 (Claude Code). Note: on macOS the login lives in the Keychain, not in `~/.claude`, so the container cannot mount it (DECISIONS #012).
- [x] Codex CLI installed and logged in (`codex login status` → Logged in using ChatGPT); `codex --version` recorded here: codex-cli 0.153.4.
- [x] Grok Build CLI installed and logged in with the X account; `grok --version` recorded here: grok 1.0.13 (5e9a58528b76) [stable]; login-state directory path recorded here: `$HOME/.grok` (file `auth.json`; the same directory also holds the binary in `bin/`, so the container mounts only `auth.json`, DECISIONS #012).
- [x] `gh auth status` succeeds on the host (account MLSavage, keyring, scopes gist/read:org/repo/workflow; 2026-09-05).
- [x] Remote Control connected (tmux session `essaydown`, window `principal`; the 0.0 session ran through it, 2026-09-05).
- [x] agent writes the fixture (Michael, 2026-09-05; the repo is public, DECISIONS #011).
- [ ] Ollama installed on the MacBook Pro (or the Mini) with one ~8B and one 70B+ open-weight model pulled (needed at 5.3b, not before). Not on the Mini as of 2026-09-05 (`which ollama` empty); deferred to Phase 5.

When all boxes are ticked, the principal session takes over (docs/handoffs/next-prompt.md): it builds task 0.0 on `phase/0` and runs `ralph/bootstrap.sh`, which makes the final `task(0.0)` commit and initialises `.evidence/state/`.

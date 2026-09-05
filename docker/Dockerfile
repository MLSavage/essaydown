# essaydown-dev — one image for implementation agents (Claude Code) and reviewers (Claude, Codex, Grok).
# Every version comes from docker/versions.env (PRD §4 "Agent runtime", task 0.0).
# No git credentials, no API keys, no SSH agent: the container never pushes (PRD §9.12).
ARG NODE_VERSION=22.22.1
ARG DEBIAN_CODENAME=bookworm
FROM node:${NODE_VERSION}-${DEBIAN_CODENAME}

ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive
COPY versions.env /etc/essaydown/versions.env

# --- Debian packages: build tools, Tauri Linux deps, webkit2gtk-driver, xvfb, pandoc's runtime deps,
#     poppler-utils (pdfimages/pdftotext), a headless JDK for epubcheck, misc CLI tools.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential curl wget file git ca-certificates pkg-config \
      libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev \
      webkit2gtk-driver xvfb libfuse2 patchelf \
      poppler-utils default-jdk-headless \
      unzip zip xz-utils jq rsync python3 procps less locales \
    && sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen \
    && rm -rf /var/lib/apt/lists/*
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# --- agent user (uid 1000; Claude Code refuses --dangerously-skip-permissions as root, Codex refuses root)
RUN usermod -l agent -d /home/agent -m node && groupmod -n agent node \
    && mkdir -p /work /logs /scratch && chown agent:agent /work /logs /scratch

# --- Rust (pinned toolchain) + tauri-driver, shared read-only under /usr/local
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN . /etc/essaydown/versions.env \
    && curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain "$RUST_TOOLCHAIN" \
    && rustup component add clippy rustfmt \
    && cargo install tauri-driver --version "$TAURI_DRIVER_VERSION" --locked \
    && rm -rf /usr/local/cargo/registry /usr/local/cargo/git \
    && chmod -R a+rX /usr/local/rustup /usr/local/cargo

# --- pandoc (.deb from GitHub), typst (musl tarball), epubcheck (zip + wrapper)
RUN . /etc/essaydown/versions.env && set -eux \
    && case "$TARGETARCH" in amd64) PARCH=amd64; TARCH=x86_64;; arm64) PARCH=arm64; TARCH=aarch64;; *) echo "unsupported arch $TARGETARCH" >&2; exit 1;; esac \
    && curl -fsSL -o /tmp/pandoc.deb "https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/pandoc-${PANDOC_VERSION}-1-${PARCH}.deb" \
    && dpkg -i /tmp/pandoc.deb && rm /tmp/pandoc.deb \
    && curl -fsSL -o /tmp/typst.tar.xz "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-${TARCH}-unknown-linux-musl.tar.xz" \
    && tar -xJf /tmp/typst.tar.xz -C /tmp && install -m 0755 "/tmp/typst-${TARCH}-unknown-linux-musl/typst" /usr/local/bin/typst && rm -rf /tmp/typst* \
    && curl -fsSL -o /tmp/epubcheck.zip "https://github.com/w3c/epubcheck/releases/download/v${EPUBCHECK_VERSION}/epubcheck-${EPUBCHECK_VERSION}.zip" \
    && unzip -q /tmp/epubcheck.zip -d /opt && rm /tmp/epubcheck.zip \
    && printf '#!/bin/sh\nexec java -jar /opt/epubcheck-%s/epubcheck.jar "$@"\n' "$EPUBCHECK_VERSION" > /usr/local/bin/epubcheck \
    && chmod 0755 /usr/local/bin/epubcheck \
    && pandoc --version | head -1 && typst --version && epubcheck --version && pdfimages -v 2>&1 | head -1

# --- pnpm (corepack), html-validate, Claude Code CLI, Codex CLI (all npm, pinned)
RUN . /etc/essaydown/versions.env \
    && corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
    && npm install -g "html-validate@${HTML_VALIDATE_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force \
    && pnpm --version && html-validate --version && claude --version && codex --version

# --- Grok Build CLI: installed with a throwaway HOME so the binary lives in /opt, not in the
#     agent's ~/.grok (which is the login-state volume at runtime).
RUN . /etc/essaydown/versions.env \
    && mkdir -p /opt/grok-home /opt/grok/bin \
    && HOME=/opt/grok-home GROK_BIN_DIR=/opt/grok/bin bash -c 'curl -fsSL https://x.ai/cli/install.sh | bash -s "$0"' "$GROK_VERSION" \
    && chmod -R a+rX /opt/grok-home /opt/grok \
    && ln -s /opt/grok/bin/grok /usr/local/bin/grok \
    && HOME=/opt/grok-home grok --version

# --- git identity + safety inside the container; no credential helper anywhere
RUN git config --system user.name "essaydown-agent" \
    && git config --system user.email "agent@essaydown.invalid" \
    && git config --system --add safe.directory '*' \
    && git config --system init.defaultBranch main \
    && git config --system pull.rebase true

COPY entrypoints/ /usr/local/bin/
RUN chmod 0755 /usr/local/bin/claude-task /usr/local/bin/claude-review /usr/local/bin/codex-review \
               /usr/local/bin/grok-review /usr/local/bin/boundary-check /usr/local/bin/essaydown-common.sh

USER agent
WORKDIR /work
ENV HOME=/home/agent \
    CLAUDE_CONFIG_DIR=/home/agent/.claude \
    CARGO_HOME=/home/agent/.cargo \
    PATH=/home/agent/.cargo/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin \
    GIT_TERMINAL_PROMPT=0 \
    GIT_ASKPASS=/bin/true \
    APPIMAGE_EXTRACT_AND_RUN=1 \
    NO_AT_BRIDGE=1 \
    ESSAYDOWN_CONTAINER=1
RUN mkdir -p /home/agent/.claude /home/agent/.codex /home/agent/.grok /home/agent/.cargo /home/agent/.local/share/pnpm

# ─── Build Stage ────────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/core/package.json ./packages/core/
COPY packages/analysis-service/package.json ./packages/analysis-service/
COPY packages/indexer/package.json ./packages/indexer/

RUN pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# Copy source and build
COPY tsconfig.json ./
COPY packages/core/ ./packages/core/
COPY packages/analysis-service/ ./packages/analysis-service/
COPY packages/indexer/ ./packages/indexer/

RUN pnpm -r build

# ─── Production Stage ───────────────────────────────────────────────────────────
FROM node:22-slim AS production

# ══════════════════════════════════════════════════════════════════════
# LAYER ORDER STRATEGY: most-stable → least-stable
#
# Layers are ordered from most to least stable so that a typical
# "code change only" deployment hits as many cached layers as possible.
#
# Stable (never/rarely change)      → early layers  → always cached
# Semi-stable (version bumps)       → middle layers → cached between bumps
# Volatile (every code deploy)      → late layers   → always rebuilt
#
# Result: a code-only deploy rebuilds only the last ~5 layers (~50MB)
# instead of the full image (~2GB), cutting node pull time by ~30s.
# ══════════════════════════════════════════════════════════════════════

# ── Layer 1: OS packages (stable — change only on security updates) ──
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    jq \
    ca-certificates \
    python3 \
    python3-pip \
    make \
    g++ \
    python3-dev \
  && rm -rf /var/lib/apt/lists/*

# ── Layer 2: ast-grep (stable — pinned by npm dist-tag) ─────────────
RUN npm install -g @ast-grep/cli

# ── Layer 3: pi agent (semi-stable — change on pi version bumps) ─────
# Pin to 0.79.4: versions 0.74.x had a session-init stall in RPC mode when
# certain extensions (pi-subagents, pi-hermes-memory) registered async
# session_start handlers that did not resolve under the 0.74 extension API.
# This caused piWorker to never receive the "session" event, producing zero
# output from the analysis agent.
RUN npm install -g @earendil-works/pi-coding-agent@0.79.4

# ── Layer 4: tsx + corepack (stable) ─────────────────────────────────
RUN npm install -g tsx
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# ── Layer 5: graphify Python packages (~600MB, very stable) ──────────
# The `openai` extra is required for the tokenhub custom provider (openai-compatible API).
RUN pip install graphifyy "graphifyy[openai]" --break-system-packages

# ── Layer 6: graphify custom provider config (stable) ────────────────
# Register tokenhub as a graphify custom provider so the indexer can reuse the
# existing LLM_ANALYSIS_API_KEY (mapped to TOKENHUB_API_KEY at runtime) without
# needing a separate API key. The base_url matches the rest of the service.
RUN mkdir -p /root/.graphify && printf '%s\n' \
    '{' \
    '  "tokenhub": {' \
    '    "base_url": "https://tokenhub.tencentmaas.com/v1",' \
    '    "default_model": "deepseek-v4-pro",' \
    '    "env_key": "TOKENHUB_API_KEY",' \
    '    "pricing": {"input": 0.0, "output": 0.0}' \
    '  }' \
    '}' \
    > /root/.graphify/providers.json

# ── Layer 7: pi extensions (~200MB, semi-stable) ─────────────────────
# Pre-install pi extensions GLOBALLY so pi's PackageManager finds them via
# getNpmInstallPath(scope=user) → join(getGlobalNpmRoot(), pkg). Inside this
# image `npm root -g` resolves to /usr/local/lib/node_modules.
#
# IMPORTANT: do NOT install these to ~/.pi/agent/npm/ — pi only looks there
# for scope="project". With user scope (the default for `npm:` sources in
# settings.json), pi's existsSync() check fails → it re-runs `npm install`
# at every session start. With ≥2 pi workers spawning concurrently this
# triggers ENOTEMPTY / EEXIST races on rename(node_modules/<pkg>), causing
# every worker to crash with exit code 1 and consume 30+ seconds before
# retrying. Pre-installing globally aligns the path pi looks up with where
# the package actually lives, skipping the install entirely.
#
#   pi-mcp-adapter  — MCP client for pi (prerequisite for context-mode)
#   pi-web-access   — Phase 2: ai_docs/HTTP fetch for semantic layer generation
#   pi-lens         — Phase 2: LSP + type analysis for richer semantic layer
#   pi-hermes-memory— Phase 3: SQLite FTS5 persistent memory for risk patterns
#
# NOTE: pi-subagents is intentionally omitted — in RPC mode it opens an IPC
# socket that can stall for 45-180s when the socket path is unavailable
# (e.g. NFS mount point collision, container cgroup restriction, or concurrent
# worker race). This stall prevents the "session" event from ever firing,
# causing every worker to produce zero output. pi-subagents is a UI feature
# (parallel sub-task display) not needed for headless analysis workers.
RUN npm install -g \
      pi-mcp-adapter \
      pi-web-access \
      pi-lens \
      pi-hermes-memory

# ── Layer 8: context-mode MCP server (~30MB, semi-stable) ────────────
# Install globally so pi-mcp-adapter can spawn it without runtime download.
# NOT registered in mcp.json — see mcp.json config below for the reason.
RUN npm install -g context-mode

# ── Layer 9: pi agent config (stable, small) ─────────────────────────
RUN mkdir -p /root/.pi/agent

# Register extension packages in pi settings.json
# (separate from models.json — pi merges both at startup)
RUN printf '%s\n' \
    '{' \
    '  "packages": [' \
    '    "npm:pi-mcp-adapter",' \
    '    "npm:pi-web-access",' \
    '    "npm:pi-lens",' \
    '    "npm:pi-hermes-memory"' \
    '  ]' \
    '}' \
    > /root/.pi/agent/settings.json

# Configure MCP servers for pi-mcp-adapter.
# context-mode is installed globally above but NOT registered in mcp.json for
# RPC workers: in pi 0.79.x, pi-mcp-adapter blocks session startup until ALL
# configured MCP servers have connected (even lifecycle=lazy ones attempt an
# initial handshake). When context-mode fails to start (npx cold-start, network
# check, or container cgroup restrictions), the "session" event never fires and
# every piWorker times out after 45s. Analysis workers don't need context-mode
# (they use direct bash/grep tools), so the config is left empty.
RUN printf '%s\n' \
    '{' \
    '  "mcpServers": {}' \
    '}' \
    > /root/.pi/agent/mcp.json

# ══════════════════════════════════════════════════════════════════════
# VOLATILE LAYERS — rebuilt on every code deploy (~50MB total)
# Everything below this line changes with each deployment.
# ══════════════════════════════════════════════════════════════════════

WORKDIR /app

# ── Layer 10: pi models config (changes with model config updates) ────
COPY config/pi-models.json /root/.pi/agent/models.json

# ── Layer 11: built application artifacts (changes every deploy) ──────
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/packages/core/dist/ ./packages/core/dist/
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/analysis-service/dist/ ./packages/analysis-service/dist/
COPY --from=builder /app/packages/analysis-service/package.json ./packages/analysis-service/
COPY --from=builder /app/packages/analysis-service/node_modules/ ./packages/analysis-service/node_modules/

# ── Layer 12: pi skill files (changes with skill updates) ────────────
COPY packages/pi-skill/ ./packages/pi-skill/

# ── Layer 13: indexer (changes with indexer updates) ─────────────────
COPY packages/indexer/ ./packages/indexer/
RUN cd packages/indexer && npm install --omit=dev

# ── Layer 14: CLI scripts (changes with script updates) ───────────────
COPY scripts/ ./scripts/

# Runtime config
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "packages/analysis-service/dist/index.js"]

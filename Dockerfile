# ─── Build Stage ────────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

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
FROM node:20-slim AS production

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

# Install ast-grep
RUN npm install -g @ast-grep/cli

# Install pi agent
RUN npm install -g @earendil-works/pi-coding-agent

# Install tsx (for running indexer scripts)
RUN npm install -g tsx

# Install graphify (knowledge graph for documentation knowledge bases)
# Used by indexer to build graph.json over knowledge_base[] entries in project.yml,
# and by pi workers at analysis time via `graphify query` for on-demand retrieval.
# The `openai` extra is required for the tokenhub custom provider (openai-compatible API).
RUN pip install graphifyy "graphifyy[openai]" --break-system-packages

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

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

# Copy built artifacts
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/packages/core/dist/ ./packages/core/dist/
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/analysis-service/dist/ ./packages/analysis-service/dist/
COPY --from=builder /app/packages/analysis-service/package.json ./packages/analysis-service/
COPY --from=builder /app/packages/analysis-service/node_modules/ ./packages/analysis-service/node_modules/

# Copy pi skill files
COPY packages/pi-skill/ ./packages/pi-skill/

# Copy indexer (for generate-agents-md)
COPY packages/indexer/ ./packages/indexer/
RUN cd packages/indexer && npm install --omit=dev

# Copy CLI scripts (e.g. render-report.ts) — useful for in-pod debugging
# and report rendering against the on-NFS task store.
COPY scripts/ ./scripts/

# Configure pi agent custom provider
RUN mkdir -p /root/.pi/agent
COPY config/pi-models.json /root/.pi/agent/models.json

# ── Pi Extension Packages (Phase 2 & 3) ─────────────────────────────────────
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
#   pi-subagents    — Phase 2: parallel worker orchestration inside pi sessions
#   pi-web-access   — Phase 2: ai_docs/HTTP fetch for semantic layer generation
#   pi-lens         — Phase 2: LSP + type analysis for richer semantic layer
#   pi-hermes-memory— Phase 3: SQLite FTS5 persistent memory for risk patterns
#
RUN npm install -g \
      pi-mcp-adapter \
      pi-subagents \
      pi-web-access \
      pi-lens \
      pi-hermes-memory

# Register extension packages in pi settings.json
# (separate from models.json — pi merges both at startup)
RUN printf '%s\n' \
    '{' \
    '  "packages": [' \
    '    "npm:pi-mcp-adapter",' \
    '    "npm:pi-subagents",' \
    '    "npm:pi-web-access",' \
    '    "npm:pi-lens",' \
    '    "npm:pi-hermes-memory"' \
    '  ]' \
    '}' \
    > /root/.pi/agent/settings.json

# context-mode MCP server — install globally so pi-mcp-adapter can spawn it.
# "Saves 98% context window" via FTS5 knowledge base + sandboxed code execution.
# pi-mcp-adapter spawns it as a subprocess; global install avoids runtime download.
RUN npm install -g context-mode

# Configure MCP servers for pi-mcp-adapter.
# lifecycle=lazy: server connects only on first tool call, disconnects after 10 min idle.
# Config precedence: ~/.config/mcp/mcp.json < ~/.pi/agent/mcp.json < .pi/mcp.json
RUN printf '%s\n' \
    '{' \
    '  "mcpServers": {' \
    '    "context-mode": {' \
    '      "command": "npx",' \
    '      "args": ["-y", "context-mode"],' \
    '      "lifecycle": "lazy",' \
    '      "idleTimeout": 10' \
    '    }' \
    '  }' \
    '}' \
    > /root/.pi/agent/mcp.json

# Runtime config
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "packages/analysis-service/dist/index.js"]

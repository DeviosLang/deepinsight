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
RUN pip install graphifyy --break-system-packages

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

# Runtime config
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "packages/analysis-service/dist/index.js"]

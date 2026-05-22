# ─── Build Stage ────────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/core/package.json ./packages/core/
COPY packages/analysis-service/package.json ./packages/analysis-service/

RUN pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# Copy source and build
COPY tsconfig.json ./
COPY packages/core/ ./packages/core/
COPY packages/analysis-service/ ./packages/analysis-service/

RUN pnpm -r build

# ─── Production Stage ───────────────────────────────────────────────────────────
FROM node:20-slim AS production

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    jq \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install ast-grep
RUN npm install -g @ast-grep/cli

# Install pi agent
RUN npm install -g @earendil-works/pi-coding-agent

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

# Runtime config
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "packages/analysis-service/dist/index.js"]

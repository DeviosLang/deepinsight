# DeepInsight

> Cross-repo code impact analysis system — find who's affected before they find out the hard way.

DeepInsight analyzes code changes across multiple repositories, traces call chains, propagates risk scores, and produces prioritized impact reports with test recommendations.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    DeepInsight System                         │
│                                                              │
│  ┌──────────────────┐    ┌──────────────────────────────┐   │
│  │ Analysis Service  │───▶│  pi agent (RPC, per-worker)   │   │
│  │ (Fastify, Node)   │    │  bash/read/grep + Skill       │   │
│  └──────────────────┘    └──────────────────────────────┘   │
│         │                                                    │
│    ┌────┴─────┐                                              │
│    │ @deepinsight/core │  ← Pure algorithms (risk, merge)   │
│    └──────────┘                                              │
│                                                              │
│  Storage:                                                    │
│  ├── NFS: source repos (git clones)                          │
│  ├── Local SSD: temp worktrees (ast-grep needs fast I/O)     │
│  └── ConfigMap: project config + AGENTS.md                   │
└─────────────────────────────────────────────────────────────┘
```

## Packages

| Package | Description |
|---------|-------------|
| `@deepinsight/core` | Risk propagation algorithm, deterministic merger, shared types |
| `@deepinsight/analysis-service` | HTTP API, pre-filter, pi orchestration, repo management |
| `packages/pi-skill` | pi agent Skill files (SKILL.md + scripts + references) |

## Quick Start

```bash
# Prerequisites
node --version  # >= 20
pnpm --version  # >= 9

# Install
pnpm install

# Run tests
pnpm test

# Type check
pnpm typecheck

# Full pre-check (typecheck + lint + test)
pnpm precheck

# Start dev server
pnpm dev
```

## Deployment

See [deploy/README.md](deploy/README.md) for K8s deployment instructions.

### Key Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `WORKSPACE_DIR` | Path to git repos (NFS mount) | Yes |
| `SCRATCH_DIR` | Local fast storage for temp worktrees | Yes |
| `LLM_ANALYSIS_API_KEY` | LLM provider API key | Yes |
| `LLM_BASE_URL` | OpenAI-compatible endpoint | Yes |
| `LLM_MODEL` | Model identifier | Yes |
| `PORT` | HTTP server port (default: 8080) | No |
| `LOG_LEVEL` | Pino log level (default: info) | No |

## API

### Submit Analysis

```bash
curl -X POST http://localhost:8080/api/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "project": "cloud-platform",
    "changes": [
      { "repo": "gateway-service", "branch": "feature/token-refactor", "base": "master" }
    ],
    "options": { "depth": 2, "includeTestPlan": true }
  }'
```

### Check Status

```bash
curl http://localhost:8080/api/analyze/{task_id}
```

## Project Config

Each project (business group) has a YAML config describing its repos and relationships. See [`config/projects/example.template.yml`](config/projects/example.template.yml) for the full template.

**Important**: Real configs with git credentials go in K8s ConfigMap, NOT in this repo.

## Design Documents

- [Specification](docs/features/cross-repo-impact-analysis.md) — Full system design (authoritative)
- [9-Point Analysis](docs/features/cross-repo-9-point-analysis.md) — Design derivation from Claude Code

## License

MIT

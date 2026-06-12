# DeepInsight 项目上下文

## 项目简介

DeepInsight 是一个代码分析服务，对指定 git 仓库的分支/commit 进行自动化分析，输出风险评估、测试建议等报告。

**技术栈：** Node.js 20、TypeScript、pnpm monorepo、Fastify、vitest、Docker、Kubernetes

## 代码结构

```
packages/
  analysis-service/   # 主服务，API 入口（Fastify）
    src/api/          # 路由定义（analyze.ts, health.ts）
    src/orchestrator/ # 分析流水线（调度 pi agent）
    src/repo/         # git 操作封装
    src/render/       # 报告渲染
    src/__tests__/    # 单元 / 集成测试
  indexer/            # 代码索引，生成 AGENTS.md 语义层
  core/               # 共享类型定义（Task、AnalyzeRequest 等）
  pi-skill/           # pi agent skill 文件
config/
  projects/           # 项目配置文件（.yml），每个业务项目一个
deploy/               # K8s 部署清单（deployment、service、cronjob）
scripts/
  build-push.sh       # 构建镜像并推送到腾讯镜像源
  deploy.sh           # Apply K8s 清单并滚动重启
  render-report.ts    # 在 Pod 内渲染历史报告（调试用）
```

## 常用开发命令

```bash
# 开发（热重载）
pnpm dev

# 构建全部 packages
pnpm build

# 测试
pnpm test                 # 全部测试
pnpm test:coverage        # 带覆盖率

# 代码检查
pnpm typecheck            # TypeScript 类型检查
pnpm lint                 # Biome lint
pnpm lint:fix             # 自动修复

# 提交前全量检查（typecheck + lint + test）
pnpm precheck

# 清理构建产物
pnpm clean
```

## 构建与部署

```bash
# 1. 构建镜像并推送
./scripts/build-push.sh              # 推送 :latest
./scripts/build-push.sh v1.2.3       # 推送指定版本（同时更新 :latest）
./scripts/build-push.sh --no-push    # 只构建不推送（本地验证用）

# 2. 部署到 K8s
./scripts/deploy.sh                  # apply 清单 + 滚动重启 + 等待就绪
./scripts/deploy.sh --apply-only     # 只更新配置（无需重启镜像）
./scripts/deploy.sh --restart-only   # 只重启（镜像已推送，跳过 apply）

# 完整发布流程
./scripts/build-push.sh && ./scripts/deploy.sh
```

## 本地调试（Docker Compose）

```bash
# 启动本地服务（需先配置 .env）
docker compose up

# .env 需提供
LLM_API_KEY=...
LLM_BASE_URL=...    # 可选，默认 localhost:11434
LLM_MODEL=...       # 可选，默认 deepseek-v4-pro
```

## API 设计

### 触发分析
```
POST /api/analyze
{
  "project": "<project_name>",
  "changes": [{ "repo": "<repo_name>", "branch": "<branch>" }],
  "options": { "includeTestPlan": true }
}
```

### 查询任务状态
```
GET /api/analyze/:taskId
GET /api/analyze/:taskId?format=markdown   # Markdown 格式
GET /api/tasks                             # 所有任务列表
DELETE /api/analyze/:taskId                # 取消任务
```

## 架构约定

- **类型共享：** 所有跨包共享类型定义在 `packages/core`，不要在各包内重复定义
- **HTTP 框架：** 只用 Fastify，不引入 Express
- **日志：** 统一使用 pino，不用 console.log
- **分析流水线：** 入口在 `orchestrator/`，路由层只做参数校验和任务调度
- **项目配置：** 每个业务项目的分析规则放 `config/projects/<name>.yml`，不硬编码

## 注意事项

- **Pod 内无 curl**，调试 HTTP 时用 `node -e "require('http').get(...)"` 替代（见 CLAUDE.local.md 示例）
- **Workspace 同步** 由 CronJob 每 30 分钟自动执行，手动分析前确认代码已同步（见 CLAUDE.local.md）
- **pnpm-lock.yaml 已锁定**，添加依赖后提交 lock 文件

## 本地部署配置

见 `CLAUDE.local.md`（已 gitignore，需自行按模板创建）

@CLAUDE.local.md

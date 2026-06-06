# DeepInsight — 跨仓代码影响范围分析

> **文档权威声明**：本文档是 DeepInsight（跨仓分析系统）的**最终设计规格**。
> `cross-repo-9-point-analysis.md` 是早期 Claude Code 借鉴分析与方案推导过程，设计冲突时以本文档为准。
> 重叠章节的权威版本：
> - Opik Trace 架构 → 本文档 §14
> - 自进化系统 → 本文档 §15
> - AnalysisCost 接口 → 本文档 §7
> - 风险传播模型 → 本文档 §7（引用 9-point §18 的算法细节）
> - Git 存储方案 → 本文档 §7（持久 worktree + 临时 worktree 双模式）

---

## 阅读指南

| 你是 | 重点阅读 | 可跳过 |
|------|---------|--------|
| 架构师（评审设计） | 核心问题、§7 架构图+SLA+容量、§9 做梦、§14 Opik、§15 自进化、§16 多租户 | §1-§4 工具安装细节 |
| 后端开发（实现分析服务） | §7 服务化、§8 AGENTS.md、§11 测试策略、§12 API+认证、§13 LLM+pi RPC 合约 | §3 本地工具、§6 处置流程 |
| DevOps（部署运维） | §7 K8s 部署+健康检查+告警+灾备、§8 CronJob、§14 Opik 部署 | §4 pi agent 本地模式 |
| 使用者（本地分析） | §1-§6 全部 | §7 以后全部 |
| 管理者（预算审批） | §11 成本预估、§7 SLA | 全部技术细节 |

---

## 要解决的核心问题

本文档同时解决两个互相依赖的问题：**跨仓调用链追踪** 和 **风险分析**。二者缺一不可——没有调用链，风险无法定位；没有风险分析，调用链只是一张没有结论的地图。

---

### 问题一：跨仓调用链追踪

你有 57 个代码仓库，其中有共享模块（如 `auth-lib`）被多个服务依赖。当你对共享函数做了修改，需要回答：

> **完整的跨仓调用链是什么？哪些仓库、哪些文件、哪些函数受到了影响？**

**为什么这很难**：Agent 没有内置的跨仓符号索引。

| 限制 | 说明 |
|------|------|
| 无跨仓符号索引 | Agent 没有内置的全局符号图；只能看到当前工作目录的文件 |
| diff 只说明"什么变了" | diff 不包含"谁依赖了这个符号"的信息 |
| 文件读取有边界 | 没有索引，Agent 不知道去哪里找调用点，只能逐一读取文件 |
| grep 不理解语法 | 纯文本搜索会混淆注释、字符串字面量、相似名称 |

**典型失败模式**：

```
用户: auth/service.py 第42行把 is 改成了 ==，分析影响
Agent: 这个改动影响了身份验证逻辑，建议检查所有调用 verify_token 的地方
用户: 具体是哪些文件？
Agent: 我需要搜索代码库...（没有工具，无法主动扫描）
```

即使挂载了多个目录，Agent 也需要消耗大量 token 逐一读取文件，且容易遗漏通过 barrel 文件 re-export 的间接调用者。

---

### 问题二：风险分析

拿到调用链之后，还需要回答：

> **这次改动有多危险？危险通过调用链传播到了哪里？有哪些节点没有测试覆盖？**

风险分析是一个独立的、同样困难的问题，原因如下：

**2.1 变更语义需要解读**

diff 的表面形式不等于风险等级。同样是"修改一行代码"，语义差异巨大：

| diff 类型 | 示例 | 风险等级 | 原因 |
|-----------|------|----------|------|
| 严格相等 → 宽松相等 | `===` 改 `==` | 🔴 极高 | 触发 JS 类型强制转换，可能绕过身份验证 |
| 返回类型变化 | `string` 改 `string \| null` | 🔴 高 | 调用方未做空值处理时 crash |
| 异常处理删除 | 删除 `try/catch` | 🔴 高 | 错误向上传播，可能导致服务崩溃 |
| 超时值变更 | `3000ms` 改 `30000ms` | 🟡 中 | 可能导致级联等待 |
| 注释变更 | 只改注释 | 🟢 低 | 无运行时影响 |

Agent 需要**读取 diff 语义**（不只是看到"有变更"），才能正确判断风险等级。

**2.2 风险与调用者上下文相关**

同一个符号的两个调用点，风险等级可以完全不同：

```
verify_token 的调用者：
  ├── cvm-api/views/login.py:18    login_view()    → 直接暴露给公网用户，风险 🔴
  └── cxm-api/admin/check.py:5    admin_check()   → 内部管理系统，风险 🟡
```

要判断每个调用点的风险，Agent 需要知道该调用点所在的**领域上下文**（对外 API？内部工具？支付流程？）。这需要读取调用点周围的代码，或通过仓库级 CLAUDE.md / AGENTS.md 提供元信息。

**2.3 风险沿调用链传播**

间接调用者（第 2 层）也可能是高风险节点。如果只看直接调用者，会遗漏传播风险：

```
verifyToken (变更)
  └── authMiddleware()           → 第 1 层，本身是鉴权层 [⚠️ 高风险]
       └── paymentController()  → 第 2 层，支付流程 [⚠️ 极高风险，需 QA]
```

**2.4 测试覆盖是风险缓冲**

风险等级相同的节点，有无测试覆盖对应完全不同的处置方式：
- 有测试覆盖 → 跑回归测试，测试通过则风险可接受
- 无测试覆盖 → 需要人工 review 或补测试后再合并

**典型失败模式**：

```
# 只有调用链，没有风险分析
受影响文件: cvm-api/views/login.py, cxm-api/middleware/auth.py, payment-service/handler.py...
→ 开发者不知道哪个最需要关注，按顺序逐一 review，浪费时间

# 只有风险标签，没有调用链
高风险: auth/service.py（因为改了 is → ==）
→ 不知道 auth/service.py 通过 middleware 影响了 payment 模块，遗漏最严重的风险点
```

---

### 解决方案

**两个问题的解法是互相依赖的**：先建立精确的调用链，再在调用链上做风险传播分析，最后针对风险等级实施处置。

```
Step 1: 解读 diff 语义 → 判断变更类型和初始风险等级
         ↓ (GitNexus CLI / Agent 分析)
Step 2: 构建完整跨仓调用链 → 找到所有受影响的调用点
         ↓ (GitNexus CLI + ast-grep + stack-graphs)
Step 3: 在调用链上传播风险 → 结合调用点上下文判断每个节点的风险等级
         ↓ (Agent 分析 + AGENTS.md 元信息 + 确定性规则引擎)
Step 4: 检查测试覆盖 → 确定哪些风险节点有兜底、哪些需要人工介入
         ↓ (coverage JSON / 测试文件检测)
Step 5: 输出风险优先级排序的完整报告 (P0/P1/P2)
         ↓
Step 6: 基于报告实施处置 → P0 修复/回滚、P1 补测试、P2 回归验证、追加历史风险记录
```

三层工具组合分别支撑不同步骤：

```
GitNexus CLI       → Step 1（diff 语义）+ Step 2（单仓调用链）
ast-grep           → Step 2（跨仓调用链广度，Python/PHP/Go 多语言）
grep（HTTP/MQ）    → Step 2（跨仓运行时调用链：HTTP endpoint + MQ topic）
ai_docs 知识库     → Step 0（架构上下文：入口模块、服务拓扑、调用方式）
coverage JSON      → Step 4（测试覆盖检查）
Agent (pi/Claude)  → Step 3 + Step 5（风险推理 + 报告生成）
                   → Step 6（辅助修复代码、生成测试、追加历史风险记录）
```

> **重要修正**：pi agent 不支持 MCP 协议（源码中零实现，无 `--mcp` 参数）。所有外部工具通过 bash 命令行调用，不通过 MCP。Claude Code 可使用 MCP 连接 GitNexus，pi agent 只能通过 bash 调 GitNexus CLI。

---

## 前置条件

### 本地开发环境

```bash
# 1. 所有仓库已克隆到同一根目录
ls /workspace/
# cvm-api  cxm-api  auth-service  ...（57 个仓库）

# 2. 架构知识库
git clone https://git.woa.com/cvm/ai_docs.git /workspace/ai_docs

# 3. 基础工具
python3 --version  # >= 3.8（主要语言）
node --version     # >= 18（工具链）
jq --version       # JSON 处理

# 4. 各工具安装见第一部分
```

### K8s 服务化环境

K8s 部署时，仓库通过 git bare mirror + 持久 worktree 管理，不需要逐个 clone。ai_docs 也作为一个仓库同步。详见第七部分。

### 项目特征

| 特征 | 说明 |
|------|------|
| **语言分布** | Python（~55 仓）为主，1 个 PHP 仓库，少量 Go 仓库 |
| **入口模块** | cvm-api、cxm-api（系统两个主入口，风险等级自动最高） |
| **仓库间调用方式** | Python import（包依赖）+ HTTP（微服务）+ MQ（消息队列） |
| **架构知识源** | ai_docs 仓库（含架构介绍、模块关系、入口说明） |

---

## 工具一览与选型

| 工具 | 类型 | 跨仓 | 安装成本 | Claude Code 集成 | pi agent 集成 | 最适合场景 |
|------|------|------|----------|-----------------|--------------|-----------|
| **GitNexus** | CLI + 知识图谱 | ⚠️ 需分别索引 | 低（npm） | ✅ MCP 原生 | bash 调 CLI | 单仓 diff 影响分析（✅ Python 生产级支持已确认） |
| **ast-grep** | 结构化搜索 | ✅ 直接多目录 | 低（brew/cargo） | Bash 工具 | bash 直接调用 | 跨仓调用点查找（Python/PHP/Go 多语言） |
| **grep（HTTP/MQ）** | 文本搜索 | ✅ | 0（内置） | Bash 工具 | bash 直接调用 | 跨仓 HTTP endpoint + MQ topic 追踪 |
| **ai_docs** | 架构知识库 | ✅ 全局 | 0（git clone） | read 工具 | read 工具 | 服务拓扑、入口模块、架构上下文 |
| **stack-graphs** | 符号引用图 | ✅ 天然跨仓 | 中（Cargo + 建索引） | Bash 工具 | bash 直接调用 | 备选：Python 通配符 re-export（暂不纳入，见 §3） |
| **code-review-graph** | blast-radius | 无 | 低（pip） | ✅ 可选 MCP | bash 调 CLI（可选） | 单仓 blast-radius 二次验证 |

**工具选型决策树**：

```
有 git diff，需要分析完整跨仓调用链
  ↓
第零步：读取 ai_docs 获取架构上下文（入口模块、服务拓扑、调用方式）
  ↓
第一步：GitNexus CLI（已索引仓库的单仓深度分析，含 Python import 链 + __init__.py 解析）
  ↓
第二步：ast-grep（57 仓广度，Python/PHP/Go 多语言，无需预索引）
  注意 K8s 服务化部署时使用两阶段预筛：git grep 粗筛 → ast-grep 精筛（见 §7）
  ↓
第三步：grep 追踪 HTTP/MQ 调用链（ast-grep 捕获不了运行时调用）
  ├── grep -rn "requests\.\|httpx\.\|aiohttp" --include="*.py" → 提取 URL → 匹配路由
  └── grep -rn "publish\|consume\|topic\|queue" --include="*.py" → 匹配生产者/消费者
  ↓
完成（如后续发现通配符 re-export 遗漏率 >15%，评估引入 stack-graphs）
```

---

## 第一部分：工具安装与配置

### 1. GitNexus（推荐）

GitNexus 使用 Tree-sitter 构建代码知识图谱。**每个仓库需要单独建立索引**；建索引后，`impact` 命令可以查询已索引仓库中的调用者关系。

> **Python 支持已确认**：Python 是 GitNexus 4 个"一等公民"语言之一（与 TypeScript/C#/Go 同级），使用最新的 scope-resolution 管线。支持：函数/类/方法符号提取、PEP-328 import 解析、CALLS 调用图、`__init__.py` 包解析、MRO（C3 线性化）。已知限制：`getattr()` 动态分派、`importlib.import_module()` 动态导入无法追踪（与 ast-grep 相同，由 grep HTTP/MQ 通道补充）。

```bash
npm install -g gitnexus

# 对每个仓库建立索引（一次性，后续增量更新）
for repo in /workspace/repo-*; do npx gitnexus analyze $repo; done

# Claude Code：自动配置 MCP
npx gitnexus setup
# → 写入 ~/.claude/settings.json
claude mcp list  # 应该看到 gitnexus 条目

# pi agent：无 MCP，通过 bash 调 CLI
# 在 pi 对话中直接用 bash 工具：
#   npx gitnexus impact verifyToken upstream --json --repo /workspace/repo-001
```

> **GitNexus 的跨仓限制**：`impact` 查询的是**当前仓库的索引**。跨仓调用者需要通过 ast-grep 补充扫描。

**GitNexus 核心命令**：

| 命令 | 用途 | 说明 |
|------|------|------|
| `npx gitnexus detect-changes --diff <patch> --json` | 识别 diff 中的变更符号 | 返回所有符号 |
| `npx gitnexus impact <symbol> upstream --json --repo <path>` | 找调用此函数的上游代码 | 单仓，含文件路径 + 行号 |
| `npx gitnexus impact <symbol> downstream --json --repo <path>` | 找此函数依赖的下游代码 | 返回被调用函数 |
| `npx gitnexus context <symbol> --json --repo <path>` | 360° 查看函数上下文 | 调用者 + 被调用者 + import 链 |

> Claude Code 也可通过 MCP 工具名调用：`detect_changes()`、`impact("verifyToken", "upstream")`、`context("verifyToken")`。

**配置 commit hook 增量更新**（本地开发环境）：

```bash
cat > /workspace/repo-001/.git/hooks/post-commit << 'EOF'
#!/bin/sh
npx gitnexus analyze $(git rev-parse --show-toplevel) --incremental
EOF
chmod +x /workspace/repo-001/.git/hooks/post-commit
```

---

### 2. ast-grep（跨仓搜索，必装）

ast-grep 基于语法树做结构化搜索，能区分函数调用、import 语句和注释中的同名字符串。**可以直接扫描多个目录，无需预索引**，是跨仓广度搜索的主力。

```bash
# macOS
brew install ast-grep

# Cargo（通用，需要 Rust）
cargo install ast-grep

# npm
npm install -g @ast-grep/cli

# 验证
sg --version
```

**常用搜索模式（Python）**：

```bash
# 函数调用（所有仓库）
sg --pattern 'verify_token($$$)' --lang python /workspace/

# 方法调用
sg --pattern '$OBJ.verify_token($$$)' --lang python /workspace/

# import 引用
sg --pattern "from $MOD import verify_token" --lang python /workspace/

# JSON 输出（含文件路径 + 行号，便于分析）
sg --pattern 'verify_token($$$)' --lang python --json /workspace/ \
  | jq '.[] | {file: .file, line: .range.start.line, text: .text}'

# 限制输出数量（大型仓库防止结果爆炸）
sg --pattern 'verify_token($$$)' --lang python --json /workspace/ | jq '.[0:100]'
```

**TypeScript/Go/PHP 示例**（少数仓库）：

```bash
# TypeScript（如有）
sg --pattern 'verifyToken($$$)' --lang ts /workspace/

# Go
sg --pattern 'VerifyToken($$$)' --lang go /workspace/

# PHP
sg --pattern '$$$->verifyToken($$$)' --lang php /workspace/
```

**批量匹配规则文件**（推荐，一次扫描多种调用模式）：

```bash
# Python 版本
cat > /tmp/find-callers.yml << 'EOF'
id: find-callers
language: python
rule:
  any:
    - pattern: verify_token($$$)
    - pattern: $OBJ.verify_token($$$)
    - pattern: "from $MOD import verify_token"
EOF

sg scan --rule /tmp/find-callers.yml --json /workspace/
```

**HTTP/MQ 跨仓调用追踪**（ast-grep 无法捕获运行时调用，用 grep 补充）：

```bash
# HTTP 调用追踪（找谁调了哪个 endpoint）
grep -rn "requests\.\(get\|post\|put\|delete\)" /workspace/ --include="*.py" \
  | grep -i "verify\|auth\|token"

# MQ 消息追踪（找生产者和消费者）
grep -rn "publish\|send_message\|produce" /workspace/ --include="*.py" \
  | grep -i "auth\|token\|verify"
grep -rn "consume\|subscribe\|on_message" /workspace/ --include="*.py" \
  | grep -i "auth\|token\|verify"
```

> **Python 的 re-export 问题**：Python 的 `__init__.py` 充当 barrel 文件（`from .auth import verify_token`）。ast-grep 可以匹配到这些 import 语句，但追踪完整的 `package.__init__ → 最终调用者` 链条时可能需要多步搜索。

**ast-grep 语法速查**：

| 语法 | 含义 |
|------|------|
| `$NAME` | 匹配任意单个节点（捕获变量） |
| `$$$` | 匹配任意多个节点（0 到 N 个参数） |
| `$_` | 匹配任意节点（不捕获） |
| `pattern: 'foo($$$)'` | 函数调用，任意参数 |
| `pattern: '$OBJ.foo($$$)'` | 方法调用 |

---

### 3. stack-graphs（备选方案，暂不纳入）

stack-graphs 是 GitHub 的代码导航引擎，擅长追踪 barrel re-export 链（`export * from './auth'`、Python `__init__.py` 通配符 re-export）。

> **暂不纳入的原因**：
> - Python 支持为实验性（官方主要支持 TypeScript/JavaScript）
> - 构建索引依赖 Rust 工具链 + 语言 grammar，CI/K8s 环境成本高
> - GitNexus 已原生支持 `__init__.py` 包解析（PEP-328 + wildcard-synthesis 阶段）
>
> **重新评估条件**：如果 GitNexus + ast-grep 对 Python `from .submod import *` 通配符 re-export 的追踪遗漏率 > 15%，再评估引入 stack-graphs 或开发轻量级 Python import resolver。

---

### 4. code-review-graph（blast-radius，可选）

功能与 GitNexus 高度重叠，但提供独立的 **blast-radius 风险评分**，可用作第二意见。

```bash
pip install code-review-graph
code-review-graph install --platform claude-code

cd /workspace/repo-001
code-review-graph build
```

**工具**（Claude Code 通过 MCP，pi agent 通过 bash）：

```bash
# blast-radius
code-review-graph impact auth/service.py --json

# 风险评分 + 测试覆盖检查
code-review-graph detect-changes --json
```

---

## 第二部分：完整调用链输出规范

> **此规范定义人类可读的报告格式。API JSON 响应格式见第十二部分，两者内容一一映射。**

**对每个变更符号，必须输出**：

1. 符号位置、变更性质、**diff 语义解读**（`is` 改 `==`？返回类型变化？）和**初始风险等级**
2. **完整调用树**（多级展开，直到找不到更多调用者为止）
   - 每个节点：`仓库名/文件路径:行号  函数名  风险等级  [领域上下文]  测试覆盖`
   - 间接节点注明经由路径（`→ via 文件:行号`）
3. 受影响仓库完整列表 + **未受影响仓库**（57 仓都要列出）
4. **风险优先级排序表**（P0 阻塞合并 / P1 必须修复 / P2 回归即可，从完整调用树中提取，不是过滤条件）
5. 无法静态追踪的场景说明（动态调用等）

**示例输出格式**：

```
变更符号: verify_token  (auth-service/auth/service.py:42, is 改 ==)
diff 语义: 身份比较 → 值比较（None/False/0 等 falsy 值可能绕过检查）
初始风险等级: 🔴 极高（可能绕过身份验证）

调用链树（完整）:
verify_token
├── 直接调用者（第 1 层）
│   ├── cvm-api/views/login.py:18          login_view()       🔴 极高  [公网 API 入口]    ❌ 无测试
│   ├── cxm-api/middleware/auth.py:33      check_auth()       🟡 中    [内部服务]         ✅ 有测试
│   ├── cvm-api/middleware/permission.py:67 auth_middleware()  🔴 高    [鉴权中间件]       ⚠️ 覆盖不全
│   └── shared-lib/utils/validate.py:12    validate_user()    🟡 中    [内部工具]         ✅ 有测试
└── 间接调用者（第 2 层）
    ├── cxm-api/views/instance.py:5        → via cxm-api/middleware/auth.py:33  🟡 中     ✅ 有测试
    └── payment-service/handler.py:91      → via cvm-api/middleware/permission.py:67
                                                                        🔴 极高 [支付流程] ❌ 无测试
    (HTTP 运行时调用) billing-php/api/charge.php:20  → payment-service 通过 HTTP 调用
                                                                        🔴 高 [计费接口]   ⚠️ 覆盖不全

受影响仓库: auth-service, cvm-api, cxm-api, shared-lib, payment-service, billing-php（共 6/57）
未受影响仓库: 其余 51 个仓库

风险优先级排序（需要立即处理的在前）:
| 优先级 | 位置                             | 经由                              | 风险等级 | 测试覆盖 | 处置建议           |
|--------|----------------------------------|-----------------------------------|----------|----------|--------------------|
| 🔴 P0  | payment-service/handler.py:91    | cvm-api/middleware/permission.py  | 极高     | ❌ 无    | 阻塞合并，补测试 + QA |
| 🔴 P0  | cvm-api/views/login.py:18        | 直接                              | 极高     | ❌ 无    | 阻塞合并，人工 review |
| 🔴 P1  | cvm-api/middleware/permission.py | 直接                              | 高       | ⚠️ 部分  | 补测试后回归       |
| 🟡 P2  | cxm-api/middleware/auth.py:33    | 直接                              | 中       | ✅ 有    | 回归测试通过则 OK  |
| 🟡 P2  | shared-lib/utils/validate.py:12  | 直接                              | 中       | ✅ 有    | 回归测试通过则 OK  |

无法静态追踪:
- 动态调用 getattr(obj, method_name)() 在 cxm-api/utils/dispatch.py 中存在
- RabbitMQ consumer 通过 routing_key 模式匹配（auth.token.*），可能有未列出的消费者
```

### 多级展开的机械化步骤

第 2 层（间接调用者）需要对第 1 层的每个结果再做一次搜索：

```bash
# 第 1 层：找 verify_token 的直接调用者
sg --pattern 'verify_token($$$)' --lang python --json /workspace/ \
  | jq -r '.[].file' | sort -u
# 输出：cvm-api/views/login.py, cxm-api/middleware/auth.py ...

# 第 2 层：找 check_auth 的调用者（限定在源仓库目录内防误匹配）
sg --pattern 'check_auth($$$)' --lang python --json /workspace/cxm-api/ \
  | jq '.[] | {file: .file, line: .range.start.line}'
# 输出：cxm-api/views/instance.py:5

# 第 2 层：找 auth_middleware 的调用者
sg --pattern 'auth_middleware($$$)' --lang python --json /workspace/ \
  | jq '.[] | {file: .file, line: .range.start.line}'
# 输出：payment-service/handler.py:91
```

Agent 会自动对第 1 层结果中提取到的函数名执行第 2 层搜索，无需手动操作。

**高风险判定标准**（Python）：
- 身份验证、权限、支付、数据写入模块
- 身份比较变更（`is` → `==`、`is not` → `!=`）
- 返回类型变化（`Optional[T]` 去掉 `Optional`、添加 `None` 返回路径）
- 异常处理删除或范围缩小（`except Exception` → `except ValueError`）
- `async` 函数改为 `sync`（阻塞 event loop）
- `__init__` 参数变更（所有实例化点受影响）
- 超时 / 重试逻辑变更
- 加密 / 哈希算法变更

**风险节点的测试覆盖标注**：

| 标注 | 含义 | 处置方式 |
|------|------|----------|
| ✅ 有测试 | 该调用点有对应单元/集成测试 | 跑回归，测试通过则风险可接受 |
| ⚠️ 覆盖不全 | 有测试但覆盖率 < 80% 或边界未测 | 补测试后再回归 |
| ❌ 无测试 | 完全没有测试覆盖 | 阻塞合并，人工 review 或先补测试 |

---

## 第三部分：Claude Code 模式（本地开发参考）

> **注意**：本部分适用于开发者本地交互式分析。K8s 服务化部署使用 pi RPC 模式（见第七部分），不使用 Claude Code。

### 挂载多仓

```bash
cd /workspace/auth-service
claude \
  --add-dir /workspace/cvm-api \
  --add-dir /workspace/cxm-api \
  # ... 按需挂载
```

### 分析流程

Claude Code 在 MCP 工具（GitNexus）和 Bash 工具（ast-grep）之间自动编排：

1. **`detect_changes()`** — 识别 diff 中所有变更符号
2. **`impact("符号", "upstream")`** + **Bash: `sg scan`** — 单仓深度 + 跨仓广度
3. **Bash: 第 2 层扫描** — 构建间接调用树
4. **风险传播** — 结合 CLAUDE.md 元信息标注风险等级 + 测试覆盖

提示词模板与 pi agent 模式相同（见第四部分），将 `sg scan` 替换为 MCP `impact()` 调用即可。

---

## 第四部分：pi agent 模式

pi agent 是一个极简 AI 编码代理，支持 300+ 模型、完整实现 [Agent Skills 标准](https://agentskills.io/specification)，适合批量 CI 自动化和跨仓编排场景。与 Claude Code 相比，pi agent 的核心优势是：**工作目录没有预声明限制**（无需 `--add-dir`），可以在会话中自由 `cd` 到任意仓库，更适合脚本化 CI 流程和 K8s 服务化部署。

> **重要**：pi agent **不支持 MCP 协议**（源码中零实现，无 `--mcp` 参数）。所有外部工具通过 bash 命令行调用。

### pi agent 能力

| 能力 | 说明 |
|------|------|
| **7 个内置工具** | read, bash, edit, write, grep, find, ls |
| **Skills 系统** | 完整实现 Agent Skills 标准，支持 `/skill:name` 命令 |
| **AGENTS.md 加载** | 原生加载 cwd 及祖先目录的 AGENTS.md / CLAUDE.md |
| **RPC 模式** | stdin/stdout JSON 协议，适合作为 K8s 服务子进程 |
| **Print 模式** | 单次执行，`pi -p "prompt"` 输出结果退出 |
| **Extension 系统** | 可通过 `pi.registerTool()` 注册自定义工具 |
| **Subagent 扩展** | 可 spawn 独立 pi 子进程并行分析 |

### 安装 pi agent

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version
```

### pi agent + GitNexus CLI

pi agent 通过 Bash 工具调用 GitNexus CLI（不通过 MCP）：

```bash
# Step 1: 确保各仓库已建立 GitNexus 索引（同第一部分）
for repo in /workspace/repo-*; do npx gitnexus analyze $repo; done

# Step 2: 在 pi 对话中直接用 bash 工具调用
# （无需启动 MCP 服务）
```

在 pi agent 对话中通过 bash 工具调用：

```bash
# 单仓深度分析
npx gitnexus impact verifyToken upstream --json --repo /workspace/repo-001

# diff 变更检测
npx gitnexus detect-changes --diff /tmp/pr.patch --json --repo /workspace/repo-001
```

**GitNexus CLI 覆盖深度（单仓），Bash 工具覆盖广度（跨仓）**：

```bash
# pi 用 bash 跨仓扫描（57 仓广度）
for repo in /workspace/*/; do
  echo "=== $(basename $repo) ===" && \
  sg --pattern 'verify_token($$$)' --lang python --json "$repo" \
    | jq '.[] | "\(.range.start.line): \(.text)"'
done
```

### pi agent + ast-grep 跨仓扫描

```bash
# 动态生成规则文件（Python）
cat > /tmp/impact.yml << 'EOF'
id: impact-scan
language: python
rule:
  any:
    - pattern: verify_token($$$)
    - pattern: $OBJ.verify_token($$$)
    - pattern: "from $MOD import verify_token"
EOF

# 全仓扫描，按文件分组输出（控制上下文量）
sg scan --rule /tmp/impact.yml --json /workspace/ \
  | jq -r 'group_by(.file) | .[] |
      "=== \(.[0].file) ===\n" +
      (.[] | "  行\(.range.start.line): \(.text)")'

# 如果结果太多（> 200 条），先按仓库过滤
sg scan --rule /tmp/impact.yml --json /workspace/cvm-api/ \
  | jq 'length'  # 先检查数量
```

> **大输出量处理策略**：57 仓扫描结果可能超过几百行，建议分仓运行，或先用 `jq 'length'` 检查每仓结果数量，重点仓库先分析。

### Skill 封装

整个分析流程封装为 pi Skill，通过 `/skill:cross-repo-analysis` 触发：

```
.pi/skills/cross-repo-analysis/
├── SKILL.md                     # 5 步分析协议
├── scripts/
│   ├── scan-callers.sh          # ast-grep 多仓扫描封装
│   ├── check-coverage.sh        # 测试覆盖检查封装
│   └── build-ast-grep-rule.sh   # 动态生成 ast-grep 规则
└── references/
    └── risk-rules.md            # 风险判定规则
```

### AGENTS.md 配置

pi agent 自动读取工作目录及祖先目录的 `AGENTS.md`（也兼容 `CLAUDE.md`）。

**/workspace/AGENTS.md**（全局协议，写入一次，所有分析会话自动读取）：

```markdown
# 多仓影响分析协议

## 目录结构
所有仓库位于 /workspace/（Python 为主，含少量 PHP 和 Go）
入口模块：cvm-api, cxm-api（风险等级自动最高）

## 分析步骤（严格按顺序执行）

### Step 0：加载分析上下文（自动，分析服务层执行，零 LLM 成本）
- 读取变更仓库的 AGENTS.md（完整版）
- 读取 GLOBAL_PATTERNS.md（历史高频跨仓风险传播路径）
- 读取命中仓库的 AGENTS.md（由两阶段预筛确定）
- 读取热区风险历史（最近 30 天明细）
- 注意：此步骤由分析服务代码执行，不消耗 LLM token

### Step 1：解读 diff 语义，判断初始风险
- 提取**所有**变更符号（不只是高风险的）
- 对每个变更判断类型，给出初始风险等级：
  - `is` 改 `==` → 🔴 极高（身份比较→值比较，None/False 可能绕过）
  - 返回类型变化（去掉 Optional、新增 None 返回路径）→ 🔴 高
  - 异常处理删除或范围缩小 → 🔴 高（错误向上传播）
  - `async` 改 `sync` → 🟡 中（阻塞 event loop）
  - 超时值变更 → 🟡 中（级联等待）
  - 注释/格式 → 🟢 低（无运行时影响）

### Step 2：构建完整跨仓调用链
对每个符号执行搜索：
a. npx gitnexus impact "<符号>" upstream --json --repo <repo-path>
b. 生成 /tmp/impact-<符号>.yml 规则文件（Python 语法），运行：
   sg scan --rule /tmp/impact-<符号>.yml --json /workspace/
   （先检查数量：jq 'length'，超过 200 条则分仓运行）
c. grep 追踪 HTTP/MQ 运行时调用（ast-grep 无法捕获的）

对第 1 层结果中的调用函数，重复步骤 b 获取第 2 层（间接调用者）

### Step 3：在调用链上传播风险（含动态验证）

对每个调用点执行分层分析：

**第 1 轮（默认 3 行上下文）**：
- 读取调用点 ±3 行代码
- LLM 判断领域上下文（公网 API > 鉴权层 > 支付 > 内部工具）+ 风险等级 + 置信度
- 参考当前仓库 AGENTS.md 中标注的高风险目录
- 间接调用者继承直接调用者的风险，叠加自身上下文

**条件追加（置信度 < 0.8 时自动触发，仅 accuracy_first 模式）**：
- 扩展为 ±50 行上下文
- 重新判断（第 2 轮）

**交叉验证（第 2 轮仍 < 0.8 时）**：
- 独立 prompt 做第二意见
- 两次判断一致 → 置信度 +0.15
- 不一致 → 取更高风险，标注"分歧"

**最终兜底**：
- 3 轮验证后仍 < 0.7 → 标记为 NEEDS_HUMAN_REVIEW
- 报告中注明"AI 置信度仅 X%，建议人工确认"

> 详细算法实现见 `cross-repo-9-point-analysis.md` §20 AccuracyFirstAnalyzer。

### Step 4：检查测试覆盖
- 优先读取 coverage/coverage-summary.json
- fallback：检查测试文件存在性（*.test.* / *.spec.*）
- 标注：✅ 有测试 / ⚠️ 覆盖不全 / ❌ 无测试

### Step 5：输出报告
见"输出规范"

## 输出规范
1. 每个变更符号的完整调用链树（多级展开，所有 57 个仓库）
   - 每个节点：仓库/文件:行号  函数名  风险等级  测试覆盖
2. 受影响仓库完整列表 + 未受影响仓库（57 仓都列出）
3. 风险优先级排序表（P0/P1/P2/P3，优先级高的在前）
4. 无法静态追踪的说明（动态调用 obj[method]() 等）

## 高风险目录（通用）
- */auth/*, */payment/*, */security/* — 认证/支付/安全
- 对外 API 入口（*/api/*, */routes/*）

## 优先级定义
| 优先级 | 条件 | 处置 |
|--------|------|------|
| P0 阻塞 | 风险🔴 且 ❌ 无测试 | 必须在合并前解决 |
| P1 必修 | 风险🔴 且 ⚠️ 覆盖不全 | 补测试后回归 |
| P2 回归 | 风险🔴 且 ✅ 有测试 / 风险🟡 | 回归测试通过则可合并 |
| P3 观察 | 风险🟢 | 无需特殊处置 |
```

**/workspace/auth-service/AGENTS.md**（仓库专属规则）：

```markdown
# auth-service 专属规则
高风险目录: auth/, token/
对外 API 目录: api/   # 被其他服务 HTTP 调用
忽略目录: __pycache__/, .venv/, dist/
忽略文件: *_test.py, test_*.py, conftest.py
主要语言: Python
```

### 提示词模板（pi agent 模式）

```
我有以下 diff，请执行完整的多仓影响分析（调用链 + 风险分析）：

=== repo-001 diff ===
<粘贴 diff 内容>

=== repo-002 diff ===
<粘贴 diff 内容>

按 AGENTS.md 协议执行，5 步流程：

Step 1：解读 diff 语义
- 提取**所有**变更符号（函数名、类名、常量名等）
- 判断每个变更的类型（is→==？返回类型变化？异常处理删除？async→sync？）
- 给出初始风险等级 🔴/🟡/🟢

Step 2：构建完整跨仓调用链
- 运行 npx gitnexus impact 获取已索引仓库的调用者（第 1 层，单仓深度）
- 生成 ast-grep 规则文件（Python 语法），扫描全部 /workspace/（第 1 层，跨仓广度）
- grep 追踪 HTTP/MQ 运行时调用（读取 AGENTS.md 中的框架模式和 routing_key）
- 对第 1 层每个调用函数名再次扫描（第 2 层，间接调用者）

Step 3：传播风险
- 对每个调用点：读取周围代码，判断领域上下文（公网？支付？内部？）
- 结合初始风险 × 调用点上下文 = 该节点最终风险等级
- 间接调用者继承直接调用者的风险并叠加自身

Step 4：检查测试覆盖
- 对 🔴 高风险节点：优先读 coverage JSON，fallback 检查测试文件
- 标注 ✅ 有测试 / ⚠️ 覆盖不全 / ❌ 无测试

Step 5：输出报告
- a. 每个变更符号的完整调用链树（多级，所有 57 个仓库，含风险等级 + 测试覆盖）
- b. 受影响 / 未受影响仓库列表（57 仓都列出）
- c. 风险优先级排序表（P0 阻塞合并 / P1 必须修复 / P2 回归即可）
- d. 无法静态追踪的场景说明（动态调用等）
```

### pi agent CI 自动化（批处理模式）

pi agent 支持非交互式批处理，完整 CI workflow 见第六部分「CI 自动化」。

---

## 第五部分：两种模式对比

| 维度 | Claude Code 模式 | pi agent 模式 |
|------|-----------------|---------------|
| GitNexus | ✅ MCP 原生 | bash 调 CLI |
| 跨仓访问方式 | `--add-dir` 预声明（启动时固定） | bash `cd` 无限制，随时切换 |
| ast-grep / stack-graphs | ✅ Bash 工具 | ✅ bash 直接调用 |
| 完整调用链输出 | ✅（提示词驱动） | ✅（提示词驱动） |
| 多级展开（2-3 层） | ✅ | ✅ |
| 并行能力 | Task 子任务工具 | subagent 扩展 / shell 循环 |
| 协议版本化 | CLAUDE.md | AGENTS.md（兼容 CLAUDE.md） |
| 多模型支持 | 固定 Claude | ✅ 300+ 模型 |
| Skills 系统 | ✅ 内置 | ✅ Agent Skills 标准 |
| 非交互 / CI 模式 | 有限（需脚本包装） | ✅ `-p` print 模式 / `--mode rpc` |
| K8s 服务化 | 需自行包装 | ✅ RPC 模式原生支持 |
| 最适合 | 交互式深度分析 | 批量 CI 自动化 + K8s 服务化 + 跨仓编排 |

---

## 第六部分：基于风险报告的处置与改进

分析完成后，你手上有一份风险优先级排序报告。本部分说明如何将报告转化为具体行动——从 P0 阻塞修复到 P2 回归验证，以及如何用 Claude Code / pi agent 辅助实施。

---

### 处置优先级总览

| 优先级 | 触发条件 | 目标 | 时限 |
|--------|----------|------|------|
| **P0 阻塞合并** | 风险 🔴 且 ❌ 无测试 | 阻止 PR 合并，强制处置 | 合并前必须解决 |
| **P1 必须修复** | 风险 🔴 且 ⚠️ 覆盖不全 | 补测试后回归 | 当次迭代内 |
| **P2 回归验证** | 风险 🔴 且 ✅ 有测试，或风险 🟡 | 跑回归测试 | 发布前 |
| **P3 观察** | 风险 🟢 | 无需特殊处置 | — |

---

### P0：阻塞合并 — 立即修复

**场景**：高风险变更（如 `is` → `==`）传播到了一个没有任何测试覆盖的调用点。

**Step 1：确认问题根因**

```
读取 cvm-api/views/login.py:18 的 login_view() 函数。

判断此处调用 verify_token 时的风险：
1. 如果 verify_token 的 is 改 == 在这里是误改（不应该改），应该回滚原始符号
2. 如果改动本身是合理的（新需求），则需要评估 login_view() 是否需要适配并补测试
```

**Step 2a：如果是误改 — 回滚变更**

```bash
git -C /workspace/auth-service diff HEAD auth/service.py
git -C /workspace/auth-service checkout HEAD -- auth/service.py
```

**Step 2b：如果是合理改动 — 补充防御性代码**

```
auth-service/auth/service.py 第42行把 is 改成了 ==（已确认是合理需求）。

请在以下 P0 调用点补充防御性代码：
- cvm-api/views/login.py:18  login_view()：在调用 verify_token 前加类型检查
- payment-service/handler.py:91  process_payment()：加入 isinstance 断言

要求：
- 不改变函数签名
- 加 docstring/注释说明为什么需要类型守卫
- 修改要最小化，不引入新的依赖
```

**Step 3：补充测试**

```
为 cvm-api/views/login.py 的 login_view() 函数补充测试用例。

背景：调用链上游的 verify_token 从 is 改为 ==，需要确保以下场景有测试：
1. 正常登录（str 类型 token）
2. None token 不能通过验证（原 is 比较保证 None 被拒绝）
3. 空字符串 "" 不能作为有效 token
4. 数字 0 / False 不能绕过验证（== 的 falsy 值风险）

使用 pytest，测试文件路径遵循项目的 test_*.py 命名规范。
```

**Step 4：验证修复**

```bash
for repo in cvm-api payment-service; do
  echo "=== $repo ===" && cd /workspace/$repo && pytest -k "auth or login or payment" -v
done
```

---

### P1：必须修复 — 补测试后回归

**Step 1：定位覆盖缺口**

```
查看 cvm-api/middleware/permission.py 的 auth_middleware() 函数的现有测试文件。
分析当前测试覆盖了哪些场景，还缺少哪些边界条件的测试。
```

**Step 2：补充边界测试用例**

```
在 cvm-api/tests/test_permission.py 中补充以下覆盖缺口：

已有测试：正常 token 验证通过、无 token 返回 401
需要补充：
1. 类型边界：verify_token 返回 False/0/None 时 middleware 的行为
2. 空 dict {} 作为 token 参数时的防御
3. auth_middleware 在调用链下游（payment-service）的集成测试
```

**Step 3：回归验证**

```bash
cd /workspace/cvm-api
pytest --cov=middleware tests/test_permission.py -v
pytest -k "payment or auth_middleware"
```

---

### P2：回归验证 — 跑测试即可

```bash
for repo in cxm-api shared-lib; do
  echo "=== 测试 $repo ==="
  cd /workspace/$repo && pytest -v 2>&1 | tail -10
done
```

如果某个 P2 节点的测试失败，升级为 P1 处理。

---

### 改进闭环

**代码层面的预防**（在风险点添加 lint/type 规则）：

```bash
# 在受影响仓库中启用 mypy strict 模式（防止隐式 None 返回）
# pyproject.toml
[tool.mypy]
strict = true
disallow_untyped_defs = true

# 或用 ruff 规则禁止裸 == None（应该用 is None）
[tool.ruff.lint]
select = ["E711"]  # comparison to None
```

**架构层面的改进**：

```
分析本次 verify_token 的调用链，判断是否有架构改进机会：

1. 如果 verify_token 被多个仓库直接调用（紧耦合），建议：
   - 把验证逻辑封装成 validate_token_strict(token: str) -> bool
   - 调用方改为调用更明确的接口，防止实现细节泄漏

2. 如果调用链跨越了不应该耦合的模块边界，建议：
   - 在 AGENTS.md 中记录模块边界规则
   - 后续分析时将跨越边界的调用标记为额外风险
```

### CI 自动化：从分析到处置的全流程

```yaml
# .github/workflows/cross-repo-impact-full.yml
name: Impact Analysis + Remediation Guide
on:
  pull_request:
    paths: ['src/auth/**', 'src/shared/**']

jobs:
  analyze-and-guide:
    runs-on: ubuntu-latest
    steps:
      - name: Setup & Index
        run: |
          npm install -g gitnexus @earendil-works/pi-coding-agent @ast-grep/cli
          for repo in /workspace/repo-*; do
            npx gitnexus analyze $repo
          done

      - name: Full Impact Analysis
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          git diff origin/main...HEAD > /tmp/pr.patch

          cd /workspace
          pi -p << 'EOF'
          分析 /tmp/pr.patch，按 AGENTS.md 协议执行完整 5 步分析，
          然后执行第六步：对每个 P0 和 P1 节点，生成具体的处置建议：
          - P0：给出回滚命令 或 防御性代码示例 + 需要补充的测试用例
          - P1：给出需要补充的测试边界场景清单
          - P2：给出需要运行的测试命令
          将完整报告（分析 + 处置建议）写入 /tmp/impact-report.md
          EOF

      - name: Post to PR
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs')
            const report = fs.readFileSync('/tmp/impact-report.md', 'utf8')
            const hasP0 = report.includes('🔴 P0')
            const body = hasP0
              ? `## ⛔ 影响分析：发现 P0 阻塞项\n\n${report}`
              : `## ✅ 影响分析：无阻塞项\n\n${report}`
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body
            })
            if (hasP0) {
              core.setFailed('存在 P0 风险节点，请在合并前处置')
            }
```

---

## 各工具漏报场景对比

| 场景 | GitNexus | ast-grep | grep HTTP/MQ |
|------|----------|----------|--------------|
| 直接函数调用 `foo()` | ✅ | ✅ | — |
| 方法调用 `obj.foo()` | ✅ | ✅ | — |
| `from mod import foo` | ✅ | ✅ | — |
| `__init__.py` re-export（`from .auth import verify_token`） | ⚠️ | ⚠️ 需多步搜索 | — |
| 动态调用 `getattr(obj, name)()` | ❌ | ❌ | ❌ |
| HTTP 微服务调用（框架封装） | ❌ | ❌ | ✅ 匹配 URL/service_name |
| RabbitMQ 消息（pika publish/consume） | ❌ | ❌ | ✅ 匹配 routing_key |
| 条件 import `importlib.import_module()` | ⚠️ | ⚠️ | — |
| 跨仓引用（57 个仓库） | ⚠️ 需分别索引 | ✅ 直接多目录 | ✅ 直接多目录 |

> **动态调用**（`getattr(obj, name)()`、`eval()`、`exec()`）无论何种工具都无法静态追踪，需要人工检索符号字符串。
> **HTTP/MQ 调用**是本项目跨仓追踪的关键补充——ast-grep 只能追踪 import 级依赖，运行时调用必须依赖 grep + AGENTS.md 中记录的框架模式和 routing_key。

---

## 第七部分：K8s 服务化部署

### 系统架构

```
┌───────────────────────────────────────────────────────────────────┐
│                          K8s Cluster                              │
│                                                                   │
│  ┌──────────┐    ┌──────────────┐    ┌────────────────────────┐   │
│  │  API 网关  │──▶│  分析服务 (主) │──▶│  pi (RPC 模式, 子进程)  │   │
│  │ REST/gRPC │    │  Node.js     │    │  bash/read/edit/write  │   │
│  └──────────┘    └──────────────┘    │  grep/find/ls + Skills │   │
│       │                │              └────────────────────────┘   │
│       │          ┌─────────────┐                                  │
│       │          │  索引服务    │  ← 常驻, 每 10 分钟轮询          │
│       │          │  AGENTS.md  │  ← 每周一次 LLM 语义层刷新       │
│       │          │  风险记录压缩│  ← 定时做梦/归档                  │
│       │          └─────────────┘                                  │
│       │                │                                          │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │                  共享存储 (PVC / SSD)                       │   │
│  │  /repos/bare/repo-001.git ... repo-057.git (git bare)      │   │
│  │  /worktrees/persistent/repo-001/ ... repo-057/ (索引服务用) │   │
│  │  /worktrees/tasks/{task-id}/{repo}/ (分析任务临时,用完即删) │   │
│  │  /index/agents-md/repo-001.md ... repo-057.md              │   │
│  │  /index/risk-history/repo-001.md ... repo-057.md           │   │
│  │  /index/meta.json                                          │   │
│  └────────────────────────────────────────────────────────────┘   │
│                                                                   │
│  ┌──────────────────┐                                             │
│  │  仓库同步 CronJob │  ← 每 10 分钟 git fetch --all             │
│  └──────────────────┘                                             │
└───────────────────────────────────────────────────────────────────┘
```

### 仓库存储：git bare mirror + 双模式 worktree

> **设计决策**（统一 9-point §19 D6）：同时维护两种 worktree，用途分离。

| 类型 | 路径 | 用途 | 生命周期 |
|------|------|------|---------|
| **持久 worktree** | `/worktrees/persistent/{repo}/` | 索引服务做确定性脚本扫描（目录结构、导出模块） | 常驻，每 10 分钟 `git checkout --detach origin/main`（~50ms/仓） |
| **临时 worktree** | `/worktrees/tasks/{task-id}/{repo}/` | 分析特定分支/commit 的代码 | 分析完成后立即删除 |

持久 worktree 避免索引服务每次重建；临时 worktree 保证并发分析任务隔离（同一仓库可同时有多个 task 的 worktree，`--detach` 避免 branch name 冲突）。

57 个仓库用 git bare mirror + 定时同步（不每次 clone）：

```yaml
# CronJob: 每 10 分钟同步所有仓库
apiVersion: batch/v1
kind: CronJob
metadata:
  name: repo-sync
spec:
  schedule: "*/10 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          volumes:
            - name: repos
              persistentVolumeClaim:
                claimName: repos-pvc
          containers:
            - name: sync
              image: alpine/git:latest
              volumeMounts:
                - name: repos
                  mountPath: /repos
              command: ["/bin/sh", "-c"]
              args:
                - |
                  while IFS='|' read -r name url; do
                    if [ -d "/repos/$name" ]; then
                      git -C "/repos/$name" fetch --all --prune
                    else
                      git clone --mirror "$url" "/repos/$name"
                    fi
                  done < /config/repos.txt
```

索引服务维护一组持久 worktree（不每次创建/删除），每轮扫描只 `git checkout --detach` 到最新 HEAD（~50ms/仓）。分析分支时按需创建临时 worktree：

```bash
# 分析分支 feature-x
git -C /repos/repo-001 worktree add /tmp/analysis-xxx/repo-001 feature-x
# 分析完毕后清理
git -C /repos/repo-001 worktree remove /tmp/analysis-xxx/repo-001
```

### 分析服务 + pi RPC

pi 的 RPC 模式（stdin/stdout JSON 协议）作为子进程被分析服务包裹：

```
用户 HTTP 请求
     │
     ├── 1. 解析请求（哪些仓库、哪个分支、diff 内容）
     ├── 2. 创建临时 worktree（目标分支）
     ├── 3. 组装 AGENTS.md 上下文（从 /index/agents-md/ 读取）
     ├── 4. spawn pi --mode rpc --provider <provider> --model <model>
     ├── 5. 通过 stdin 发送 prompt（分析指令 + diff）
     ├── 6. 从 stdout 读取 agent_event 流
     ├── 7. 等待 agent_end 事件
     ├── 8. 提取最终报告 + 追加历史风险记录
     ├── 9. 清理 worktree
     └── 10. 返回报告给用户
```

### 错误处理与降级策略

| 故障场景 | 检测方式 | 降级策略 |
|---------|---------|---------|
| **pi RPC 子进程超时** | 10 分钟无 agent_event | 杀进程，返回部分结果（已完成的 Step）+ 超时提示 |
| **pi RPC 子进程崩溃** | 进程 exit code != 0 | 重试 1 次（可能是 OOM），仍失败则返回错误 |
| **LLM API 限流/不可用** | pi 返回 error event | 排队等待（指数退避），3 次失败后降级为纯 ast-grep 扫描（无风险推理） |
| **ast-grep 扫描超时** | 单仓超过 30s | 跳过该仓库，标记为"未扫描"在报告中注明 |
| **某个仓库 git fetch 失败** | fetch 返回非零 | 跳过该仓库，使用上次成功的 worktree 快照 |
| **AGENTS.md 不存在** | 文件不存在 | agent 实时扫描目录结构代替，消耗更多 token 但结果不受影响 |
| **ai_docs 仓库不可用** | clone/fetch 失败 | 使用缓存版本，报告中标注"架构知识可能过期" |

### 并行分析编排（多符号 diff 加速）

当 diff 包含多个独立变更符号时，分析服务层充当 Coordinator 进行并行编排：

```
用户提交 diff（含 N 个变更符号）
     │
     ▼
分析服务（Coordinator 层，Node.js）
     │
     ├── 1. 两阶段预筛（零 LLM 成本，统一 9-point §15 D2 设计）：
     │   ├── 解析 diff → 提取 N 个符号
     │   ├── Phase 1: git grep on bare repos（无需 worktree）
     │   │   覆盖 5 层：直接符号名 + HTTP endpoint + MQ topic + 配置引用 + 反向依赖
     │   │   → 粗筛命中仓库集（57 仓 → ~15-20 仓）
     │   ├── Phase 2: 仅对粗筛命中仓库创建临时 worktree → ast-grep 精筛
     │   │   → 精确命中仓库 + 调用点列表（~15-20 仓 → ~5-10 仓）
     │   ├── 加载相关 AGENTS.md（只加载精筛命中仓库的）
     │   └── 读取 GLOBAL_PATTERNS.md（历史风险路径）
     │
     ├── 2. 任务分割 + 并行 spawn：
     │   ├── pi-worker-1: 分析 symbol_A（Step 1+3 风险推理）
     │   ├── pi-worker-2: 分析 symbol_B（Step 1+3 风险推理）
     │   ├── pi-worker-3: 分析 symbol_C+D（相关符号合并到同一 worker）
     │   └── pi-worker-4: 分析 symbol_E
     │   每个 worker 收到精简 prompt：该符号的预筛结果 + 相关 AGENTS.md
     │
     ├── 3. 结果收集（等待所有 worker 完成 或 单 worker 超时）
     │
     ├── 4. 确定性合并（Node.js 代码逻辑，不消耗 LLM token）：
     │   ├── 合并调用链（多符号可能影响同一仓库 → 集合并集）
     │   ├── 风险叠加（同一文件被多条链命中 → 风险上升）
     │   └── 去重（不同符号找到同一个调用者 → 合并为一条）
     │
     └── 5. spawn pi-reporter: 基于合并后的结构化数据生成最终报告
          （reporter 不需要重新分析，只负责格式化 + 测试计划生成）
```

**关键原则（借鉴 Claude Code Coordinator Mode）**：
- **Synthesis 不可委托**：合并逻辑在分析服务层确定性代码中执行，不让 LLM "理解并总结"多个 worker 的结果
- **预筛是免费的**：ast-grep 扫描在 Node.js 层运行，零 LLM 成本，结果精确
- **Worker 收到精简输入**：不给 worker 57 仓全量数据，只给它负责的符号 + 命中的 5-10 仓

**性能对比**：

| diff 规模 | 串行（单 pi 进程） | 并行（N worker） | 加速比 |
|-----------|------------------|-----------------|--------|
| 1 个符号 | ~2 min | ~2 min | 1x |
| 5 个独立符号 | ~10 min | ~3 min | 3x |
| 20+ 符号（大重构） | ~30 min | ~8 min | 4x |

**何时启用并行**：
- diff 中变更符号 >= 3 个 → 启用并行
- diff 中变更符号 < 3 个 → 单 pi 进程串行（减少编排开销）

### 成本追踪

每次分析任务独立追踪 token 消耗和成本（**权威接口定义，9-point §2 为早期草案**）：

```typescript
interface AnalysisCost {
  task_id: string;
  project: string;
  costs_by_step: {
    pre_filter: {
      duration_ms: number;
      repos_hit: number;               // git grep 粗筛命中仓库数
    };  // 零 LLM 成本
    workers: Array<{
      worker_id: string;
      symbols: string[];               // 该 worker 负责的符号
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;       // 衡量 prompt cache 效果
      model: string;
      cost_usd: number;
      verification_rounds: number;     // 追加验证轮次
    }>;
    merge: { duration_ms: number };    // 确定性合并，零 LLM 成本
    reporter: {
      input_tokens: number;
      output_tokens: number;
      model: string;
      cost_usd: number;
    };
  };
  total_cost_usd: number;
  total_duration_ms: number;
}
```

分析服务暴露 Prometheus metrics（K8s 生态标配）：
- `analysis_cost_usd{project, model}` — 按项目和模型分拆
- `analysis_duration_seconds{project, step}` — 按步骤分拆
- `analysis_cache_hit_rate{project}` — 衡量 prompt cache 效果

### 成本优化策略

| 策略 | 实现层 | 预期节省 |
|------|--------|---------|
| **ast-grep 预筛**（最重要） | 分析服务层 | 50%+（57 仓 → 5-10 仓） |
| **按需加载 AGENTS.md** | 分析服务层 | 40-60%（只加载命中仓库） |
| **并行 worker 精简 prompt** | 分析服务层 | 20-30%（每个 worker 只看自己的符号） |
| **Thinking 分级** | pi 配置 | 10-20%（报告生成不用深度推理） |
| **Diminishing Returns 检测** | pi Skill | 10%（第 3 层展开无收益时停止） |

### 性能与可用性要求（SLA）

| 指标 | 目标值 | 测量方式 | 备注 |
|------|--------|---------|------|
| 单符号分析延迟 (P50) | ≤ 2 min | 从 API 提交到结果返回 | 含 worktree 创建 + LLM 推理 |
| 单符号分析延迟 (P95) | ≤ 5 min | 含重试和降级场景 | 含一次 model fallback |
| 多符号并行 (≤5) 延迟 (P95) | ≤ 8 min | Coordinator 模式 | 受 LLM RPM 约束 |
| 系统可用性 | 99.5% | 月度计算，排除计划维护 | 含 LLM 降级模式 |
| 任务丢失率 | 0% | 提交的任务必须有最终状态 | 超时也算"完成（部分结果）" |
| 降级模式可用性 | 99.9% | 纯 ast-grep 扫描（无 LLM） | LLM 全挂时的兜底 |

**超时与降级阶梯**：

| 阶段 | 超时 | 动作 | 输出 |
|------|------|------|------|
| ast-grep 单仓 | 30s | 跳过该仓库 | 报告中标注"未扫描" |
| pi 单 worker | 10 min | 杀进程，收集已有 Step 结果 | 返回部分结果 |
| 全分析任务 | 15 min | 杀所有 worker | 返回所有已完成 Step |
| LLM 连续失败 3 次 | — | 触发 Circuit Breaker | 降级为 ast-grep only |
| LLM 连续失败恢复 | 30 min cooldown | 尝试恢复到正常模式 | 自动探测 |

**SLA 不覆盖的场景**：
- 初次部署的 57 仓 clone（一次性，不属于分析延迟）
- 每周语义层刷新（后台 CronJob，不影响用户请求）
- AGENTS.md 冷启动审核（人工流程，7 天）

### 资源需求与容量规划

**分析服务 Pod**：

| 资源 | requests | limits | 峰值场景 |
|------|----------|--------|---------|
| CPU | 2 core | 4 core | 并行 4 worker spawn + ast-grep |
| 内存 | 2 GB | 4 GB | pi RPC 子进程 × 4 + JSON 解析 |
| 磁盘 (临时 worktree) | — | 20 GB (emptyDir) | 5 并发任务 × 4 仓 worktree |

**索引服务 Pod**：

| 资源 | requests | limits | 说明 |
|------|----------|--------|------|
| CPU | 0.5 core | 1 core | 10 min 轮询 + 周语义层刷新 |
| 内存 | 512 MB | 1 GB | 57 仓 AGENTS.md 解析 + LLM 响应缓冲 |
| 磁盘 (持久 worktree) | — | 15 GB (PVC) | 57 仓完整工作树 |

**共享存储 (PVC)**：

| 用途 | 容量 | 类型 | 说明 |
|------|------|------|------|
| bare repo | 5-8 GB | SSD PVC | `--filter=blob:none` 模式 |
| 持久 worktree | 10-15 GB | SSD PVC | 索引服务专用 |
| AGENTS.md + 风险记录 | 500 MB | 同 PVC | 极小 |
| **总计推荐** | **30 GB SSD** | ReadWriteOnce | 单节点写入 |

**并发约束**：

| 约束 | 值 | 推导 | 可调整 |
|------|-----|------|--------|
| 最大并发分析任务 | 5 | Pod 4c8g 下每任务 ~1c1g | Project Config |
| 每任务最大 worker | 6 | `floor(LLM_RPM / avg_calls_per_worker / safety)` | Project Config |
| LLM RPM 总预算 | 60 | Provider 配额（按实际购买） | 环境变量 |
| 排队等待超时 | 5 min | 超时返回 429 + Retry-After | 固定 |
| 任务队列深度上限 | 20 | 防止积压 | Project Config |

**HPA 策略**（可选，Phase 5）：

```yaml
# 基于队列深度的自动伸缩
metrics:
  - type: External
    external:
      metric:
        name: analysis_queue_depth
      target:
        type: AverageValue
        averageValue: 3    # 每 Pod 平均 3 个排队任务时扩容
minReplicas: 1
maxReplicas: 3
```

### 健康检查

```yaml
# 分析服务 Pod spec
containers:
  - name: analysis-service
    livenessProbe:
      httpGet:
        path: /healthz       # 进程存活（无深度检查）
        port: 8080
      initialDelaySeconds: 10
      periodSeconds: 30
      failureThreshold: 3
    readinessProbe:
      httpGet:
        path: /readyz        # pi binary 可用 + bare repo 目录可读 + LLM 可达
        port: 8080
      initialDelaySeconds: 5
      periodSeconds: 10
      failureThreshold: 2
    startupProbe:
      httpGet:
        path: /healthz
        port: 8080
      initialDelaySeconds: 5
      periodSeconds: 5
      failureThreshold: 12   # 最多等 60s 启动
```

**健康检查端点逻辑**：

| 端点 | 检查内容 | 失败影响 |
|------|---------|---------|
| `/healthz` | 进程存活 | Pod 重启 |
| `/readyz` | pi binary 存在 + `/repos/bare/` 可读 + LLM API 最近 5min 内有成功 | 从 Service 摘除 |
| `/metrics` | Prometheus 格式指标 | 无（仅数据采集） |

### 告警规则

```yaml
# PrometheusRule
groups:
  - name: cross-repo-analysis
    rules:
      - alert: AnalysisSuccessRateLow
        expr: |
          (rate(analysis_completed_total{status="success"}[1h])
           / rate(analysis_submitted_total[1h])) < 0.8
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "分析成功率低于 80%"
          description: "过去 1 小时分析成功率 {{ $value | humanizePercentage }}，可能 LLM 限流或 pi crash"

      - alert: AnalysisLatencyHigh
        expr: histogram_quantile(0.95, rate(analysis_duration_seconds_bucket[30m])) > 600
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "P95 分析延迟超过 10 分钟"

      - alert: LLMConsecutiveFailures
        expr: analysis_llm_consecutive_failures >= 3
        for: 0m
        labels:
          severity: critical
        annotations:
          summary: "LLM 连续失败 3 次，已触发降级"
          runbook: "检查 LLM provider 状态、API key 有效性、网络连通性"

      - alert: CacheHitRateDrop
        expr: analysis_cache_hit_rate{window="1h"} < 0.2
        for: 30m
        labels:
          severity: info
        annotations:
          summary: "Prompt cache 命中率骤降至 {{ $value | humanizePercentage }}"
          description: "可能原因：system prompt 变化、AGENTS.md 大量更新、新 project 接入"

      - alert: TaskQueueBacklog
        expr: analysis_queue_depth > 15
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "任务队列积压 {{ $value }} 个"
          description: "考虑扩容或检查是否有死循环任务"
```

### 数据生命周期与灾备

**数据保留策略**：

| 数据类型 | 保留期 | 存储位置 | 备份策略 | 恢复成本 |
|---------|--------|---------|---------|---------|
| bare repo | 永久 | PVC (SSD) | 无需备份 | 从 remote 重新 clone（~1h） |
| AGENTS.md 自动段 | 永久 | PVC | 无需备份 | 脚本重新生成（<1min/仓） |
| AGENTS.md 语义层 | 永久 | PVC + 每周快照 | 对象存储快照 | 从快照恢复（分钟级）或 LLM 重新生成（$30-60, 2-3h） |
| 热区风险记录 | 30 天 | PVC | 每日快照 | 从快照恢复或丢失（可接受，30 天内会重新积累） |
| 温区风险记录 | 180 天 | PVC | 每周快照 | 从快照恢复 |
| 冷区统计 JSON | 永久 | PVC | 每月快照 | 从快照恢复 |
| GLOBAL_PATTERNS.md | 永久 | PVC + 每周快照 | 对象存储 | 从快照或从温区重新归纳 |
| 分析结果/Trace | 1 年 | Opik DB | Opik 自身策略 | Opik 备份恢复 |
| 审计日志 | 90 天 | 日志系统 | 日志系统策略 | 不可恢复（可接受） |

**灾难恢复**：

| 故障场景 | RTO | RPO | 恢复方式 |
|---------|-----|-----|---------|
| PVC 数据全丢 | 4h | 上次快照 | clone bare repo + 恢复快照 + 重新生成自动段 |
| 分析服务 Pod crash | 2min | 0 | K8s 自动重建（无状态） |
| Opik 不可用 | 0 | 0 | 分析继续，trace 写入本地文件后补传 |
| LLM provider 全挂 | 0 | 0 | 自动降级为 ast-grep only 模式 |
| git remote 不可达 | 10min fetch 间隔 | 上次成功 fetch | 使用本地 bare repo 已有数据 |
| 索引服务 Pod crash | 10min | 上次轮询 | CronJob 自动重建，丢失最多一个轮询周期 |

**备份快照 CronJob**：

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: data-snapshot
spec:
  schedule: "0 4 * * *"   # 每日 04:00
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: snapshot
              image: alpine:latest
              command: ["/bin/sh", "-c"]
              args:
                - |
                  # 热区每日快照
                  tar czf /snapshots/risk-hot-$(date +%Y%m%d).tar.gz /data/index/risk-history/*.md
                  # 语义层每周快照（周日）
                  if [ $(date +%u) -eq 7 ]; then
                    tar czf /snapshots/agents-md-$(date +%Y%m%d).tar.gz /data/index/agents-md/
                    tar czf /snapshots/global-patterns-$(date +%Y%m%d).tar.gz /data/index/risk-history/GLOBAL_PATTERNS.md
                  fi
                  # 清理 30 天前的快照
                  find /snapshots -name "*.tar.gz" -mtime +30 -delete
```

---

## 第八部分：AGENTS.md 生命周期管理

### 分层结构

每个仓库的 AGENTS.md 分两层：

- **自动生成段**：确定性脚本生成，每 10 分钟（hash 变化时）更新，结构信息 100% 准确，零 LLM 成本
- **语义层**：LLM 生成，包含脚本无法推断的领域知识（哪个目录真正高危、跨仓运行时依赖），每周自动刷新

```markdown
# repo-001

<!-- ====== 自动生成段 ====== -->
<!-- auto-generated: 2026-05-13T08:30:00Z, commit: a1b2c3d -->

## 目录结构
- src/auth/ (12 files)
- src/api/ (8 files)
- src/services/token-validator/ (3 files)

## 导出模块
auth/__init__.py exports: verify_token, hash_password, create_session

## 内部依赖
- cvm_common
- shared_logger

## 测试
- 框架: vitest, 测试文件: 23, 覆盖率报告: 有

<!-- ====== 语义层 ====== -->

## 高风险模块
- src/auth/ — 公网认证入口
- src/services/token-validator/ — 鉴权逻辑（目录名不明显）

## 跨仓运行时依赖
- repo-002 通过 HTTP 调用 /api/verify
- repo-005 通过消息队列消费 auth.event

## 历史风险摘要
（由压缩机制维护，见第九部分）
```

### 生成策略

| 阶段 | 方式 | 频率 | 耗时 | 成本 |
|------|------|------|------|------|
| **自动段** | 确定性脚本 | 每 10 分钟（hash 变化时） | <1s/仓 | 0 |
| **语义层首次** | ai_docs 提取 + LLM 补充 | 部署时一次 | ~2-3h 总计 | ~$30-60 |
| **语义层刷新** | LLM 重新生成 | **每周一次**（周日凌晨） | ~2-3h 总计 | ~$30-60/周 |
| **跨仓做梦** | LLM 关联归纳 | **每周一次**（同上） | ~30min | ~$5-10 |

### ai_docs 作为语义层的权威输入

ai_docs 仓库（`https://git.woa.com/cvm/ai_docs.git`）是架构知识的权威来源，语义层的「跨仓运行时依赖」优先从 ai_docs 提取而非 LLM 猜测：

```
语义层生成优先级：
  1. ai_docs 中明确描述的调用关系 → 直接写入（100% 准确）
  2. ai_docs 中标注的入口模块（cvm-api、cxm-api）→ 自动标记为最高风险
  3. 代码扫描发现的 HTTP 框架调用模式 + RabbitMQ routing_key → 写入 AGENTS.md
  4. LLM 推断的调用关系 → 写入并标注「LLM 推断，待确认」
```

索引服务会定期同步 ai_docs，语义层刷新时读取最新架构文档。

### HTTP 框架调用模式：代码扫描自动生成

各仓库的 HTTP 框架封装不统一，通过代码扫描自动识别并写入 AGENTS.md：

```
扫描策略（索引服务执行，每周刷新语义层时）：

1. 识别框架模式：
   grep -rn "class.*Client\|def.*request\|BaseClient\|ServiceClient" --include="*.py"
   → 找到该仓库封装的 HTTP client 类名和调用方式

2. 提取调用示例：
   找到 client 类后，grep 所有调用点，提取 URL/service_name 参数
   → 生成「本仓调用了哪些服务」的列表

3. 提取路由定义（被调用方）：
   grep -rn "@app.route\|@router\.\|urlpatterns\|path(" --include="*.py"
   → 生成「本仓暴露了哪些 endpoint」的列表

4. 写入 AGENTS.md 语义层：
   ## HTTP 调用模式
   - 框架: ServiceClient (from common.http_client import ServiceClient)
   - 调用方式: ServiceClient("cvm-api").post("/api/v1/verify", data)
   - 本仓调用的服务: cvm-api(/api/v1/verify), auth-service(/auth/token)
   - 本仓暴露的接口: /api/v1/instances, /api/v1/images
```

分析时 agent 读取 AGENTS.md 就知道各仓库的框架调用模式，无需每次重新发现。

### RabbitMQ routing_key：代码扫描自动生成

使用 pika 库，扫描策略：

```
扫描策略（索引服务执行）：

1. 提取生产者（publish 端）：
   grep -rn "basic_publish\|exchange_declare\|routing_key" --include="*.py"
   → 提取 exchange 名 + routing_key 模式

2. 提取消费者（consume 端）：
   grep -rn "basic_consume\|queue_bind\|queue_declare" --include="*.py"
   → 提取 queue 名 + binding key

3. 写入 AGENTS.md 语义层：
   ## RabbitMQ 消息模式
   - 生产: exchange="auth_events", routing_key="auth.token.verified"
   - 消费: queue="payment_auth_queue", binding_key="auth.token.*"
   - 关联仓库: auth-service(生产) → payment-service(消费)
```

这样分析时 agent 能直接从 AGENTS.md 得到完整的 MQ 拓扑关系。

每周语义层刷新的 CronJob：

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: agents-md-semantic-refresh
spec:
  schedule: "0 3 * * 0"   # 每周日 03:00
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: refresh
              image: pi-analysis-service:latest
              command: ["node", "scripts/refresh-semantic-layer.js"]
```

大多数仓库每周没有结构性变化，LLM 只需判断"是否需要更新"（几百 token）。实际每周只有 5-10 个仓库需要真正刷新。

### 分支分析时 AGENTS.md 的处理

**不需要修改 AGENTS.md**。AGENTS.md 反映 main 分支的静态元信息，分支改动是动态分析的输入。如果分支改变了目录结构，agent 用 `ls`/`find` 实时发现差异。合并到 main 后索引服务自动更新。

---

## 第九部分：历史风险记录 — 压缩与做梦机制

### 问题：持续追加会膨胀

每次分析追加一条记录，57 个仓库 × 每天多次分析 → 几周后文件膨胀到几百 KB，超出 LLM 上下文窗口。

### 设计：热/温/冷三层（借鉴 Claude Code 的 memory + compaction + dreaming）

```
┌─────────────────────────────────────────────┐
│  热区（最近 30 天，完整记录）                  │  ← agent 每次分析后直接追加
│  位置: /index/risk-history/repo-001.md       │
│  格式: 逐条明细，含 diff 位置、调用链、处置    │
│  大小上限: 200 行 / 25KB（与 Claude Code 对齐）│
├─────────────────────────────────────────────┤
│  温区（30-180 天，压缩摘要）                   │  ← 每周"做梦"时从热区压缩迁移
│  位置: /index/risk-history/repo-001.archive.md│
│  格式: 按模块聚合的风险模式总结                │
│  大小上限: 100 行 / 15KB                      │
├─────────────────────────────────────────────┤
│  冷区（180 天以上，统计数据）                   │  ← 每月归档时从温区压缩迁移
│  位置: /index/risk-history/repo-001.stats.json│
│  格式: JSON 统计（哪些模块出过 P0 几次等）     │
│  大小上限: 无限制（JSON 极小）                 │
└─────────────────────────────────────────────┘
```

### 热区：直接追加

每次分析完成后，agent 往热区追加一条：

```markdown
### 2026-05-13 verify_token (auth-service/auth/service.py:42)
- 变更: `is` → `==`（身份比较→值比较）
- 初始风险: 极高
- 影响: 6 仓, P0×2 (cvm-api/views/login.py, payment-service/handler.py)
- 处置: 补充类型守卫 + 边界测试
- 教训: 身份比较→值比较是极高危改动类型
```

### 温区：每周做梦（consolidation）

借鉴 Claude Code 的 `autoDream` 四阶段模式，每周日凌晨执行：

```
Phase 1 — 扫描热区: 识别超过 30 天的记录
Phase 2 — 仓库内模式归纳: 将多条相似记录合并为一条模式总结
Phase 3 — 跨仓关联归纳: 读取所有仓库的温区，识别反复出现的跨仓风险传播路径
         输出到 /index/risk-history/GLOBAL_PATTERNS.md
Phase 4 — 迁移: 压缩摘要追加到温区，从热区删除原始记录
Phase 5 — 修剪: 温区超 100 行/15KB 时，最旧条目压缩为统计迁移到冷区
```

仓库内归纳示例：3 条关于 verify_token 的记录 →

```
verify_token (auth/service.py) 是高频风险点，3 次改动中 2 次触发 P0。
主要风险模式：类型比较运算符变更、返回值 None 化。
受影响核心调用者：cvm-api/views/login.py, payment-service/handler.py。
必须有测试覆盖，建议添加 mypy strict 检查。
```

跨仓关联归纳示例（GLOBAL_PATTERNS.md）：

```markdown
## 高频跨仓风险传播路径

### auth-service → cvm-api（P0 频率：4 次/季度）
- 传播链：auth-service/verify_token → cvm-api/middleware/auth.py → cvm-api/views/*
- 典型触发：auth 函数签名变更、返回类型变化
- 建议：auth-service 任何变更都应触发 cvm-api 的完整测试套件

### auth-service → payment-service（P0 频率：2 次/季度）
- 传播链：auth-service/verify_token → payment-service/handler.py（通过 HTTP 调用）
- 运行时依赖，ast-grep 无法捕获，依赖 grep HTTP endpoint 匹配
```

### 冷区：每月归档

温区中超过 180 天的摘要压缩为纯统计 JSON：

```json
{
  "repo": "repo-001",
  "period": "2026-Q1",
  "modules": {
    "src/auth/verify_token": {
      "incidents": 5,
      "p0_count": 2,
      "p1_count": 1,
      "common_patterns": ["身份比较运算符变更", "返回值 None 化"],
      "most_affected_callers": ["cvm-api/views/login.py", "payment-service/handler.py"]
    }
  }
}
```

### 紧急压缩（热区溢出）

两次做梦之间热区超出 200 行/25KB 时：截取前 50% 最旧记录 → LLM 快速压缩 → 追加到温区 → 从热区删除。

### 分析时的读取策略

```
Step 0（自动）: read 热区（最近 30 天明细）
仅当发现高风险节点时: read 温区（历史模式）
仅当需要统计数据时: jq 查 冷区 JSON
```

---

## 第十部分：待讨论的开放问题

### 必须讨论（阻塞实施）

**Q1：57 个仓库的组织关系** ✅ 已确认
- 架构知识在 ai_docs 仓库（`https://git.woa.com/cvm/ai_docs.git`）
- 入口模块：cvm-api、cxm-api
- 仓库间调用：Python import + HTTP + MQ
- 语言分布：Python ~55 仓 + 1 PHP + 少量 Go
> 待确认：内部包命名约定（是否有 `@myorg/*` 或特定前缀？Python 包名规则？）

**Q2：LLM provider** ✅ 已确认
- 支持配置，兼容 OpenAI 协议（腾讯云或其他供应商）
- pi 通过 `--provider openai-completions --model <model-id>` + 环境变量 `OPENAI_BASE_URL` / `OPENAI_API_KEY` 接入
- 分析服务读取配置文件选择 provider + model
> 配置示例见下方「LLM 配置」段落。

**Q3：用户交互方式** ✅ 已确认
- 异步任务队列
- 用户提交：仓库名 + 分支/commit（可多个），系统自动获取 diff
- 重点保证准确性，输出包含：调用链、风险提示、前置依赖、测试场景、测试入参、预期结果、观察点 Oracle
> API 设计见下方「API 接口设计」段落。

**Q4：触发方式** ✅ 已确认
- MVP 阶段手动提交（diff/MR URL/仓库+分支）
- 一次可提交多个仓库的变更
- 后续可扩展 webhook 自动触发

### 建议讨论（影响质量）

**Q5：ast-grep 多语言规则** ✅ 已确认
- Python 为主（`--lang python`），1 个 PHP（`--lang php`），少量 Go（`--lang go`）
- ast-grep 规则需要三套：Python snake_case 命名、PHP、Go
> 影响：规则文件模板需要按语言分别准备。

**Q6：现有测试基础设施** — 多少仓库有 CI？有 coverage 报告？测试框架统一吗？

**Q7：权限与安全** — 需要限制 pi 的 bash 权限？仓库有敏感信息？

**Q8：并发与资源** — 同时分析请求数？内存/CPU 需求？mirror 总大小？

### 可以后续迭代（不阻塞 MVP）

**Q9：分析报告持久化** ✅ 已确认
- Opik trace 即为分析过程和结果的持久化存储
- 查询历史：通过 Opik UI / API 按 project + task_id 查询
- 趋势分析：基于 Opik evaluate 的指标时序数据 + 冷区统计 JSON

**Q10：CI/CD 集成深度** — PR 自动评论？P0 自动阻止 merge？集成哪些平台？

**Q11：多分支分析** — 同时分析多个分支？分支间 diff 处理？

**Q12：增量分析** — 后续 commit 只需增量分析？per-commit 还是 per-PR？

---

## 第十一部分：实施路线

### Phase 1a：最小可运行系统（2 周）

> 目标：对 1 个已知 PR 产出正确的调用链 + 风险报告。本地 Docker Compose 环境验证核心逻辑。

- [ ] Docker Compose 本地环境（不上 K8s）
- [ ] 5-8 个核心仓库的 git bare + worktree
- [ ] GitNexus 索引（5-8 仓库）
- [ ] pi Skill 封装 5 步分析流程（Python 风险标准，单仓库串行）
- [ ] 同步 API（提交 → 等待 → 返回结果，无 task_id）
- [ ] 基础错误处理（超时 + 单次重试）
- [ ] 验收：对 1 个已知影响范围的 PR 产出正确报告

### Phase 1b：服务化升级（2-3 周）

> 目标：3 个并发分析任务均成功完成。迁移到 K8s 并扩展到全量仓库。

- [ ] K8s 基础设施：git bare mirror + PVC + 仓库同步 CronJob
- [ ] 扩展到 57 个仓库（确定性脚本生成 AGENTS.md 自动段）
- [ ] 异步 API（提交仓库+分支 → task_id → 轮询结果）
- [ ] 分析服务 + pi RPC 集成（单 worker 串行模式）
- [ ] Opik trace 基础集成（standard 粒度：per-worker + per-LLM-call span）
- [ ] per-task 成本追踪 + Prometheus metrics
- [ ] 完整错误恢复：指数退避 + model fallback + 部分结果返回
- [ ] 验收：3 个并发分析任务均成功完成

### Phase 2：智能化（2-3 周）

- [ ] LLM 首次生成 57 个仓库的语义层（ai_docs + 代码扫描）
- [ ] AGENTS.md 语义层正确性自动验证（见下方）
- [ ] 每周语义层自动刷新 CronJob
- [ ] 历史风险记录追加机制（热区）
- [ ] 并行分析编排（Coordinator 模式，MAX_PARALLEL_WORKERS=6）
- [ ] 两阶段预筛（git grep 粗筛 + ast-grep 精筛）+ 按需加载 AGENTS.md
- [ ] Thinking 分级（风险推理启用 reasoning，报告生成不启用）

### Phase 3：压缩与积累（2 周）

- [ ] 热/温/冷三层风险记录管理
- [ ] 每周做梦（仓库内归纳 + 跨仓 GLOBAL_PATTERNS）
- [ ] 紧急压缩机制
- [ ] Opik 评估指标上线（P0 精确率/召回率、调用链覆盖率）
- [ ] Ground Truth 积累（人工反馈 API + LLM-as-Judge 抽样）
- [ ] Ground Truth 偏差防御机制（见下方）

### Phase 4：自进化（2-3 周）

- [ ] Evidence 积累系统（误判 case → Opik trace 回溯）
- [ ] 每周进化分析 CronJob（LLM 分析 evidence → 改进建议）
- [ ] 人工审核流程（进化建议 → review → 批准/驳回）
- [ ] A/B 测试框架（实验配置 + Opik 对比 + 自动 promote/rollback）
- [ ] 紧急自动降级（连续 3 次同类误判 → 规则自动降级）
- [ ] 历史验证 CronJob（合并后 7 天检查线上表现 → 自动积累 ground truth）

### Phase 5：扩展与优化（持续）

- [ ] CI/CD webhook 自动触发分析
- [ ] PR 评论集成
- [ ] 并发优化与 Pod 自动伸缩
- [ ] 增量分析支持
- [ ] 趋势分析仪表盘（基于 Opik + 冷区统计数据）
- [ ] 新业务组接入（验证多租户 Project Config 流程）

### 核心算法测试策略

以下确定性模块是系统正确性的基石，必须有完整单元测试覆盖。Ground Truth 评估的是端到端结果，无法定位具体算法 bug——单元测试填补这个空缺。

**风险传播算法 (RiskPropagation)**：

| # | 测试场景 | 输入 | 预期输出 | 验证点 |
|---|---------|------|---------|--------|
| 1 | 线性链衰减 | A→B→C, 全 direct_call, 初始 risk=1.0 | B=0.8, C=0.64 | 衰减系数正确 |
| 2 | MQ 快速衰减 | A→B(mq_event), risk=1.0 | B=0.4, B 无子树展开 | MQ 松耦合 2 跳即止 |
| 3 | 混合调用链 | A→B(direct)→C(http)→D(mq) | B=0.8, C=0.48, D=0.19 | 多类型衰减正确叠加 |
| 4 | 扇出剪枝 | 节点有 25 个 caller | 只展开 Top 20 | prunedCallers=5 |
| 5 | 环形防护 | A→B→C→A | visited 检测，输出 3 节点 | 无死循环 |
| 6 | MAX_DEPTH 安全网 | 链长 10, 全 direct_call | 第 5 层截断 | truncated=true |
| 7 | 阈值截止 | risk=0.2 → caller(direct) | 0.2×0.8=0.16 > 0.15 继续 | 边界正确 |
| 8 | 公网 API 入口 | node.isPublicApi=true | 初始 risk=1.0 | computeInitialRisk |
| 9 | 测试辅助函数 | node.isTestHelper=true | 初始 risk=0.1 | 不会成为 P0 |
| 10 | P0/P1/P2 映射 | risk=0.65 / 0.4 / 0.2 | P0 / P1 / P2 | 阈值映射正确 |

**确定性合并 (mergeWorkerResults)**：

| # | 测试场景 | 输入 | 预期输出 |
|---|---------|------|---------|
| 1 | 无冲突合并 | 2 worker 命中不同节点 | 并集 |
| 2 | 同节点多链命中 | 2 worker 都找到 login.py:18 (risk=0.8 和 0.6) | risk=0.8, hitCount=2, viaChains=[chain1, chain2] |
| 3 | 风险排序 | P0(0.8) + P1(0.4) + P2(0.2) | 按 riskPriority 降序排列 |
| 4 | 空 worker 结果 | 1 worker 返回空 | 合并结果仅包含另一 worker 的节点 |
| 5 | 多链标注 | hitCount > 1 | annotation = "被 N 条调用链命中" |

**两阶段预筛 (coarseFilter + fineFilter)**：

| # | 测试场景 | 输入 | 预期行为 |
|---|---------|------|---------|
| 1 | 直接符号名命中 | git grep 在 repo-A 找到 `verify_token` | repo-A 进入 coarseHits |
| 2 | HTTP endpoint 命中 | git grep 在 repo-B 找到 `/api/verify` | repo-B 进入 coarseHits |
| 3 | MQ topic 命中 | git grep 在 repo-C 找到 `auth.token.verified` | repo-C 进入 coarseHits |
| 4 | 配置引用命中 | git grep 在 YAML 中找到 fully qualified name | 该仓库进入 coarseHits |
| 5 | 反向依赖命中 | git grep 找到 package name import | 该仓库进入 coarseHits |
| 6 | 粗筛命中但精筛未命中 | grep 有但 ast-grep 无 | 最终不包含该仓库 |
| 7 | 全部未命中 | 57 仓 git grep 均无匹配 | 空集，不创建任何 worktree |
| 8 | 并集语义 | Layer 1 命中 repoA, Layer 3 命中 repoB | 两者都在 coarseHits 中 |

**AGENTS.md 自适应加载 (loadAgentsMdAdaptive)**：

| # | 测试场景 | 输入 | 预期行为 |
|---|---------|------|---------|
| 1 | 预算充足 | budget=40K, 3 个 Tier 1 + 5 个 Tier 2 命中 | 全部加载完整版 |
| 2 | 预算紧张 | budget=10K, 3 个 Tier 1 + 10 个 Tier 2 命中 | Tier 1 完整, Tier 2 降为摘要 |
| 3 | Tier 3 始终摘要 | 任何预算 | Tier 3 仓库只加载 200 token 摘要 |

**测试框架**：与分析服务语言一致（TypeScript，使用 vitest 或 jest）。Mock git/ast-grep 的 spawnSync 调用，测试纯逻辑。

### 成本预估

**月度运营成本估算（CVM 项目，57 仓）**：

| Phase | LLM 成本/月 | 基础设施/月 | 人力投入 | 累计 |
|-------|------------|-----------|---------|------|
| 1a 本地验证 | ~$50 | $0（本地 Docker） | 1 人 × 2 周 | 2 周 |
| 1b K8s 单租户 | ~$200 | ~$100（2 Pod 4c8g） | 1 人 × 3 周 | 5 周 |
| 2 智能化 | ~$500 | ~$100 + $240 语义层刷新 | 1-2 人 × 3 周 | 8 周 |
| 3 压缩+积累 | ~$600 | ~$340 + $40 做梦 | 1 人 × 2 周 | 10 周 |
| 4 自进化 | ~$700 | ~$380 + A/B 10% | 1 人 × 3 周 | 13 周 |
| **稳态运营** | **~$700** | **~$400** | **0.2 人（维护）** | — |

**假设**：
- 每工作日 ~10 次分析请求（accuracy_first 模式，每次 $1-3）
- 语义层刷新：57 仓 × $4-6/仓 × 4 周/月 ≈ $240/月（大多数仓库每周无需刷新，实际可能 $60-100）
- 做梦 + GLOBAL_PATTERNS：每周 ~$5-10 × 4 ≈ $40/月
- 基础设施：2 × Pod (4c8g) ≈ $100/月 + 30GB SSD PVC ≈ $10/月

**首年总成本（含建设期）**：

| 类别 | 金额 | 说明 |
|------|------|------|
| LLM 运营 | ~$6,000 | 前 3 月低（$200/月），后 9 月稳态（$700/月） |
| 基础设施 | ~$4,000 | K8s + 存储 + 网络 |
| 人力（建设） | 13 人周 | 按工程师成本计算 |
| 人力（维护） | ~0.2 FTE/年 | 自进化减少人工干预 |
| **年度运营总计** | **~$10,000 + 人力** | 不含一次性建设 |

---

## 第十二部分：API 接口设计

### 提交分析任务

```
POST /api/analyze
Content-Type: application/json

{
  "project": "cvm",
  "changes": [
    {
      "repo": "auth-service",
      "branch": "feature/token-refactor",
      "base": "main"
    },
    {
      "repo": "cvm-api",
      "commit": "a1b2c3d"
    }
  ],
  "options": {
    "depth": 2,              // 调用链展开层数，默认 2
    "include_test_plan": true // 是否生成测试场景
  }
}

→ 202 Accepted
{
  "task_id": "analysis-20260513-001",
  "status": "queued",
  "poll_url": "/api/analyze/analysis-20260513-001"
}
```

系统自动通过 git 获取 diff（`git diff main...feature/token-refactor`），无需用户粘贴 diff 内容。

### 查询任务状态

```
GET /api/analyze/{task_id}

→ 200 OK（进行中）
{
  "task_id": "analysis-20260513-001",
  "status": "running",
  "progress": {
    "step": 2,
    "step_name": "构建跨仓调用链",
    "repos_scanned": 23,
    "repos_total": 57
  }
}

→ 200 OK（完成）
{
  "task_id": "analysis-20260513-001",
  "status": "completed",
  "result": { ... }  // 见输出规范
}
```

### 输出规范（API JSON 格式）

> 此为 API 返回的结构化 JSON 格式，与第二部分的人类可读报告格式一一映射。前端/报告渲染时可转换为第二部分的 markdown 树形格式。

分析完成后输出包含以下完整字段：

```json
{
  "summary": {
    "total_symbols_changed": 3,
    "affected_repos": 6,
    "unaffected_repos": 51,
    "risk_breakdown": { "P0": 2, "P1": 1, "P2": 3, "P3": 0 }
  },
  "symbols": [
    {
      "name": "verify_token",
      "location": "auth-service/auth/service.py:42",
      "diff_semantic": "严格比较 is → 宽松比较 ==（类型强制转换）",
      "initial_risk": "critical",
      "call_tree": { ... },
      "risk_table": [
        {
          "priority": "P0",
          "location": "cvm-api/views/login.py:18",
          "function": "login_view",
          "via": "直接",
          "risk": "critical",
          "test_coverage": "none",
          "domain_context": "公网 API 入口",
          "remediation": "阻塞合并，补类型守卫 + 测试"
        }
      ],
      "test_plan": [
        {
          "target": "cvm-api/views/login.py login_view()",
          "scenario": "verify_token 返回值类型强制边界测试",
          "preconditions": [
            "auth-service 的 verify_token 已改为 == 比较"
          ],
          "test_cases": [
            {
              "name": "正常 token 验证通过",
              "input": { "token": "valid_jwt_string" },
              "expected": { "status": 200, "user_id": "not_none" },
              "oracle": "返回有效 user 对象，非 None"
            },
            {
              "name": "None token 不能通过验证",
              "input": { "token": null },
              "expected": { "status": 401 },
              "oracle": "旧版 is 比较保证 None 被拒绝，新版 == 仍应拒绝"
            },
            {
              "name": "空字符串不能作为有效 token",
              "input": { "token": "" },
              "expected": { "status": 401 },
              "oracle": "'' == None 在 Python 中为 False（安全），但 '' == 0 需确认不影响下游"
            },
            {
              "name": "数字 0 不能绕过验证",
              "input": { "token": 0 },
              "expected": { "status": 401 },
              "oracle": "0 == '' 为 False，但 0 == False 为 True，需确认 verify_token 不返回 bool"
            }
          ],
          "observation_points": [
            "verify_token 的实际返回类型（str? dict? bool?）",
            "login_view 对 verify_token 返回值的使用方式（是否做了 if result: 判断）",
            "下游 middleware 是否依赖 verify_token 返回值的具体类型"
          ]
        }
      ]
    }
  ],
  "untrackable": [
    "动态调用 getattr(obj, method_name)() 在 cxm-api/utils/dispatch.py 中存在",
    "RabbitMQ consumer 通过 routing_key 模式匹配，可能有未列出的消费者"
  ],
  "global_patterns_matched": [
    "auth-service → cvm-api 是历史高频 P0 路径（4 次/季度）"
  ]
}
```

---

## 第十二部分补充：API 认证与多租户权限隔离

### 认证方式

所有 API 端点均需认证。采用 Bearer Token（JWT 或内部 API Key），通过 API 网关统一校验：

```
Authorization: Bearer <token>
```

| 认证方式 | 适用场景 | Token 获取 |
|---------|---------|-----------|
| **JWT（推荐）** | 服务间调用、CI webhook | 内部 IAM 签发，含 project claim |
| **API Key** | 手动调试、本地开发 | 管理后台生成，绑定 project |

### 权限模型（RBAC）

```yaml
scopes:
  analyze:submit        # 提交分析任务
  analyze:read          # 查看分析结果
  analyze:cancel        # 取消进行中的任务
  feedback:write        # 提交反馈（Ground Truth 积累）
  config:read           # 查看 Project Config
  config:write          # 修改 Project Config（危险）
  admin:experiments     # 管理 A/B 实验

roles:
  developer:            # 普通开发者
    scopes: [analyze:submit, analyze:read, feedback:write]
  tech_lead:            # 技术负责人
    scopes: [analyze:submit, analyze:read, analyze:cancel, feedback:write, config:read]
  admin:                # 管理员
    scopes: ["*"]
```

### 多租户隔离

```yaml
project_isolation:
  strategy: "token_claims"
  # JWT payload 示例:
  # { "sub": "user-123", "projects": ["cvm", "data-platform"], "role": "developer" }

  enforcement:
    - layer: "API Gateway"
      check: "token.projects CONTAINS request.body.project"
    - layer: "分析服务"
      check: "task.project == user.projects[]"

  data_isolation:
    - "每个 project 的 bare repo、AGENTS.md、风险记录物理隔离（不同 PVC 目录）"
    - "Opik trace 按 project 标签隔离"
    - "Prometheus metrics 按 project label 分拆"

  quota:
    per_project:
      max_concurrent_tasks: 5          # 每个 project 最多 5 个并发任务
      max_daily_tasks: 100             # 每日上限
      max_monthly_cost_usd: 2000       # 月度成本上限（告警，非硬限制）
```

### API 端点认证要求

| 端点 | 方法 | 最低权限 |
|------|------|---------|
| `/api/analyze` | POST | `analyze:submit` |
| `/api/analyze/{task_id}` | GET | `analyze:read` |
| `/api/analyze/{task_id}` | DELETE | `analyze:cancel` |
| `/api/feedback/{task_id}` | POST | `feedback:write` |
| `/api/projects/{project}/config` | GET | `config:read` |
| `/api/projects/{project}/config` | PUT | `config:write` |
| `/api/experiments` | GET/POST | `admin:experiments` |
| `/healthz` | GET | 无需认证 |
| `/readyz` | GET | 无需认证 |
| `/metrics` | GET | 内网 IP 白名单（Prometheus scrape） |

### 审计日志

所有写操作记录审计日志：

```json
{
  "timestamp": "2026-05-13T10:30:00Z",
  "user": "user-123",
  "action": "analyze:submit",
  "project": "cvm",
  "resource": "task/analysis-20260513-001",
  "ip": "10.0.1.50",
  "result": "accepted"
}
```

审计日志保留 90 天，存储在独立日志系统（不占分析服务存储）。

---

## 第十三部分：LLM 与内部包配置

> 详细配置已整合到 Project Config 中（见第十六部分 `llm:` 和 `internal_packages:` 段）。

### pi 集成方式

pi 通过环境变量和参数适配 OpenAI 兼容协议：

```bash
# 从 Project Config 的 llm.analysis 读取参数
OPENAI_BASE_URL="$LLM_BASE_URL" \
OPENAI_API_KEY="$LLM_API_KEY" \
pi --mode rpc --provider openai-completions --model "$LLM_MODEL"
```

配置变更无需重启——分析服务每次 spawn pi 子进程时从 Project Config 读取，修改 YAML 即可。

### 模型分档建议

| 用途 | 要求 | 建议 |
|------|------|------|
| **分析主流程**（Step 1-5 + 测试场景生成） | 强推理、理解代码语义 | 强模型（如 GPT-4o / Claude Sonnet） |
| **AGENTS.md 生成 / 做梦压缩** | 结构化归纳 | 快+便宜模型（如 GPT-4o-mini） |

### pi RPC 接口合约

分析服务通过 stdin/stdout JSON 协议与 pi 子进程通信。以下为接口合约，供两侧独立开发和测试。

**启动命令**：

```bash
OPENAI_BASE_URL="$BASE_URL" OPENAI_API_KEY="$KEY" \
  pi --mode rpc --provider openai-completions --model "$MODEL" \
     --thinking-level medium --max-tokens 8192
```

**输入协议（分析服务 → pi stdin，每行一个 JSON）**：

```jsonc
// 1. 发送分析 prompt（首条消息）
{
  "type": "prompt",
  "sessionId": "task-abc123",
  "content": "按 AGENTS.md 协议执行完整 5 步分析...",
  "context": {
    "workingDir": "/worktrees/tasks/task-abc123/auth-service",
    "envVars": {
      "REPOS_ROOT": "/worktrees/tasks/task-abc123"
    }
  }
}

// 2. 继续对话（worker 需要追加上下文时）
{ "type": "continue", "sessionId": "task-abc123", "content": "请继续分析 Step 3..." }

// 3. 中断（超时或用户取消时）
{ "type": "abort", "sessionId": "task-abc123" }
```

**输出协议（pi stdout → 分析服务，每行一个 JSON 事件）**：

```jsonc
// 生命周期事件
{ "type": "agent_start", "sessionId": "task-abc123", "timestamp": "..." }
{ "type": "turn_start", "turnId": 1 }

// 工具执行事件（用于 Opik trace 记录）
{ "type": "tool_call_start", "tool": "bash", "input": "sg scan --rule /tmp/impact.yml --json /worktrees/..." }
{ "type": "tool_call_end", "tool": "bash", "output": "[{...}]", "durationMs": 2340, "exitCode": 0 }
{ "type": "tool_call_start", "tool": "read", "input": "/worktrees/tasks/.../cvm-api/views/login.py" }
{ "type": "tool_call_end", "tool": "read", "output": "def login_view(request):\n...", "durationMs": 5 }

// 文本输出事件（agent 的推理过程和最终报告）
{ "type": "text_chunk", "content": "## Step 1: diff 语义解读\n..." }

// Turn 结束（含 token 用量，用于成本追踪）
{
  "type": "turn_end",
  "turnId": 1,
  "usage": {
    "inputTokens": 12500,
    "outputTokens": 3200,
    "cacheReadTokens": 8000,
    "cacheWriteTokens": 4500
  }
}

// Agent 结束（正常完成）
{
  "type": "agent_end",
  "sessionId": "task-abc123",
  "finalOutput": "## 完整报告\n...",
  "totalUsage": { "inputTokens": 45000, "outputTokens": 12000, "cacheReadTokens": 30000 },
  "totalDurationMs": 85000,
  "turnsCount": 3
}

// 错误事件（非致命，agent 可能自行恢复）
{ "type": "error", "code": "rate_limit", "message": "429 Too Many Requests", "retryable": true }

// 致命错误（agent 退出）
{ "type": "fatal", "code": "context_overflow", "message": "Prompt too long", "partialOutput": "..." }
```

**事件类型枚举**：

| type | 方向 | 含义 | 分析服务处理 |
|------|------|------|-------------|
| `agent_start` | out | pi 初始化完成 | 记录开始时间 |
| `turn_start` | out | 开始新一轮对话 | — |
| `tool_call_start` | out | 开始执行工具 | Opik span 开始 |
| `tool_call_end` | out | 工具执行完成 | Opik span 结束 |
| `text_chunk` | out | 增量文本输出 | 累积最终报告 |
| `turn_end` | out | 一轮对话结束 | 累加 token 用量 |
| `agent_end` | out | 正常完成 | 提取结果、计算成本 |
| `error` | out | 可恢复错误 | 记录日志，等待 agent 自行重试 |
| `fatal` | out | 不可恢复错误 | 提取 partialOutput，标记任务失败 |

**超时处理**：

```typescript
// 分析服务侧的超时逻辑
const WORKER_TIMEOUT_MS = 600_000; // 10 min

const timeout = setTimeout(() => {
  piProcess.stdin.write(JSON.stringify({ type: "abort", sessionId }) + "\n");
  setTimeout(() => piProcess.kill("SIGKILL"), 5000); // abort 后 5s 强杀
}, WORKER_TIMEOUT_MS);

// 收到 agent_end 或 fatal 时清除超时
piProcess.stdout.on("data", (line) => {
  const event = JSON.parse(line);
  if (event.type === "agent_end" || event.type === "fatal") {
    clearTimeout(timeout);
  }
});
```

**版本兼容性**：pi RPC 协议遵循语义化版本。分析服务在 `agent_start` 事件中检查 `protocolVersion` 字段，不兼容时拒绝连接并告警。

---

## 第十四部分：Opik 可观测性与评估

### 部署

Opik self-hosted，内网已部署。

### Trace 架构（自适应粒度）

> **统一 9-point §11 的 per-node 方案 + 本文档的中粒度方案**：默认中粒度，P0 节点自动升级为细粒度。

每次分析生成一个 trace，包含以下 span 层次：

```
trace: analysis-{task_id}
  │
  │  metadata: { project, experiment, variant, symbols_count, trace_granularity }
  │
  ├── span: pre_filter (duration, repos_hit, symbols_extracted)
  │
  ├── span: worker_1 (symbol, repos, input_tokens, output_tokens, cost)
  │   │
  │   │  ── 默认中粒度（standard）──
  │   ├── span: llm_step1_diff_semantic (input_prompt, output, tokens)
  │   ├── span: llm_step3_risk_propagation (input_prompt, output, tokens)
  │   └── span: llm_step5_report_fragment (input_prompt, output, tokens)
  │   │
  │   │  ── P0 节点自动细化（detailed）──
  │   ├── span: node_analysis (node=login.py:18)
  │   │   ├── span: llm_round_1 (context=3lines, confidence=0.62)
  │   │   ├── span: llm_round_2 (context=50lines, confidence=0.81)  ← 触发：conf<0.8
  │   │   └── span: llm_round_3 (cross_validation, confidence=0.89)
  │   └── artifact: tool_calls_detail（完整工具调用日志）
  │
  ├── span: worker_2 ... (同上)
  ├── span: merge (duration, conflicts_count, nodes_merged)
  └── span: reporter (input_tokens, output_tokens, cost)
```

**粒度策略**：

| 模式 | span 数/分析 | 触发条件 | 适用场景 |
|------|-------------|---------|---------|
| `standard` | ~15-30 | 默认 | 正常分析，低 Opik 开销 |
| `detailed` | ~50-100 | P0 节点产出时自动切换 | 误判追溯、自进化 evidence |
| `always_detailed` | ~50-100 | 手动配置 `trace_granularity: "detailed"` | debug 模式 |

**P0 细化记录**：每个被标为 P0 的节点自动产生 per-node span，其下挂各轮 LLM 调用子 span（动态轮次，置信度 < 0.8 自动追加）。这样 Opik 中可以直接看到每个 P0 节点用了几轮验证、各轮置信度走势，误判时可追溯到具体轮次。

### 评估指标

| 指标 | 公式 | 说明 |
|------|------|------|
| P0 精确率 | TP / (TP + FP) | 标了 P0 的有多少真的是高风险 |
| P0 召回率 | TP / (TP + FN) | 实际高风险的有多少被标了 P0 |
| 调用链覆盖率 | found / known | 找到了多少已知调用者 |
| 误报率 | FP / total | P0 误报比例 |
| 测试建议采纳率 | adopted / suggested | 测试建议有多少被执行 |

### Ground Truth 来源（四种组合）

| 来源 | 时机 | 集成方式 |
|------|------|---------|
| **人工标注** | 用户看完报告后 | `POST /api/feedback/{task_id}` |
| **历史验证** | PR 合并后 7 天 | CronJob 检查已分析 PR 的线上表现 |
| **回归测试** | 测试执行后 | 检查建议的测试是否发现 bug |
| **LLM-as-Judge** | 分析后即时 | 用强模型评估报告质量（抽样 10%） |

### A/B 测试

当自进化系统生成新版 prompt/规则时，通过 A/B 测试验证效果：

```yaml
# /config/experiments.yml
experiments:
  - name: "risk_rule_v2"
    description: "优化 Python is→== 变更的风险判定逻辑"
    treatment_ratio: 0.10              # 10% 流量
    artifacts:
      treatment:
        skill: "cross-repo-analysis-v2"
        risk_rules: "risk_rules_v2.yml"
      control:
        skill: "cross-repo-analysis"
        risk_rules: "risk_rules.yml"
    metrics: ["p0_precision", "p0_recall", "coverage"]
    auto_promote_threshold: 0.05       # 提升 5% 自动全量
    auto_rollback_threshold: -0.05     # 下降 5% 自动回滚
    max_duration_days: 21
```

分析服务路由层用 `hash(task_id) % 100` 分组，Opik trace 打标签 `experiment + variant`，每周 evaluation job 对比两组指标。

---

## 第十五部分：自进化系统

### 进化循环

```
日常分析执行 → Opik trace + 用户反馈
       ↓
Evidence 积累（误判 case、遗漏、用户反馈、线上事故）
       ↓ 每周触发
进化分析（LLM 分析 evidence，生成改进建议）
       ↓
人工审核（像 PR review 一样审核进化建议）
       ↓ 批准
A/B 测试（10% 流量验证，2-3 周）
       ↓ Opik evaluate 对比
全量上线 或 回滚
```

### 五个进化对象

| 进化对象 | Evidence 来源 | 进化方式 |
|---------|-------------|---------|
| **Skill prompt** | Opik trace 中 LLM 误判的 input/output | 调整指令、增加 few-shot example |
| **风险判定规则** | 误报/漏报统计 | 调整规则权重、新增规则 |
| **AGENTS.md 语义层** | 分析发现新的高风险模块/调用关系 | 自动追加（热区→温区→冷区） |
| **工具规则模板** | 遗漏的调用者 | 新增 ast-grep / grep 搜索模式 |
| **Project Config** | 发现新的 HTTP 框架/MQ topic | 更新 runtime_calls 配置 |

### 紧急自动降级

连续 3 次同类误判时不等人工审核，自动降级：
- 该规则的判定结果标记为"待确认"
- 报告中标注："⚠️ 该判定基于近期准确率较低的规则，建议人工确认"
- Opik 记录 emergency_degradation 事件
- 降级范围仅限输出标注（不影响 A/B 实验路由和评估指标），进程重启后自动清除

### AGENTS.md 语义层正确性验证

LLM 生成的语义层可能包含幻觉（不存在的调用关系），需要自动化验证：

```typescript
async function validateSemanticLayer(repo: string, semanticMd: string): Promise<ValidationResult> {
  const issues: Issue[] = [];

  // 1. 验证声明的 API endpoint handler 是否真实存在
  for (const api of parseApis(semanticMd)) {
    const exists = await fileContainsSymbol(repo, api.handler_file, api.handler_function);
    if (!exists) issues.push({ type: "phantom_api", detail: api });
  }

  // 2. 验证声明的 exports 是否真实存在
  for (const exp of parseExports(semanticMd)) {
    const exists = await astGrepCheck(repo, exp.symbol);
    if (!exists) issues.push({ type: "phantom_export", detail: exp });
  }

  // 3. 验证声明的跨仓调用关系（抽样验证 20%）
  for (const dep of sampleDeps(parseDeps(semanticMd), 0.2)) {
    const confirmed = await gitGrepInRepo(dep.target_repo, dep.endpoint_or_symbol);
    if (!confirmed) issues.push({ type: "unconfirmed_dep", detail: dep });
  }

  return { valid: issues.length === 0, issues, confidence: 1 - issues.length / totalChecks };
}
```

**集成到语义层刷新流程**：每周刷新 CronJob 在 LLM 生成后执行验证；验证不通过时保留旧版本并发送告警。零 LLM 成本（纯确定性检查）。

### Ground Truth 偏差防御

**问题**：FP 反馈门槛低（看到标红点"不对"即可），FN 反馈门槛高（需要用户主动发现遗漏并报告）。如果不加干预，evidence 中 FP 占比会远高于真实分布 → 系统越来越保守 → 召回率下降。

**防御措施**：

1. **主动采样验证**：每周从标记为 P2/P3 的节点中随机抽 10 个，用强模型独立评估"是否实际应该标更高风险"，补充 FN evidence。

2. **偏差指标监控**：
   - FP/FN 比值长期 > 5:1 时告警（正常应 ~2:1）
   - P0 数量趋势持续下降超过 3 周时告警（可能是过度保守）

3. **历史验证权重加成**：来源为"PR 合并后 7 天发现 incident"的 FN evidence 权重 ×3（比人工标注更可靠）。

4. **进化建议双向约束**：每次进化分析必须同时输出"precision 改进建议"和"recall 改进建议"。不允许只降低某类风险的标注（必须同时说明对召回率的影响）。

### Session-End 微反馈（per-analysis 确定性改进）

自进化的周周期（做梦）适合需要 LLM + 人工审核的改进（风险规则调整、Skill prompt 重写）。但有一类改进是**确定性的**——工具已验证结果、不经过 LLM 推理、零幻觉风险——应该在每次分析结束后立即生效，不等周末。

**触发时机**：分析服务收到 pi worker 的 `agent_end` 事件后，执行以下确定性检查（Node.js 代码，零 LLM 成本）：

**1. 新跨仓调用关系发现 → 实时写入 AGENTS.md**

```typescript
async function sessionEndHook_newDependencies(
  analysisResult: AnalysisResult,
  agentsMdIndex: AgentsMdIndex
): Promise<void> {
  for (const node of analysisResult.callTreeNodes) {
    if (node.repo === analysisResult.changedRepo) continue; // 跳过源仓

    const key = `${analysisResult.changedRepo} → ${node.repo}`;
    const knownDeps = agentsMdIndex.getCrossRepoDeps(analysisResult.changedRepo);

    if (!knownDeps.has(key)) {
      // 确定性追加：ast-grep/grep 已验证此调用关系存在
      await agentsMdIndex.appendDependency(analysisResult.changedRepo, {
        target: node.repo,
        via: node.callType,           // "http_api" | "mq_event" | "direct_call"
        endpoint: node.endpoint,       // "/api/verify" 或 topic name
        discoveredBy: analysisResult.taskId,
        confidence: "tool_verified",   // 非 LLM 推断
        timestamp: new Date().toISOString(),
      });
    }
  }
}
```

**效果**：首次分析发现 `auth-service → billing-php (HTTP /api/charge)` 后，后续分析在预筛阶段就能直接命中 billing-php，无需再等 grep 重新发现。

**2. 新搜索模式发现 → 记录待审核**

```typescript
async function sessionEndHook_newPatterns(
  preFilterResult: PreFilterResult,
  fineFilterResult: Set<string>
): Promise<void> {
  // git grep 粗筛命中但 ast-grep 精筛未命中的仓库 = ast-grep 规则有盲区
  const blindSpots = setDifference(preFilterResult.coarseHits, fineFilterResult);

  for (const repo of blindSpots) {
    // 不自动修改规则（需人工判断是否是误报），只记录
    await appendPendingRuleAddition({
      repo,
      symbol: preFilterResult.symbols,
      hitLayer: preFilterResult.getHitLayer(repo), // "http_endpoint" | "mq_topic" | "config_ref"
      suggestedPattern: preFilterResult.getGrepPattern(repo),
      taskId: preFilterResult.taskId,
    });
  }
}
```

**效果**：积累 ast-grep 规则改进线索。DRI 定期审核 `pending-rule-additions.json`，确认后追加到规则模板。

**3. 对比：周周期 vs 实时**

| 改进类型 | 节奏 | 原因 |
|---------|------|------|
| 新跨仓调用关系写入 AGENTS.md | **实时** | 工具已验证，确定性，零风险 |
| 新搜索模式线索记录 | **实时记录，人工审核** | 需要确认不是误报 |
| 风险判定规则调整 | 周周期 + A/B | 需要 LLM 分析 + 统计验证 |
| Skill prompt 修改 | 季度 + 人工 | 需要理解模型能力变化 |

### 配置审查节奏

系统配置不是 set-and-forget。LLM 能力提升、业务变化、新框架引入都可能使现有配置变成瓶颈。参考 Anthropic 的建议（每 3-6 个月完整审查），定义以下审查节奏：

| 审查对象 | 触发条件 | 审查者 | 核心问题 |
|---------|---------|--------|---------|
| **Skill prompt**（5 步协议） | 每季度 / LLM 换代 | DRI | 是否有多余约束？模型已能自主处理的步骤？ |
| **风险判定规则** | A/B promote 后 30 天 | 自进化自动 + DRI 确认 | 全量后精确率/召回率是否稳定？ |
| **ast-grep 规则模板** | 漏报率 >5% 时 / 每季度 | 开发者 | 新框架/新调用模式是否已覆盖？ |
| **Project Config** | 新仓库加入时 | DRI | 仓库列表、internal_packages、runtime_calls 完整？ |
| **AGENTS.md 语义层** | stale_warning_after_days: 30 | 索引服务自动 | commit hash 落后 + 新增未记录 API？ |
| **SLA 与超时配置** | 每月 | DRI | P95 是否在目标内？需要调整超时/并发？ |
| **成本趋势** | 月成本环比 >30% 增长 | DRI | 是否有异常消耗？缓存失效？无效重试？ |

**审查输出**：每次审查后输出一份简短报告（5-10 行），记录"保持现状"或"需要调整 X"，归档到 `/config/audit-log/`。

**典型过期配置示例**：

| 当初为什么写 | 何时该删除 |
|------------|-----------|
| "先检查 jq 'length'，超过 200 条则分仓" | context window 扩大到 200K+ 后，200 条不再是瓶颈 |
| "Step 3 启用 thinking budget=8000" | 新模型 reasoning 能力提升后，adaptive 模式可能更好 |
| "MAX_FANOUT_PER_LAYER = 20" | 如果 LLM 能处理更多节点且精度不降，可以放宽 |
| "budget_balanced 模式用 haiku" | 新一代 haiku 可能已接近旧 sonnet 水平，重新评估分档 |

### 系统维护角色（DRI）

系统建设完成后需要持续维护。没有明确的 DRI（直接责任人），配置会逐渐腐化、Ground Truth 积累不够、告警无人响应。

**角色定义**：

```
职位：DeepInsight 系统 DRI
定位：半架构师半 SRE
工作量：0.2-0.3 FTE（每周 8-12h）
适合人选：了解多仓架构的高级后端工程师
```

**职责矩阵**：

| 职责 | 频率 | 具体动作 |
|------|------|---------|
| 自进化建议审核 | 每周 ~1h | Review 做梦产出的改进建议，approve/reject（像 PR review） |
| Opik 面板巡检 | 每周 ~30min | 检查精确率/召回率趋势、成本异常、缓存命中率 |
| Ground Truth 推动 | 持续 | 催各仓库负责人完成快速标注（✅/❌/🤷） |
| 告警响应 | on-call | LLM 降级、队列积压、成功率下降 |
| 配置审查 | 每季度 | 执行上方审查节奏表 |
| 新项目 onboarding | 按需 | 帮新团队写 Project Config + 首次语义层审核 |
| A/B 实验决策 | 每 2-3 周 | 查看实验数据，决定 promote / rollback / 延长 |
| pending-rule-additions 审核 | 每周 | 审核 Session-End hook 积累的规则改进线索 |

**交接时间线**：

| 阶段 | DRI 归属 | 原因 |
|------|---------|------|
| Phase 1-2（建设期） | 建设者自任 | 对系统最了解 |
| Phase 3（稳定化） | 正式交接 | 写交接文档 + 双人 shadow 2 周 |
| Phase 4+（稳态） | 运维角色 | 建设者转为顾问（季度审查时参与） |

**DRI 的判断标准（何时该介入 vs 让系统自治）**：

| 信号 | 系统自治 | DRI 介入 |
|------|---------|---------|
| 单次误报 | 记录 evidence，等周末做梦 | — |
| 连续 3 次同类误报 | 紧急降级（自动） | 收到告警，确认是否需要手动禁用规则 |
| A/B 实验显著优于 control | 自动 promote | — |
| A/B 实验无显著差异 21 天 | 自动终止实验 | 分析原因，决定是否重设计实验 |
| 月成本增长 >30% | — | 分析原因，可能是缓存失效或无效重试 |
| AGENTS.md stale >50 commits | 自动标记 | 协调对应团队审核语义层 |

---

## 第十六部分：多租户 / 多项目架构

### 设计原则：工具与业务数据完全分离

分析引擎是**通用能力**，不绑定任何一组代码仓。通过项目配置文件（Project Config）描述一组代码仓及其关系，同一套工具可以服务任意业务组的多仓项目。

```
┌─────────────────────────────────────────────────────────┐
│                  分析引擎（通用，不含业务知识）            │
│                                                         │
│  ┌───────────┐  ┌───────────┐  ┌───────────────────┐   │
│  │ 分析服务   │  │ 索引服务   │  │  pi agent (RPC)   │   │
│  └───────────┘  └───────────┘  └───────────────────┘   │
│        ↑              ↑                ↑                │
│        │              │                │                │
│   ┌────┴──────────────┴────────────────┴────┐           │
│   │        Project Config（项目配置）        │           │
│   └─────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────┘
        ↓                    ↓                    ↓
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  CVM 项目     │    │  另一个业务组  │    │  第三个项目   │
│  57 个仓库    │    │  20 个仓库    │    │  8 个仓库     │
│  Python 为主  │    │  Go 为主      │    │  Java         │
└──────────────┘    └──────────────┘    └──────────────┘
```

### Project Config：一个 YAML 文件描述一个项目

每个项目（业务组）对应一份配置文件，描述该项目的所有仓库及其关系。分析引擎通过读取配置文件来理解项目结构，**引擎代码中不含任何项目特有信息**。

```yaml
# /config/projects/cvm.yml
# 一个项目的完整配置，切换项目只需切换配置文件

project:
  name: "CVM"
  description: "云虚拟机管理平台"

# ── 仓库清单 ──
repos:
  - name: "cvm-api"
    url: "https://git.woa.com/cvm/cvm-api.git"
    language: "python"
    role: "entry_point"             # 入口模块，风险最高
    tags: ["api", "public-facing"]
  - name: "cxm-api"
    url: "https://git.woa.com/cvm/cxm-api.git"
    language: "python"
    role: "entry_point"
    tags: ["api", "public-facing"]
  - name: "auth-service"
    url: "https://git.woa.com/cvm/auth-service.git"
    language: "python"
    role: "shared_lib"              # 共享库，被多仓依赖
    tags: ["auth", "security"]
  - name: "billing-php"
    url: "https://git.woa.com/cvm/billing.git"
    language: "php"
    tags: ["payment"]
  - name: "monitor-agent"
    url: "https://git.woa.com/cvm/monitor-agent.git"
    language: "go"
    tags: ["monitoring"]
  # ... 其余 52 个仓库

# ── 架构知识源 ──
knowledge_base:
  repo: "https://git.woa.com/cvm/ai_docs.git"
  # 哪些文档用于语义层生成（可选，不配则全部扫描）
  paths:
    - "architecture/"
    - "service-topology.md"

# ── 内部包映射（人工维护） ──
internal_packages:
  prefixes:
    - prefix: "cvm_"
      repos: ["cvm-api", "cvm-core", "cvm-utils"]
    - prefix: "cxm_"
      repos: ["cxm-api", "cxm-core"]
  explicit:
    - package: "auth_service"
      repo: "auth-service"
    - package: "common_utils"
      repo: "shared-lib"

# ── 高风险目录模式（通用 + 项目特有） ──
risk_patterns:
  high_risk_dirs:
    - "*/auth/*"
    - "*/payment/*"
    - "*/security/*"
    - "*/billing/*"
  api_dirs:
    - "*/api/*"
    - "*/views/*"
    - "*/routes/*"
    - "*/controllers/*"

# ── 运行时调用追踪配置 ──
runtime_calls:
  http:
    # 框架特征：如何识别该项目的 HTTP 框架
    framework_patterns:
      - "ServiceClient"
      - "api_client"
      - "requests.get"
      - "httpx.AsyncClient"
    # 路由定义特征：如何识别 endpoint 定义
    route_patterns:
      - "@app.route"
      - "@router."
      - "urlpatterns"
      - "path("
  mq:
    type: "rabbitmq"
    library: "pika"
    # grep 模式：如何找到生产者和消费者
    producer_patterns:
      - "basic_publish"
      - "channel.publish"
    consumer_patterns:
      - "basic_consume"
      - "queue_bind"
    # exchange/routing_key 的命名规律（可选，提高匹配精度）
    naming_convention: "{service}.{entity}.{action}"  # 如 auth.token.verified

# ── LLM 配置 ──
llm:
  analysis:
    base_url: "https://api.example.com/v1"
    api_key_env: "LLM_ANALYSIS_API_KEY"
    model: "gpt-4o"
  utility:
    base_url: "https://api.example.com/v1"
    api_key_env: "LLM_UTILITY_API_KEY"
    model: "gpt-4o-mini"

# ── 输出配置 ──
output:
  include_test_plan: true          # 是否生成测试场景
  include_oracle: true             # 是否生成观察点
  call_tree_depth: 2               # 调用链展开层数
  language: "zh-CN"                # 报告语言
```

### 另一个业务组的配置示例

```yaml
# /config/projects/data-platform.yml
project:
  name: "数据平台"
  description: "大数据处理与分析平台"

repos:
  - name: "dp-ingestion"
    url: "https://git.woa.com/data-platform/ingestion.git"
    language: "go"
    role: "entry_point"
  - name: "dp-transform"
    url: "https://git.woa.com/data-platform/transform.git"
    language: "go"
    role: "core"
  - name: "dp-scheduler"
    url: "https://git.woa.com/data-platform/scheduler.git"
    language: "python"
  # ... 其余仓库

knowledge_base:
  repo: "https://git.woa.com/data-platform/docs.git"

internal_packages:
  prefixes:
    - prefix: "dp_"
      repos: ["dp-ingestion", "dp-transform", "dp-scheduler"]

runtime_calls:
  http:
    framework_patterns:
      - "grpc.Dial"        # Go gRPC
      - "pb.NewClient"
    route_patterns:
      - "RegisterService"
      - "pb.Register"
  mq:
    type: "kafka"
    library: "confluent_kafka"
    producer_patterns:
      - "producer.produce"
      - "producer.send"
    consumer_patterns:
      - "consumer.subscribe"
      - "consumer.poll"

llm:
  analysis:
    base_url: "https://api.other-provider.com/v1"
    api_key_env: "DP_LLM_KEY"
    model: "claude-sonnet-4-20250514"
  utility:
    base_url: "https://api.other-provider.com/v1"
    api_key_env: "DP_LLM_KEY"
    model: "claude-haiku-4-20250514"
```

### 引擎如何读取配置

```
API 请求：
  POST /api/analyze
  {
    "project": "cvm",            ← 指定项目名
    "changes": [
      { "repo": "auth-service", "branch": "feature/x", "base": "main" }
    ]
  }

分析服务处理流程：
  1. 读取 /config/projects/cvm.yml
  2. 从配置中获取 repo URL → clone/fetch
  3. 从配置中获取 internal_packages → 知道 auth_service 被谁依赖
  4. 从配置中获取 runtime_calls → 知道用什么模式 grep HTTP/MQ
  5. 从配置中获取 llm → 知道用什么 provider/model
  6. 从配置中获取 risk_patterns → 传给 pi agent 作为分析上下文
  7. 启动 pi RPC 执行分析
```

### 引擎代码中不含任何硬编码

| 以前（硬编码） | 现在（配置驱动） |
|---|---|
| `for repo in /workspace/repo-*` | 从 `project.repos` 读取仓库列表 |
| `grep -rn "requests.post"` | 从 `runtime_calls.http.framework_patterns` 读取 grep 模式 |
| `--lang python` | 从 `repo.language` 读取，自动选择 ast-grep 语言 |
| `OPENAI_BASE_URL=...` | 从 `llm.analysis.base_url` 读取 |
| 入口模块 cvm-api | 从 `repos[].role == "entry_point"` 识别 |
| exchange 命名规律 | 从 `runtime_calls.mq.naming_convention` 读取 |

### AGENTS.md 也按项目隔离

```
/data/
├── projects/
│   ├── cvm/                         ← CVM 项目的所有数据
│   │   ├── repos/                   # git mirror
│   │   ├── worktrees/               # 持久 worktree
│   │   ├── index/
│   │   │   ├── agents-md/           # 57 个 AGENTS.md
│   │   │   ├── risk-history/        # 热/温/冷区
│   │   │   ├── GLOBAL_PATTERNS.md   # 跨仓风险模式
│   │   │   └── meta.json
│   │   └── ai_docs/                 # 架构知识库 clone
│   │
│   ├── data-platform/               ← 数据平台项目的所有数据
│   │   ├── repos/
│   │   ├── worktrees/
│   │   ├── index/
│   │   └── docs/
│   │
│   └── ...                          ← 其他业务组
│
└── config/
    └── projects/
        ├── cvm.yml
        ├── data-platform.yml
        └── ...
```

### 新业务组接入流程

```
1. 编写 /config/projects/<name>.yml（15-30 分钟）
   - 填写仓库列表 + URL
   - 填写语言、入口模块、内部包映射
   - 填写 HTTP/MQ 框架模式（从代码里看几个调用示例就能填）
   - 填写 LLM 配置

2. 触发初始化（自动，几分钟）
   - 索引服务检测到新配置 → clone 所有仓库
   - 生成 57 个 AGENTS.md 自动段

3. 首次语义层生成（LLM，2-3 小时）
   - 读取 knowledge_base + 代码扫描 → 生成语义层

4. 可用
   - POST /api/analyze { "project": "<name>", ... }
```

无需修改引擎代码，无需重新部署。

- [GitNexus](https://github.com/abhigyanpatwari/GitNexus) — 代码知识图谱 + CLI 工具集
- [ast-grep](https://github.com/ast-grep/ast-grep) — 结构化代码搜索和转换
- [stack-graphs](https://github.com/github/stack-graphs) — GitHub 精确代码导航引擎
- [code-review-graph](https://github.com/tirth8205/code-review-graph) — blast-radius 服务
- [pi agent](https://github.com/earendil-works/pi-mono) — 极简 AI 编码代理，支持 Skills + 300+ 模型 + RPC 模式
- [Agent Skills 标准](https://agentskills.io/specification) — pi 实现的 Skill 规范

---
name: deepinsight-cross-repo-analysis
description: >-
  Diff 跨仓库影响范围分析。读取 git diff 与各仓 AGENTS.md，追踪上下行调用链，
  按 priority/severity 二维矩阵评估风险，输出 cross-repo-impact/2.0 schema 报告。
  TRIGGER when: 收到 patch 输入需要做跨仓影响分析、风险评估、回归测试场景生成。
  DO NOT TRIGGER when: 单文件代码 review、纯语法/格式建议、不涉及调用链的 lint。
origin: deepinsight
tools: Read, Bash, Grep, Glob
metadata:
  version: "2.0"
  schema_version: "cross-repo-impact/2.0"
---

# DeepInsight Cross-Repo Analysis Skill

你是跨仓代码影响范围分析专家。严格按下面的 5 步流程执行分析。

---

## 核心心法（先于一切流程）

1. **成本不对称**：读代码 / `ast-grep` 验证 → 便宜；猜测 / 宣称"没有更多调用者" → 昂贵。怀疑就扫。
2. **入口为王**：找不到对外可观察入口（HTTP/调度/MQ/RPC）的风险评估都是空中楼阁。
3. **二维分桶**：`priority`（动作紧迫度）和 `severity`（影响量级）独立填写；测试覆盖度是 priority 的关键调节因子。
4. **结构 > 字符串**：所有输出走 schema，禁止用 `[ENTRY]` / emoji 等装饰文本承载语义。
5. **置信度 < 0.7 → `NEEDS_HUMAN_REVIEW`**，不要硬编 priority。
6. **分段自检防漂移**：输出 `symbols[]` 时**每写完 3-5 个 symbol 回查一次** [`output-schema.md §5`](references/output-schema.md#5-关键要求输出前必查--唯一权威清单)。长上下文 LLM 在第 5 个 symbol 之后开始字段名漂移是已观测到的失败模式（实测 18 个 symbol 跨过 3 套 schema 变体）；分段自检是唯一可靠的纠正窗口，等全部输出完再总检为时已晚。

---

## 输入

- diff 文件（patch 格式）
- 相关仓库的 AGENTS.md（由分析服务注入上下文）
- GLOBAL_PATTERNS.md（历史风险传播路径）
- **可选**：graphify 知识库（按需检索的背景语料）

---

## 可用工具扩展

分析服务已预装 4 个扩展 + graphify 路由表。**调用约束、单次成本、任务上限**详见
[`references/domain-routing.md`](references/domain-routing.md)：

| 扩展 | 适用时机 |
|---|---|
| **graphify 知识库** | diff + AGENTS.md 不够用时按 keywords 选**一个**库查（≤ 3 次/任务） |
| **context-mode** | 仓库 > 10 或上下文紧张，替代整段 AGENTS.md 塞入 |
| **pi-hermes-memory** | Step 3 前查历史 P0/P1 同符号路径；Step 5 后写回新发现 |
| **pi-web-access** | 上述都无法回答时，按需 `web_fetch` 外部文档 |
| **pi-subagents** | ≥ 3 个无依赖符号时并行 Step 2，主 agent 串 Step 3–5 |

---

## 分析步骤

### Step 0：上下文体检（30 秒，必做）

动手前先核对：

| 必备资源 | 缺失时的行为 |
|---|---|
| diff 文件存在且可读 | 报错并停止 |
| 相关仓 AGENTS.md 已注入 | 在 `unanalyzable[]` 写 `category: missing_repo` |
| 仓库 workspace 可访问（`<repos_root>/<repo>/`） | 同上 |
| graphify 知识库路由表 | 若声明则记下 graph 路径与 keywords，按需调用 |

完成后在 reasoning 中显式声明："上下文齐备" 或 "缺 X，已记入 unanalyzable"。

---

### Step 1：解读 diff 语义，判断初始风险

提取**所有**变更符号（函数名、类名、常量名），对每个变更判断类型：

| diff 类型 | 风险等级 | 说明 |
|---|---|---|
| `is` 改 `==` | 极高 | 身份比较→值比较，None/False 可能绕过 |
| 返回类型变化（去掉 Optional、新增 None 路径） | 高 | 调用方未做空值处理时 crash |
| 异常处理删除或范围缩小 | 高 | 错误向上传播 |
| `async` 改 `sync` | 中 | 阻塞 event loop |
| 超时值变更 | 中 | 级联等待 |
| 注释/格式 | 低 | 无运行时影响 |

详细规则见 [`references/risk-rules.md`](references/risk-rules.md)。

---

### Step 2：构建完整跨仓上行调用链

对每个变更符号：

a. 在目标仓库中搜索调用点（优先 grep，大量结果时用 ast-grep）：

   ```bash
   grep -rn "<symbol>" --include="*.py" <repos_root>/目标仓库/
   sg scan --rule /tmp/impact-<symbol>.yml --json <repos_root>/
   ```

b. **追踪运行时调用链**（关键！grep/ast-grep 无法发现的间接调用）：
   - 从 AGENTS.md 中读取 MQ 消息模式（哪些仓库 publish/consume 相关 topic）
   - 从 AGENTS.md 中读取 HTTP 路由（哪些仓库调用了变更仓库的接口）
   - 追踪从入口仓库（如 `cvm_api`/`cxm_api`）到变更符号的完整链路
   - 即使变更符号不被入口仓库直接 import，也要通过 MQ/HTTP/框架调度链路追踪

c. 对第 1 层结果中的调用函数名，重复步骤 a 获取第 2 层（间接调用者）。

**必须回答的问题**：从入口仓库的哪个对外 API 出发，经过哪些中间仓库/模块，最终到达变更符号？完整写出这条链路。

> **入口节点必须用结构化字段标记**（不是文本）：
> - `is_entry: true` — 对外可观察入口（HTTP API / 调度任务 / MQ 消费者头 / RPC 方法）
> - `entry_kind: "http_api" | "scheduler_job" | "mq_consumer" | "rpc_method" | "internal_only"`
> - `entry_route: "POST /?Action=..."`（仅 `entry_kind="http_api"` 必填）
>
> **禁止**在 `domain_context` 写 `[ENTRY]` 字符串作为标记。

---

### Step 2b：构建下行契约链（向下游 callee 追踪）

上行链回答"谁调用我"。下行链回答"我自己调用了谁，变更后是否仍满足下游契约？"

对每个变更符号：

a. grep 出变更点函数体内**新增/修改**的下游调用（被调函数）。

b. 对每个下游调用，判断变更是否破坏对它的契约：
   - **param**：传参的类型/数量/语义是否仍匹配下游签名
   - **schema**：传给下游(或 MQ/HTTP)的数据结构是否仍匹配下游反序列化预期
   - **transaction**：调用是否仍在正确的事务/锁边界内（如 async 改 sync、commit 时机变化）
   - 其它记为 `other`

c. **追踪终止条件**（每条路径独立判定，满足任一即停）：
   1. callee 属于 [SINK] 模块 → 在 `sink` 字段写入 `{type, repo, priority, severity}` 并停（收敛成功）
   2. callee 无下游调用（叶子）→ 自然停，`sink: null`（穷尽，与深度无关）
   3. 深度 ≥ 2 **且该路径未朝 [SINK] 收敛** → 剪枝停，`sink: null`
   4. 深度 ≥ 4（绝对护栏）→ 无条件停

   即 [SINK] 是优先收敛目标，可突破深度 2 追到（上限 4）；深度 2 仅是"既没到 sink、又判断不出朝 sink 走"时的兜底剪枝。

d. 每个下游契约项输出为 `downstream_contracts` 的一个元素。
   **下行契约项不参与 P0-P3 数值传播**，只有触达 [SINK] 的项才在 `sink` 对象内填 `priority` 与 `severity`。
   `status` 取值：`satisfied` / `uncertain` / `violated`（**不是** `ok`）。

---

### Step 3：在调用链上传播风险

对每个调用点：

**第 1 轮（默认 3 行上下文）**：
- 读取调用点 ±3 行代码
- 判断领域上下文（公网 API > 鉴权层 > 支付 > 内部工具）
- 给出风险等级 + 置信度

**条件追加（置信度 < 0.8 时）**：
- 扩展为 ±50 行上下文
- 重新判断

**最终兜底**：
- 验证后仍 < 0.7 → 标记为 `NEEDS_HUMAN_REVIEW`

---

### Step 4：检查测试覆盖

- 优先读取 `coverage/coverage-summary.json`
- fallback：检查测试文件存在性（`*_test.py` / `test_*.py` / `conftest.py`）
- 标注：`has_test` / `partial` / `no_test`

详细判定标准见 [`references/risk-rules.md`](references/risk-rules.md) §测试覆盖判定。

---

### Step 5：输出报告（cross-repo-impact/2.0 schema）

**严格按 [`references/output-schema.md`](references/output-schema.md) 输出**，
用 ` ```json ... ``` ` 包裹。所有字段名 snake_case，pipeline 自动解析、格式不对会导致结果丢失。

#### 关键约束的唯一真源

> 完整必填/可选/枚举值清单见 [`output-schema.md §5`](references/output-schema.md#5-关键要求输出前必查--唯一权威清单)（26 条必查项，覆盖顶层结构 / symbols / call_tree / risk_table / downstream_contracts / test_scenarios / 通用规则 7 个维度）。
>
> **本文档不再重复列约束**——之前重复列出导致三处真源不同步、LLM 看哪份都缺字段。
> 输出前必读 §5；每写 3-5 个 symbol 回查一次（防字段名漂移）。

最容易踩的 4 条红线（其它见 §5）：

1. `downstream_contracts[]` 字段名是 **`call_kind` + `contract_kind`**（不是 `kind` / `contract_type`）
2. `target_api.transport` 闭合 4 枚举：`cloud_api` / `vstation` / `internal_rpc` / `scheduler`（不是 `HTTP` / `http_api` / `des_pipeline`）
3. `assertions[].kind` 闭合 9 枚举（见 §4.6 表）；**禁止**生造 `http_status` / `response_field` / `context_value` 等
4. `test_scenarios[]` 必须有 `api_params` 字段（即使 `{}`）

完整字段定义、示例 JSON、必查清单：见 [`references/output-schema.md`](references/output-schema.md)。
旧字段 → 新字段：见 [`references/schema-migration.md`](references/schema-migration.md)。

---

### Step 6：生成测试验证场景

对**以下三类**触发点生成 `test_scenarios[]`：

1. 每个 P0/P1 风险项
2. 每个受影响的入口仓库 API（`call_tree[].is_entry==true`）
3. 每个触达 [SINK] 的下行契约项（`downstream_contracts[].sink != null`）

每个场景必须包含：

- `id`：`RT-NNN` 三位编号
- `risk_change_ids`：关联的 `SYM-NNN` id 数组
- `target_api`：结构化对象（`name` / `namespace` / `transport` / 可选 `route`）
- `preconditions`：环境准备（DB 数据、服务运行、配置）
- `steps`：可重现操作步骤（从对外 API 入口开始）
- `assertions[]`：每项一个 `kind`（合法 kind/channel 组合见 [output-schema §4.5](references/output-schema.md)）

完整模板与字段约束：见 [`references/output-schema.md`](references/output-schema.md) §6。

---

## 输出前自检

提交前的完整必查清单见 [`output-schema.md §5`](references/output-schema.md#5-关键要求输出前必查--唯一权威清单)（26 条，覆盖所有已观测过的偏离）。

实测最常漏的 5 条（出问题概率 > 50%，输出前**必看**）：

| # | 问题 | 若漏 → |
|---|---|---|
| 1 | `test_scenarios[]` 是否每项都有 `api_params`（即使 `{}`） | 下游 agent 直接拿空 dict 调 API，FAIL_ENV |
| 2 | `target_api.transport` 是否在 4 枚举内 | 下游路由失败，case 全降级为 manual |
| 3 | `assertions[].kind` 是否在 9 枚举内 | 自动化判定失效，case 全走 majority fallback |
| 4 | `downstream_contracts[].call_kind` + `contract_kind` 字段名是否正确 | DAG 边注入零条，依赖链分析静默失败 |
| 5 | P0/P1 `risk_table` 行 `remediation` 是否填了（不能用 domain_context 兜底） | 高风险点从 risk_areas 里消失 |

其余 21 条（顶层结构 / symbols / call_tree / 通用规则）见 §5 完整清单。

---

## 高风险目录（通用）

- `*/auth/*`, `*/payment/*`, `*/security/*` — 认证/支付/安全
- 对外 API 入口（`*/api/*`, `*/views/*`, `*/routes/*`）

---

## 优先级定义

`priority`（动作紧迫度）和 `severity`（影响量级）是**两个独立维度**，必须分别填写：

| `priority` | 触发条件 | 处置 |
|---|---|---|
| P0 阻塞 | `severity=high` 且 `test_coverage=no_test` | 必须在合并前解决 |
| P1 必修 | `severity=high` 且 `test_coverage=partial` | 补测试后回归 |
| P2 回归 | `severity=high` 且 `test_coverage=has_test`，或 `severity=medium` | 回归测试通过则可合并 |
| P3 观察 | `severity=low` | 无需特殊处置 |
| `NEEDS_HUMAN_REVIEW` | 验证后置信度 < 0.7 | 人工评估 |

`severity` 取值仅 `high` / `medium` / `low`（**不再使用** `critical`/`info`，旧 `critical` → `high`，旧 `info` → `low`）。

---

## References

- [`references/risk-rules.md`](references/risk-rules.md) — Python 高风险变更模式 + 调用类型耦合度 + 测试覆盖判定
- [`references/output-schema.md`](references/output-schema.md) — `cross-repo-impact/2.0` 完整字段定义、示例、约束
- [`references/schema-migration.md`](references/schema-migration.md) — 旧字段 → 新字段速查表
- [`references/domain-routing.md`](references/domain-routing.md) — graphify 知识库 + 4 个 MCP 扩展的调用约束
- [`scripts/scan-callers.sh`](scripts/scan-callers.sh) — 跨仓调用点扫描脚本

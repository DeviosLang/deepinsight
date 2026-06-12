# 知识库路由 & 工具扩展调用约束

> 由 [`SKILL.md`](../SKILL.md) 引用。pi 会话启动时由分析服务预装 4 个 MCP 扩展 + 多个 graphify 知识库。
> 本文档汇总它们的**适用时机**和**调用预算**，不要盲目调用。

---

## 1. graphify 知识库（按需检索）

分析服务可能在 prompt 头部声明一个或多个 graphify 知识库。
prompt 会列出每个库的 `description` 和 `keywords` 作为路由提示：

| 库名 | 典型用途 |
|---|---|
| `cvm_design_docs` | 架构决策、设计取舍、glossary |
| `cvm_domain` | 实例规格、镜像、计费等业务概念 |
| `cvm_apidocs` | 对外接口入参/返回/错误码 |
| `cvm_released_bugs` | 发布期 bug，用于风险评估 |
| `cvm_tapd_bugs` | 日常迭代 bug 与需求 |

这些是**按需检索**的背景语料，不会预先注入。若分析过程中遇到不熟悉的领域概念、
想确认架构决策原因、或评估改动对历史 bug 的影响，主动调用：

```bash
graphify query "<concept-or-question>" --graph <graph-path> --budget 1500
```

### 调用约束

- 仅在 **diff + AGENTS.md 不足以判断**时才查；常见调用链/符号搜索仍优先用 grep/ast-grep
- 每次查询消耗约 1500 token，**每个分析任务建议 ≤ 3 次**
- 按 keywords 选最相关的**一个**库，不要广撒网（同一概念多库查会浪费 token）

---

## 2. context-mode（上下文压缩）

**适用时机**：本次分析涉及仓库数量 > 10 个、或对话轮次已累积导致上下文窗口紧张时，
主动用 context-mode 的 MCP 工具替代"把整段 AGENTS.md 塞入 prompt"的做法。

```text
# 在 AGENTS.md 内容中精确检索与当前符号相关的段落
mcp__context-mode__search_knowledge_base("verify_token MQ consumer 入口仓库")

# 在隔离沙箱中运行 ast-grep / grep 命令，结果不占用主上下文
mcp__context-mode__run_code("sg scan --rule /tmp/rule.yml --json /workspace/")
```

### 调用约束

- 优先用于 AGENTS.md 检索（取代一次性加载全部内容）
- `run_code` 适合执行结果较大的扫描命令，避免输出撑爆上下文
- 每次检索约消耗 300–500 token，比全量加载节省 80% 以上

---

## 3. pi-hermes-memory（跨会话风险记忆）

**适用时机**：Step 3 传播风险时，若当前变更符号或仓库在历史分析中曾出现过高风险记录，
优先从持久记忆中读取已知模式，而不是重新推理。

```text
# 查询历史风险记录（变更符号 / 仓库名 / 风险类型）
memory_search("verify_token auth bypass")
memory_search("cvm_api payment P0")

# 分析完成后，将新发现的 P0/P1 风险写入持久记忆供后续分析复用
memory_store("cvm_api → payment-service 调用链：verify_token 改动会传播到支付入口，历史 P0")
```

### 调用约束

- 仅在 **Step 3 前**调用 `memory_search`，避免过早引入噪音
- `memory_store` 在 Step 5 报告输出后调用，**只记录 P0/P1 级别**的跨仓风险路径
- **不要把具体代码行号写入记忆**（代码会变），只记录仓库级别的风险传播路径

---

## 4. pi-web-access（外部文档获取）

**适用时机**：AGENTS.md 中引用了外部文档链接、或需要查阅某个第三方库的最新接口签名时。

```text
# 拉取外部文档页面
web_fetch("https://internal-wiki.example.com/arch/cvm-api-gateway")

# 搜索某个依赖库的 breaking change
web_search("django-rest-framework 3.15 breaking changes serializer")
```

### 调用约束

- 仅在 **diff + AGENTS.md + graphify 都无法回答**时才调用，优先用本地信息
- 每次 `web_fetch` 约消耗 500–2000 token，按需调用，**不要广撒网**

---

## 5. pi-subagents（并行符号分析）

**适用时机**：单次 diff 包含 **3 个以上相互独立的变更符号**时，可将每个符号的
Step 2（调用链构建）委托给独立子 agent 并行执行，主 agent 仅做 Step 3–5（风险合并+报告）。

```text
# 并行分析 3 个独立符号的调用链
subagent(task="分析 verify_token 的跨仓调用链，只做 Step 2，返回 callTree JSON", async=true)
subagent(task="分析 create_instance 的跨仓调用链，只做 Step 2，返回 callTree JSON", async=true)
subagent(task="分析 update_quota 的跨仓调用链，只做 Step 2，返回 callTree JSON", async=true)
# 等待三个子 agent 完成后，主 agent 合并 callTree，执行 Step 3 风险传播
```

### 调用约束

- 子 agent **只负责 Step 2**（调用链），**不做风险判断**；
  风险传播（Step 3）必须由主 agent 统一执行
- 符号之间存在调用依赖时（A 调用 B）**不要拆分**，必须串行分析
- 分析服务层已在外部做了多 worker 编排（`MAX_PARALLEL_WORKERS=6`），
  pi 内部再用 subagents 是**额外加速，不是替代**

---

## 6. 调用预算速查

| 工具 | 单次成本 | 任务上限 | 触发门槛 |
|---|---|---|---|
| `graphify query` | ~1500 token | ≤ 3 次 | diff+AGENTS.md 不够用 |
| `mcp__context-mode__search_knowledge_base` | 300–500 token | 无硬限 | 仓库 > 10 或上下文紧张 |
| `memory_search` | 低 | 仅 Step 3 前 | 历史曾出 P0/P1 同符号/仓库 |
| `memory_store` | 低 | 仅 Step 5 后 | 本次产出 P0/P1 跨仓路径 |
| `web_fetch` | 500–2000 token | 按需 | 上述都无法回答 |
| `subagent(Step 2)` | 视子任务 | 视独立符号数 | ≥ 3 个无依赖符号 |

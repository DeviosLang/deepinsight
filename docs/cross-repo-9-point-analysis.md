# DeepInsight 设计推导——Claude Code 借鉴分析与系统方案

> **文档定位**：本文档是设计推导过程，记录从 Claude Code 实现中提炼的借鉴点及对应的系统方案。
> 最终规格以 `cross-repo-impact-analysis.md`（DeepInsight 规格文档）为准，本文档作为设计决策的推理依据保留。

---

## Part A: Claude Code 9 点借鉴分析（§1-§9）

### 总览：借鉴优先级

| # | 系统 | 借鉴价值 | 优先级 | 理由 |
|---|------|---------|--------|------|
| 1 | Think 模式 | 🟡 中 | Phase 2 | 分析复杂 diff 时启用深度推理，提升准确性 |
| 2 | Token 成本跟踪 | 🔴 高 | Phase 1 | 多项目共用，必须精确计费 |
| 3 | 上下文管理 | 🔴 高 | Phase 1 | 57 仓分析容易撑爆上下文窗口 |
| 4 | 成本优化策略 | 🔴 高 | Phase 1 | 每次分析消耗大量 token，必须有 cache 策略 |
| 5 | 错误恢复与容错 | 🔴 高 | Phase 1 | K8s 服务必须稳定，不能因 API 限流挂掉 |
| 6 | Prompt 设计 | 🟡 中 | Phase 2 | 当前 Skill 模板够用，后续优化时参考 |
| 7 | 多 Agent 协调 | 🟡 中 | Phase 2 | MVP 不需要；Phase 2 多符号并行分析时成为核心性能杠杆 |
| 8 | 状态管理 | 🟢 低 | Phase 3 | 我们是无状态 API 服务，不需要 React 状态 |
| 9 | 团队记忆 | 🟡 中 | Phase 3 | 热/温/冷风险记录 + GLOBAL_PATTERNS 已覆盖核心需求 |

---

## 1. Think 模式

### Claude Code 的实现

- **三级推理**：Disabled / Enabled（固定 budget） / Adaptive（模型自决）
- **多层门控**：Build-time feature flag → 模型能力检测 → 用户设置 → 关键词触发（"ultrathink"）
- **API 约束处理**：`budget_tokens < max_tokens`、强制 temperature=1

### 对跨仓分析的借鉴

**采纳思路**：为分析的不同 Step 配置不同推理深度

```yaml
# Project Config 中的 thinking 配置
thinking:
  step1_diff_semantic: "adaptive"    # diff 语义解读：让模型自己决定
  step3_risk_propagation:            # 风险传播：固定 budget（核心准确性）
    mode: "enabled"
    budget_tokens: 8000
  step5_report: "disabled"           # 报告生成：不需要深度推理
  agents_md_generation: "disabled"   # AGENTS.md 生成：结构化任务
```

**价值**：Step 3 风险传播是准确性关键——判断一个调用点是"公网 API 入口"还是"内部工具"需要深度推理。启用 thinking 可以显著提升判断准确性。

**实施成本**：低。pi 通过 OpenAI 兼容协议，大多数强模型支持类似的 reasoning 参数。

---

## 2. Token 成本跟踪与上报

> ⚠️ **接口定义已被 `cross-repo-impact-analysis.md` §7「成本追踪」覆盖。**
> 以下 `AnalysisCost` 接口为早期草案。规格文档的版本按 step 分拆（pre_filter / workers / merge / reporter），更贴合实际架构。
> 本段的 Claude Code 分析和借鉴思路仍有效，实施时接口以规格文档为准。

### Claude Code 的实现

- **7 类 token 分类追踪**：input / output / cache_read / cache_write / ephemeral / web_search / server_tool
- **三层累积**：per-API-call（overwrite 语义）→ per-message（additive）→ per-session（persistent）
- **per-model 分拆**：按模型短名聚合，支持多模型混用
- **成本公式**：`(tokens / 1M) × price_per_M`
- **Session 持久化**：进程退出时保存到项目 config，resume 时恢复
- **OTel 集成**：Counter/Gauge 上报到可观测性系统

### 对跨仓分析的借鉴

**必须采纳**。多项目共用一套引擎，每个项目独立计费。

```typescript
// 分析服务层的成本追踪
interface AnalysisCost {
  task_id: string;
  project: string;                    // "cvm" | "data-platform" | ...
  costs: {
    analysis: {                       // Step 1-5 主分析
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;       // 关键：衡量 cache 效果
      model: string;
      cost_usd: number;
    };
    test_plan: {                       // 测试场景生成
      input_tokens: number;
      output_tokens: number;
      model: string;
      cost_usd: number;
    };
  };
  total_cost_usd: number;
  duration_ms: number;
}
```

**关键设计决策**：

| Claude Code 做法 | 我们的做法 | 理由 |
|---|---|---|
| per-session 持久化到文件 | per-task 写入数据库/日志 | 我们是 API 服务，每次分析是独立任务 |
| OTel Counter | Prometheus metrics | K8s 生态标配 |
| 模型短名聚合 | 按 project + model 聚合 | 多项目需要分开计费 |
| cache_read 追踪 | 同样追踪 | 衡量 Prompt Cache 效果的核心指标 |

---

## 3. 上下文管理（历史对话维护/上下文压缩/消息去重）

### Claude Code 的实现

**三层压缩架构**：

| 层级 | 名称 | 延迟 | 触发条件 | 效果 |
|------|------|------|---------|------|
| Tier 1 | Microcompact | ~0.1s | 10+ tool results 累积 | 清除旧工具输出 |
| Tier 2 | Session Memory | ~1-2s | 有预计算摘要可用时 | 用摘要替代原文 |
| Tier 3 | Full Compact | ~10-30s | token 使用率 > 83% | 全量 LLM 总结 |

**关键机制**：
- **自动触发**：`effectiveWindow - 13K buffer = threshold`
- **Circuit Breaker**：3 次连续失败后停止尝试
- **PTL Retry**：压缩请求本身太长时，迭代删除最旧的 API round
- **UUID 消息去重**：通过 parentUuid 链接防止压缩后重复注入
- **图片剥离**：压缩前移除图片块（节省 token，不影响摘要质量）

### 对跨仓分析的借鉴

**高度相关**。57 仓分析的上下文消耗模式（以下为规划估算，实际值需实测）：

```
Step 0: 读取 AGENTS.md（~20 个仓库 × ~2K token = 40K）
Step 2: ast-grep 输出（可能 50-200 个调用点，每个 ~100 token = 5-20K）
Step 3: 读取调用点上下文（每个 ~500 token × 50 个 = 25K）
Step 4: coverage 数据
总计: 可能达到 100-150K token → 接近模型限制
```

**采纳的设计**：

1. **Tool Result 清理**（类似 Microcompact）：
   - ast-grep 的 JSON 输出在分析完一个符号后不再需要
   - Step 2 完成后，清除 Step 2 的原始工具输出，只保留提取的结论
   - 通过 pi 的 `transformContext` 钩子实现

2. **分段分析 + 中间总结**（类似 Full Compact 的思路）：
   - 不一次分析所有 57 仓，分批：先扫描缩小范围 → 再深度分析命中仓库
   - 每批完成后输出中间结论，清除原始数据

3. **AGENTS.md 按需加载**（类似 Session Memory 的渐进式加载）：
   - 不一次注入 57 个 AGENTS.md
   - 先注入全局 AGENTS.md + 直接变更的仓库 AGENTS.md
   - 发现跨仓影响后，按需 `read` 新仓库的 AGENTS.md

**不采纳的设计**：
- UUID 消息去重：我们每次分析是全新会话，没有跨会话消息复用问题
- 自动压缩的 Circuit Breaker：分析是一次性任务，不存在"连续多次压缩"场景

---

## 4. 成本优化策略

### Claude Code 的实现

- **Prompt Cache（核心策略）**：1h TTL、session-latched 资格判定、cache_control 精确放置
- **Cache Break Detection**：监控 cache_read 下降，定位原因（system prompt 变化？tool schema 变化？）
- **Session-Stable Latching**：首次判定后锁定，避免中途翻转导致 cache bust
- **Fork Cache Sharing**：子 agent 重用父 agent 的 cache prefix
- **Microcompact 不破坏 cache**：用 cache_edits API 删除内容而不修改消息体
- **Poor Mode**：跳过非核心功能（extract_memories、prompt_suggestion）
- **Token Budget**：用户指定上限后，检测递减收益自动停止

### 对跨仓分析的借鉴

**高度相关**。分析服务的成本优化机会：

| 策略 | 适用场景 | 预期节省 |
|------|---------|---------|
| **System Prompt Cache** | 同项目多次分析共享 system prompt + AGENTS.md | 30-50% input token |
| **工具结果分级** | 高风险节点保留完整上下文，低风险节点只保留摘要 | 20-30% |
| **按需加载 AGENTS.md** | 只加载受影响仓库的 AGENTS.md | 40-60%（57 仓 → 实际命中 5-10 仓） |
| **ast-grep 预筛** | 分析服务层先跑 ast-grep（不消耗 LLM token），只把命中结果喂给 LLM | 50%+（把 57 仓过滤到 5-10 仓）|
| **Diminishing Returns 检测** | 多层展开时，如果第 3 层几乎无新发现则停止 | 10-20% |

**具体实施**：

```typescript
// 分析服务层的成本优化（在调用 pi 之前做）
class CostOptimizer {
  /** 在 LLM 调用之前用确定性工具缩小范围（零 LLM 成本） */
  async preFilter(diff: Diff, projectConfig: ProjectConfig): Promise<PreFilterResult> {
    // 1. 解析 diff 提取变更的函数名
    const symbols = parseDiffSymbols(diff);

    // 2. ast-grep 扫描命中的仓库（bash，不是 LLM）
    const hitRepos = new Set<string>();
    for (const symbol of symbols) {
      const hits = await runAstGrep(symbol, projectConfig.repos);
      for (const repo of hits.keys()) hitRepos.add(repo);
    }

    // 3. 只加载命中仓库的 AGENTS.md（从 57 个过滤到 5-10 个）
    const relevantAgentsMd = await loadAgentsMd(hitRepos);

    return {
      symbols,
      hitRepos,
      agentsMd: relevantAgentsMd,
      // LLM 只需要处理这个精简后的数据
    };
  }
}
```

---

## 5. 错误恢复与容错

### Claude Code 的实现

| 机制 | 实现 | 效果 |
|------|------|------|
| **Exponential Backoff** | 500ms × 2^n，±25% jitter，max 32s | 避免 thundering herd |
| **错误分类** | Transient（429/529/连接错误）→ 重试；Auth（401/403）→ 刷新 token | 精确处理不同故障 |
| **PTL Recovery** | 解析错误中的 token 数字，自动缩减 max_tokens | 上下文溢出时自动适应 |
| **Circuit Breaker** | 3 次连续失败后停止 autocompact | 防止无限循环浪费 API |
| **Model Fallback** | 3 次 529 后降级 Opus → Sonnet | 保证可用性 |
| **Fast Mode Cooldown** | 限流时切换到标准速度 30 分钟 | 平滑降级 |
| **Persistent Retry** | 无人值守模式：无限重试 + 30s heartbeat | 远程/CI 场景不丢弃任务 |
| **Foreground vs Background** | 用户阻塞的请求有 3 次重试，后台任务立即放弃 | 避免容量级联 |

### 对跨仓分析的借鉴

**必须采纳**。K8s 服务不能因为一次 API 限流就丢失整个分析任务。

```typescript
// 分析服务的错误恢复策略
const RETRY_CONFIG = {
  // LLM API 错误
  llm_rate_limit: {
    max_retries: 5,
    backoff: "exponential",  // 500ms, 1s, 2s, 4s, 8s
    jitter: 0.25,
    fallback: "switch_to_utility_model"  // 强模型限流 → 降级到便宜模型
  },
  
  // pi RPC 子进程错误
  pi_crash: {
    max_retries: 1,
    action: "respawn_with_same_prompt"
  },
  pi_timeout: {
    timeout_ms: 600_000,  // 10 分钟
    action: "return_partial_result"  // 返回已完成的 Steps
  },
  
  // 外部工具错误
  ast_grep_timeout: {
    per_repo_timeout_ms: 30_000,
    action: "skip_repo_and_note"  // 跳过并在报告中标注
  },
  git_fetch_fail: {
    action: "use_cached_worktree"  // 用上次成功的快照
  },
  
  // Circuit Breaker
  consecutive_failures: {
    threshold: 3,
    action: "degrade_to_ast_grep_only"  // 只输出调用链，不做 LLM 风险推理
  }
};
```

**关键借鉴**：
- **Foreground vs Background 区分**：用户等待的分析任务有完整重试，做梦（weekly_evolution_scan：每周后台扫描误判模式并生成改进建议的定时任务）/AGENTS.md 刷新（后台 CronJob）失败就跳过
- **Partial Result 返回**：10 分钟超时后返回已完成的 Step 结果，而不是全部丢弃
- **Model Fallback**：强模型限流时自动降级到便宜模型，保证可用性

---

## 6. Prompt 设计

### Claude Code 的实现

- **Static/Dynamic 分区**：Static 部分跨请求缓存（global scope），Dynamic 部分每次重算
- **Array 输出**：system prompt 返回 string[]，每部分独立 cache scope
- **能力感知**：根据 enabled tools 动态组装相关指导段落
- **Anti-Injection**：明确指示 agent 标记工具输出中的 prompt injection
- **Cost Asymmetry 原则**：读文件便宜/猜测贵，跑测试便宜/宣称成功贵
- **Progressive Fallback**：搜索失败时，宽泛模式 → 替代命名 → 不同扩展名 → 问用户

### 对跨仓分析的借鉴

**中等价值**。当前 Skill 文件 + AGENTS.md 模板已经定义了 prompt 结构。后续优化时可借鉴：

1. **Static/Dynamic 分区**（Phase 2）：
   - Static：通用分析协议（5 步流程、风险标准、输出格式）— 跨项目复用
   - Dynamic：项目特有信息（仓库列表、framework 模式、AGENTS.md 内容）
   - 好处：Static 部分可以利用 LLM 的 prompt cache

2. **Cost Asymmetry 指导**：在 Skill 中加入：
   ```
   成本不对称原则：
   - 读取代码（bash read）：便宜。有疑问就读。
   - 猜测代码行为：昂贵（可能猜错导致整个分析方向错误）。
   - 跑 ast-grep 验证：便宜。怀疑就扫。
   - 宣称"没有更多调用者"：昂贵。确认后再说。
   ```

3. **Progressive Fallback for Python**：
   ```
   搜索 Python 符号失败时：
   1. 尝试 snake_case 变体（verify_token → verify_tokens / token_verify）
   2. 尝试类方法（TokenService.verify）
   3. 尝试 __init__.py 中的 re-export
   4. 标注为"可能存在但未找到"
   ```

---

## 7. 多 Agent 协调

### Claude Code 的实现

- **Coordinator/Worker 模式**：coordinator 分派任务，worker 独立执行
- **Task Notification**：异步 XML 消息通知完成
- **非阻塞并行**：coordinator 不等待 worker，继续处理
- **Synthesis 不可委托**：coordinator 必须自己理解，不能说"based on your findings, fix it"
- **Continue vs Spawn 决策**：高上下文重叠 → continue，低重叠 → spawn
- **AsyncLocalStorage 隔离**：进程内多 agent 并发不干扰
- **Mailbox 通信**：文件系统消息队列实现 agent 间通信
- **Team File**：JSON 配置记录团队成员、pane ID、订阅关系

### 对跨仓分析的借鉴

**MVP 阶段不需要**。原因：
- 我们的编排在分析服务层（Node.js），不在 agent 内部
- pi 没有 coordinator mode
- 分析是一次性任务，不需要持续协调

**Phase 2 需要**的场景：
- 同时分析多个 PR（每个 PR 一个 worker）
- 超大 diff（10+ 变更符号）时并行分析不同符号
- 后续增加"自动修复"功能时需要多 agent 协调

**如果需要，借鉴思路**：
```
分析服务（充当 coordinator）
  ├── spawn pi-1: 分析 symbol A 的调用链（只读）
  ├── spawn pi-2: 分析 symbol B 的调用链（只读）
  ├── spawn pi-3: 分析 symbol C 的调用链（只读）
  │   （并行执行，分析服务不阻塞等待）
  ├── 收集结果 → 合并调用链
  └── spawn pi-4: 基于合并后的调用链做风险传播 + 报告生成
       （synthesis 在分析服务层做，不委托给 agent）
```

---

## 8. 状态管理

### Claude Code 的实现

- **三层状态**：Bootstrap State（全局/进程）→ AppState（React/UI）→ Agent Context（AsyncLocalStorage）
- **Minimal Store**：自研 `createStore<T>`，无 middleware/thunks
- **Selector 优化**：`useSyncExternalStore` + 禁止返回整个 state
- **Immutability**：通过 `DeepImmutable<T>` 类型约束
- **Separate Concerns**：metrics（mutable, 全局）vs UI state（immutable, reactive）

### 对跨仓分析的借鉴

**低价值**。我们是无状态 API 服务：
- 每个分析请求是独立的（不需要跨请求共享 React state）
- 没有 TUI/UI 层
- pi 子进程自己管理自己的状态

**唯一可借鉴的**：per-task 状态追踪

```typescript
// 分析任务的状态（存在任务队列中）
interface TaskState {
  task_id: string;
  project: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: {
    current_step: number;      // 0-5
    step_name: string;
    repos_scanned: number;
    repos_total: number;
  };
  result?: AnalysisResult;
  error?: string;
  cost?: AnalysisCost;
  created_at: string;
  completed_at?: string;
}
```

---

## 9. 团队记忆

### Claude Code 的实现

- **Repo-Scoped**：每个 git 仓库一份共享记忆
- **ETag + Delta Sync**：只上传变更的条目（hash 比对）
- **乐观并发**：If-Match ETag，412 时刷新 hash 重试
- **Secret Scanning**：上传前 gitleaks 扫描，含密钥的文件不上传
- **Batch 分拆**：200KB/batch，确定性 bin-packing
- **文件系统 Watcher**：变更自动触发同步
- **Teammate 共享**：所有 team member 看到同一份 memory

### 对跨仓分析的借鉴

**中等价值**。我们的热/温/冷风险记录 + GLOBAL_PATTERNS.md 已经实现了类似功能，但可以借鉴：

1. **Delta Sync 模式**（如果将来需要跨 K8s 副本同步风险记录）：
   - 当前设计是单写（索引服务写）多读（分析服务读），用共享 PVC 即可
   - 如果将来多副本索引服务，可以用 ETag + hash 做冲突解决

2. **Secret Scanning**（防止 AGENTS.md 语义层泄露敏感信息）：
   - LLM 生成的语义层可能包含 API key、内部 URL 等
   - 上传/生成前应扫描

3. **结构化 hash 比对**（优化每周做梦的效率）：
   - 做梦前先 hash 比对热区文件，如果上次做梦后没有新增记录则跳过
   - 避免 57 个仓库每周都消耗 LLM token

**不采纳的**：
- 文件系统 Watcher：我们的风险记录由索引服务统一写入，不需要 watch
- 乐观并发：单写多读架构不存在并发冲突

---

## 实施优先级总结

### Phase 1 MVP 必须有

| 设计 | 来源 | 做法 |
|------|------|------|
| Exponential Backoff + Jitter | 错误恢复 | 分析服务层实现，覆盖 LLM API/pi crash/git fetch |
| Model Fallback | 错误恢复 | 强模型限流 → 自动降级到便宜模型 |
| Partial Result 返回 | 错误恢复 | 超时时返回已完成的 Step 结果 |
| Per-task 成本追踪 | Token 跟踪 | 每次分析记录 token/cost，按项目聚合 |
| 按需加载 AGENTS.md | 上下文管理 | 只加载受影响仓库的 AGENTS.md |
| ast-grep 预筛 | 成本优化 | 分析服务层先跑（零 LLM 成本），过滤仓库 |

### Phase 2 智能化

| 设计 | 来源 | 做法 |
|------|------|------|
| Thinking 分级 | Think 模式 | 风险传播 Step 启用 reasoning，报告生成不启用 |
| Static/Dynamic Prompt 分区 | Prompt 设计 | 通用协议（static）+ 项目信息（dynamic）分离 |
| Cost Asymmetry 指导 | Prompt 设计 | Skill 中加入"宁可多读不要猜"原则 |
| Diminishing Returns 检测 | Token Budget | 多层展开时自动停止 |
| **并行 Worker 编排** | **多 Agent 协调** | **多符号并行分析，分析服务层合并结果** |

### Phase 3 稳定化

| 设计 | 来源 | 做法 |
|------|------|------|
| Circuit Breaker | 错误恢复 | 做梦/刷新连续失败后停止 |
| Secret Scanning | 团队记忆 | AGENTS.md 语义层生成后扫描敏感信息 |
| Delta Hash 比对 | 团队记忆 | 做梦前检查是否有新记录，无则跳过 |

### Phase 4 优化

| 设计 | 来源 | 做法 |
|------|------|------|
| Cache Break Detection | 成本优化 | 监控 cache_read 指标，告警异常下降 |
| A/B 测试全量上线 | 自进化 | 验证通过的改进自动切换到 100% 流量 |

---

## Part B: 系统方案设计（§10-§20）

## 10. 多 Agent Coordinator 方案

### 已确认的设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 任务分割策略 | **按依赖链聚合** | 先 ast-grep 预筛 → 命中仓库集有重叠的符号合并到一个 worker |
| Worker 间通信 | **Fan-out / Fan-in（无通信）** | 独立函数改动和链式改动都有，合并在 Coordinator 层做更可控 |
| 风险冲突合并 | **取最高风险 + 注明多链命中** | 不丢失信息，人可审查 |
| Worker 失败处理 | **重试 1 次 + 部分返回** | 80% 分析完成的结果好过 100% 失败 |
| 并行度上限 | **MAX_PARALLEL_WORKERS = 6** | 可配置，兼顾 LLM RPM 限制和 K8s Pod 资源。推导公式：`floor(LLM_RPM / avg_calls_per_worker / safety_factor)`，例如 RPM=60、每 worker 约 8 calls、safety_factor=1.2 → `floor(60/8/1.2)=6` |
| Coordinator 位置 | **分析服务进程内** | 子进程 spawn 比 Pod 调度快 10x |

### 任务分割算法

```
预处理（零 LLM 成本）：
  1. 解析 diff → 提取 N 个变更符号
  2. 对每个符号运行 ast-grep → 获得命中仓库集
     symbol_A → {cvm-api, auth-service, payment-service}
     symbol_B → {cvm-api, cxm-api}
     symbol_C → {monitor-agent}
     symbol_D → {cvm-api, auth-service}

  3. 按仓库集重叠度聚合：
     - A 和 D 命中集高度重叠（都含 cvm-api + auth-service）→ 合并为 task-1
     - B 部分重叠（含 cvm-api）但独立性强 → 独立 task-2
     - C 完全独立 → 独立 task-3

  4. 结果：3 个 task，最多 3 个 worker 并行
```

### 确定性合并逻辑（不用 LLM）

```typescript
/** 分析服务层代码，确定性合并，不消耗 LLM token */
function mergeWorkerResults(results: WorkerResult[]): MergedResult {
  const callTree = new Map<string, CallNode>();

  for (const result of results) {
    for (const node of result.callTreeNodes) {
      const key = `${node.repo}/${node.file}:${node.line}`;

      if (callTree.has(key)) {
        const existing = callTree.get(key)!;
        existing.risk = maxRisk(existing.risk, node.risk);
        existing.viaChains.push(node.viaChain);
        existing.hitCount += 1;
      } else {
        callTree.set(key, { ...node, hitCount: 1, viaChains: [node.viaChain] });
      }
    }
  }

  // 多链命中自动标注
  for (const node of callTree.values()) {
    if (node.hitCount > 1) {
      node.annotation = `被 ${node.hitCount} 条调用链命中`;
    }
  }

  return {
    callTree,
    riskTable: [...callTree.values()].sort((a, b) => riskPriority(b) - riskPriority(a)),
  };
}
```

**关键原则（借鉴 Claude Code Coordinator Mode）**：
- **Synthesis 不可委托**：合并逻辑在代码中执行，不让 LLM "理解并总结"多个 worker 的结果
- **预筛是免费的**：ast-grep 扫描在 Node.js 层运行，零 LLM 成本
- **Worker 收到精简输入**：只给负责的符号 + 命中的 5-10 仓

---

## 11. Opik 集成方案

> ⚠️ **Trace 架构已被 `cross-repo-impact-analysis.md` §14 覆盖。**
> 主要差异：规格文档采用**自适应粒度**（默认 standard，P0 节点自动升级 detailed），本段为固定细粒度方案。
> A/B 测试流程和评估指标两文档一致，可互相参考。

### 部署

self-hosted，内网已部署。

### Trace 架构（按节点嵌套 span）

```
trace: analysis-{task_id}
  │
  │  metadata: { project, experiment, variant, symbols_count }
  │
  ├── span: pre_filter (duration, repos_hit, symbols_extracted)
  │
  ├── span: worker_1 (symbol, repos, input_tokens, output_tokens, cost)
  │   ├── span: node_analysis (node=login.py:18)
  │   │   ├── span: llm_round_1 (context=3lines, confidence=0.62)
  │   │   ├── span: llm_round_2 (context=50lines, confidence=0.81)  ← 触发：conf<0.8
  │   │   └── span: llm_round_3 (cross_validation, confidence=0.89)
  │   └── span: node_analysis (node=handler.py:42)
  │       └── span: llm_round_1 (confidence=0.93)
  │   └── [如果产出 P0 节点] artifact: tool_calls_detail（完整工具调用日志）
  │
  ├── span: worker_2 ... (同上)
  ├── span: merge (duration, conflicts_count, nodes_merged)
  └── span: reporter (input_tokens, output_tokens, cost)
```

**按节点嵌套**：每个被分析节点是独立 span，其下挂各轮 LLM 调用子 span（动态轮次，置信度 < 0.8 自动追加）。这样 Opik 中可以直接看到每个节点用了几轮验证、各轮置信度走势，误判时可追溯到具体轮次。
**P0 节点自动细化**：附带完整工具调用 artifact，用于自进化分析误判原因。

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

```typescript
// Opik Dataset 积累 ground truth
const dataset = opik.dataset("cross_repo_ground_truth");

dataset.addItem({
  taskId: "analysis-001",
  reference: {
    knownP0Nodes: ["cvm-api/views/login.py:18"],
    knownCallers: ["cvm-api/views/login.py", "payment-service/handler.py"],
    confirmedSafeNodes: ["shared-lib/utils/format.py"],
    source: "human_annotation",
  },
});
```

### A/B 测试流程

```
进化系统生成新版 prompt/规则
  ↓
人工审核批准 → 进入 A/B 实验
  ↓
实验配置：
  experiment: risk_rule_v2
  treatment_ratio: 0.10           # 10% 流量
  auto_promote_threshold: 0.05    # 指标提升 5% 自动全量
  auto_rollback_threshold: -0.05  # 下降 5% 自动回滚
  max_duration_days: 21
  ↓
分析服务路由层：hash(task_id) % 100 决定分组
  ↓
Opik trace 打标签：experiment + variant
  ↓
每周 evaluation job 从 Opik 拉取两组 trace，对比指标
  ↓
  ├── treatment 显著优于 control → 全量上线
  ├── treatment 显著劣于 control → 回滚
  └── 无显著差异 → 延长实验（最多 3 周）
```

```yaml
# /config/experiments.yml
experiments:
  - name: "risk_rule_v2"
    description: "优化 Python is→== 变更的风险判定逻辑"
    treatment_ratio: 0.10
    artifacts:
      treatment:
        skill: "cross-repo-analysis-v2"
        risk_rules: "risk_rules_v2.yml"
      control:
        skill: "cross-repo-analysis"
        risk_rules: "risk_rules.yml"
    metrics: ["p0_precision", "p0_recall", "coverage"]
    auto_promote_threshold: 0.05
    auto_rollback_threshold: -0.05
    max_duration_days: 21
```

---

## 12. 自进化系统

> ℹ️ **规格文档 `cross-repo-impact-analysis.md` §15 简化了描述，但本段的代码实现（Evidence 结构、weeklyEvolutionAnalysis、紧急降级逻辑）仍为权威参考。**
> 两文档在进化对象、Evidence 类型、降级范围上完全一致。本段提供了更完整的实现代码。

### 进化循环

```
日常分析执行 → Opik trace + 用户反馈
       ↓
Evidence 积累（误判 case、遗漏、反馈、线上事故）
       ↓ 每周触发
进化分析（LLM 分析 evidence，生成改进建议）
       ↓
人工审核（像 PR review 一样审核改进建议）
       ↓ 批准
A/B 测试（10% 流量验证，2-3 周）
       ↓ Opik evaluate 对比
全量上线 或 回滚
```

### 五个进化对象

| 进化对象 | Evidence 来源 | 进化方式 | 示例 |
|---------|-------------|---------|------|
| **Skill prompt** | Opik trace 中 LLM 误判的 input/output | 调整指令、增加 few-shot example | "Python 中 `is` 改 `==` 对 None 的影响要特别说明" |
| **风险判定规则** | 误报/漏报统计 | 调整规则权重、新增规则 | "去掉 Optional 返回类型的风险从 🟡 升为 🔴" |
| **AGENTS.md 语义层** | 分析发现新的高风险模块/调用关系 | 自动追加（热区→温区→冷区） | "billing-php 通过 HTTP 调用 auth-service" |
| **工具规则模板** | 遗漏的调用者 | 新增 ast-grep / grep 搜索模式 | "新增 `cls.verify_token($$$)` 类方法模式" |
| **Project Config** | 发现新的 HTTP 框架/MQ topic | 更新 runtime_calls 配置 | "新增 framework_pattern: `ServiceGateway`" |

### Evidence 结构

```typescript
interface EvolutionEvidence {
  taskId: string;
  timestamp: string;
  evidenceType: "false_positive" | "false_negative" | "user_feedback" | "incident";
  node: string;           // "cvm-api/views/login.py:18"
  predictedRisk: string;  // "P0"
  actualRisk: string;     // "P2"（反馈）或 "P0"（事故确认）
  opikTraceId: string;    // 可追溯到 Opik trace
  opikSpanId: string;     // 哪个 LLM 调用做出了这个判断
  llmReasoning: string;   // LLM 的推理过程
  rootCause: string | null; // 改进线索
  relatedRule: string | null; // 关联规则 ID（用于紧急降级）
}
```

### 每周进化分析（"做梦"）

```typescript
async function weeklyEvolutionAnalysis(): Promise<void> {
  const evidence = await loadEvidence({ since: "last_7d" });
  if (evidence.length < 3) return; // 数据不够，跳过

  const falsePositives = evidence.filter(e => e.evidenceType === "false_positive");
  const falseNegatives = evidence.filter(e => e.evidenceType === "false_negative");

  const suggestions: Suggestion[] = [];

  if (falsePositives.length >= 2) {
    const fpAnalysis = await llmAnalyze("分析误报模式，给出改进建议", falsePositives);
    suggestions.push(...fpAnalysis.suggestions);
  }

  if (falseNegatives.length >= 1) {
    const fnAnalysis = await llmAnalyze("分析遗漏原因，给出规则改进建议", falseNegatives);
    suggestions.push(...fnAnalysis.suggestions);
  }

  // 为每个建议生成可执行变更（diff 形式）
  for (const s of suggestions) {
    await generateExecutableDiff(s);
  }

  // 通知人工审核
  await notifyReviewers(suggestions);
}
```

### 紧急自动降级

连续 3 次同类误判时不等人工审核，自动降级。**降级范围仅限输出标注**（添加警告说明），不影响 A/B 实验路由和评估指标，进程重启后自动清除：

```typescript
// 运行时状态，进程重启后清除
const degradedRules = new Set<string>();

function checkEmergencyDegradation(evidence: EvolutionEvidence): void {
  const recentFp = countSimilarEvidence(evidence.rootCause, { window: "last_24h" });

  if (recentFp >= 3 && evidence.relatedRule) {
    degradedRules.add(evidence.relatedRule);
    opik.logEvent("emergency_degradation", {
      rule: evidence.relatedRule,
      fpCount: recentFp,
      scope: "output_annotation_only",  // 仅影响输出标注
      experimentUnaffected: true,        // A/B 实验路由不受影响
    });
  }
}

/** 输出阶段应用降级标注（不修改 risk_level，只加注 note） */
function applyRiskOutput(node: RiskNode, ruleId: string): RiskNode {
  if (degradedRules.has(ruleId)) {
    return {
      ...node,
      confidence: node.confidence * 0.6,
      note: `${node.note ?? ""} ⚠️ 该规则近 24h 误报率偏高，建议人工确认`.trim(),
    };
  }
  return node;
}
```

---

## 13. 决策记录：关键设计确认

> 以下为 2024 年讨论确认的设计决策，覆盖冷启动、盲区补偿、Ground Truth 积累、安全、存储、风险传播、成本策略。

### 技术选型说明

**语言**：分析服务全部使用 TypeScript。pi 作为 npm 包（`@earendil-works/pi-agent-core`）直接引入，无需跨语言调用。文档中所有代码示例均为 TypeScript。

**pi**：`@earendil-works/pi-agent-core`，TypeScript npm 包，开源于 [earendil-works/pi-mono](https://github.com/earendil-works/pi-mono)，MIT 许可。提供 `Agent` 类，支持 `prompt()` / `continue()` / `abort()` 等方法、流式事件输出（`agent_start` / `turn_start` / `tool_execution_*` 等）、工具调用（并行/串行）、多级推理深度（`thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"`）、多 provider（Anthropic / OpenAI / Google 等）。分析服务通过 `sessionId` 复用 provider 侧 prompt cache（TTL 1h）；通过 `transformContext` 钩子清理工具结果控制上下文长度。

### 决策总览

| # | 问题 | 决策 | 补充 |
|---|------|------|------|
| D1 | AGENTS.md 冷启动 | AI 生成 + 人工审核，Phase 1 缩小到 5-8 核心仓库 | 7 天完成 |
| D2 | ast-grep 预筛盲区 | 加入第二通道（HTTP/MQ/配置/反向依赖 grep），取并集 | 零 LLM 成本 |
| D3 | Ground Truth 引导 | 三阶段：回溯验证 → Shadow Mode → Production Feedback | 上线前就能开始 |
| D4 | LLM 走公网安全 | 脱敏管线 + `.analysisignore` + 最小化发送 | 只发签名+调用关系 |
| D5 | 风险传播深度 | 风险衰减模型（非固定深度），硬上限 5 层 | 扇出剪枝 Top 20 |
| D6 | 57 仓 Git 存储 | 本地 SSD bare repo + per-task worktree（用完即删） | ~20-30GB 足够 |
| D7 | 成本策略 | 不设上限，优先准确性；加可观测性 + 故障安全 | 不确信就追加验证 |

---

## 14. AGENTS.md 冷启动方案（D1）

### 操作流程

```
Phase 0: 选仓（1天）
    ↓
Phase A: 自动采集元数据（半天）
    ↓
Phase B: AI 生成 AGENTS.md 初稿（1-2天）
    ↓
Phase C: 人工审核 + 修正（3-5天）
    ↓
Phase D: 交叉验证（1天）
    ↓
可用的 AGENTS.md × 5-8 份
```

### Phase 0: 选仓标准

从 57 仓中选 5-8 个：

| 维度 | 选仓偏好 | 理由 |
|------|---------|------|
| 变更频率 | 高频变更仓库 | 最需要跨仓分析的就是它们 |
| 依赖被引用数 | 被 ≥5 个仓库依赖的 | 它们变更影响面最大 |
| 语言多样性 | 至少覆盖 Python + Go + PHP | 验证多语言兼容性 |
| 团队了解度 | 有人能审核的 | 没人懂的仓库生成了也没法校验 |
| 调用关系密度 | 互相调用多的一组 | 能形成闭环测试（A→B→C→A） |

**推荐选法**：

```
核心链路组（4个）：
  cvm-api → auth-service → payment-service → shared-lib

补充组（3-4个）：
  data-platform（被多仓依赖）
  monitor-agent（观测面）
  billing-php（跨语言验证）
  cxm-api（对照组）
```

### Phase A: 自动采集元数据

```bash
#!/bin/bash
# 对每个选中的仓库执行，产出结构化元数据

REPO=$1
OUTPUT="metadata/${REPO}"

# 1. 目录结构（深度3层，排除 vendor/node_modules）
tree -L 3 -I "vendor|node_modules|__pycache__|.git" --dirsfirst -J > ${OUTPUT}.tree.json

# 2. 入口文件识别
find . -name "main.py" -o -name "app.py" -o -name "main.go" \
       -o -name "urls.py" -o -name "routes.py" -o -name "router.go" \
       > ${OUTPUT}.entrypoints

# 3. 公开 API 端点（框架相关）
# Django
grep -rn "@api_view\|path(\|url(" --include="*.py" > ${OUTPUT}.apis.django 2>/dev/null
# Go Gin/Echo
grep -rn "\.GET\|\.POST\|\.PUT\|\.DELETE\|\.Group" --include="*.go" > ${OUTPUT}.apis.go 2>/dev/null
# PHP Laravel
grep -rn "Route::" --include="*.php" > ${OUTPUT}.apis.php 2>/dev/null

# 4. 对外暴露的函数/类（被其他仓库 import 的）
for other_repo in ${OTHER_REPOS[@]}; do
  grep -rn "from ${REPO}\|import.*${REPO}" ${other_repo}/ 2>/dev/null
done > ${OUTPUT}.external_imports

# 5. MQ topic / Event 发布
grep -rn "publish\|emit\|send_message\|produce" --include="*.py" --include="*.go" \
  > ${OUTPUT}.events

# 6. 配置文件中的服务声明
cat docker-compose.yml k8s/*.yaml 2>/dev/null | grep -A5 "service\|container" \
  > ${OUTPUT}.services

# 7. 最近3个月的高频变更文件 Top 20
git log --since="3 months ago" --name-only --pretty="" | sort | uniq -c | sort -rn | head -20 \
  > ${OUTPUT}.hotfiles

# 8. 依赖声明
cat requirements.txt go.mod composer.json package.json 2>/dev/null > ${OUTPUT}.deps
```

### Phase B: AI 生成指令

```markdown
你要为仓库 {repo_name} 生成 AGENTS.md 语义层文件。

### 输入
- 目录结构：{tree_output}
- API 端点列表：{endpoints}
- 被外部引用的符号：{external_imports}
- MQ/Event 发布点：{mq_topics}
- 高频变更文件：{hot_files}
- 依赖声明：{dependencies}

### 输出格式（严格遵循）

```yaml
# AGENTS.md - {repo_name}
version: 1
last_generated: {date}
confidence: "ai_draft"  # ai_draft | human_reviewed | verified

## 仓库概述
purpose: "一句话说明这个仓库做什么"
language: python|go|php
framework: django|gin|laravel|...
team: "负责团队名"

## 公开 API（被外部直接调用的）
apis:
  - endpoint: "POST /api/v1/auth/verify"
    handler: "src/views/auth.py:verify_token"
    callers: ["cvm-api", "payment-service"]
    risk_weight: high  # 公网入口=high, 内部=medium, 工具=low

## 导出符号（被其他仓库 import 的函数/类）
exports:
  - symbol: "TokenService.verify"
    file: "src/services/token.py"
    importers: ["cvm-api/utils/auth.py", "billing/middleware.py"]
    risk_weight: high

## 事件/消息（MQ 发布）
events_published:
  - topic: "order.created"
    publisher: "src/handlers/order.py:create_order"
    known_consumers: []  # 需要人工补充

## 热区（高频变更 + 高影响）
hot_zones:
  - file: "src/views/auth.py"
    reason: "3个月内变更47次 + 被5个仓库调用"

## 内部架构备注
notes:
  - "所有 API 入口经过 middleware/auth.py 鉴权"
  - "数据库操作统一通过 src/db/ 层"
```
```

### Phase C: 人工审核清单

```markdown
## AGENTS.md 审核清单（每仓 30-60 分钟）

### 完整性审核 ✅
- [ ] 所有公网 API 端点都列出了吗？（对照 nginx/gateway 配置）
- [ ] 被其他仓库调用的核心函数都列出了吗？
- [ ] MQ topic 发布点完整吗？消费者列对了吗？
- [ ] 有没有遗漏的 RPC/HTTP 内部调用？

### 准确性审核 ❌
- [ ] handler 路径对不对？（随机抽查 3 个）
- [ ] callers 列表对不对？（随机抽查 2 个）
- [ ] risk_weight 合理吗？（公网入口必须 high）

### 关键补充 ➕
- [ ] 补充 events_published 的 known_consumers
- [ ] 补充"隐式依赖"（配置驱动、动态分派、反射调用）
- [ ] 补充关键内部调用链

### 签核
审核人：___________  日期：___________
confidence 升级为：human_reviewed ✅
```

### Phase D: 交叉验证

取最近一个已知影响范围的 PR（已上线且知道实际影响了哪些仓库）：

1. 用这 5-8 份 AGENTS.md + 分析管线跑一次
2. 对比分析结果 vs 实际影响
3. 遗漏的部分 → 补充到 AGENTS.md
4. 误报的部分 → 修正 risk_weight
5. **这个验证本身就是第一批 Ground Truth**

### 时间线

| 步骤 | 耗时 | 参与人 |
|------|------|--------|
| Phase 0 选仓 | 0.5 天 | 架构师 1 人 |
| Phase A 采集 | 0.5 天 | 自动化脚本 |
| Phase B AI 生成 | 1 天 | AI + 1 人监督 |
| Phase C 人工审核 | 4 天 | 每仓对应团队 1 人 × 1h |
| Phase D 交叉验证 | 1 天 | 1 人 |
| **总计** | **~7 天** | |

### AGENTS.md 三级优先级与自适应加载

随着仓库数量增长到 50+，一次性注入所有 AGENTS.md 会导致上下文溢出。按重要性分三级处理：

| 级别 | 仓库数 | 加载策略 | Token 预算 |
|------|--------|---------|-----------|
| Tier 1（核心链路） | ~4 个 | 始终加载完整版 | ~2K/仓 |
| Tier 2（中频依赖） | ~20-30 个 | ast-grep 命中时加载完整版；预算不足降为压缩摘要 | ~2K 或 ~200 token |
| Tier 3（其余仓库） | 其余 | 仅加载压缩摘要（200 token） | ~200/仓 |

```typescript
function loadAgentsMdAdaptive(
  hitRepos: Set<string>,
  contextBudget: number  // e.g. 40_000 tokens reserved for AGENTS.md
): { loaded: Record<string, string>; remaining: number } {
  const loaded: Record<string, string> = {};
  let remaining = contextBudget;

  // Tier 1：始终加载完整版
  for (const repo of TIER1_REPOS) {
    const md = loadFullAgentsMd(repo);       // ~2K tokens
    remaining -= estimateTokens(md);
    loaded[repo] = md;
  }

  // Tier 2：命中则加载完整版，预算不足降为压缩摘要
  for (const repo of setIntersect(hitRepos, TIER2_REPOS)) {
    if (remaining < 2000) {
      loaded[repo] = loadCompressedSummary(repo); // ~200 tokens
    } else {
      const md = loadFullAgentsMd(repo);
      remaining -= estimateTokens(md);
      loaded[repo] = md;
    }
  }

  // Tier 3：仅压缩摘要
  for (const repo of setIntersect(hitRepos, TIER3_REPOS)) {
    loaded[repo] = loadCompressedSummary(repo);
    remaining -= 200;
  }

  return { loaded, remaining };
}
```

### AGENTS.md 版本一致性（HEAD hash 锁定）

AGENTS.md 由 AI 生成后锁定生成时的 commit hash，分析时检测 stale：

```yaml
# AGENTS.md 头部元数据
meta:
  generated_at_commit: "a3f7c12"
  generated_date: "2025-01-15"
  confidence: "human_reviewed"  # ai_draft | human_reviewed | verified
  stale_warning_after_days: 30
```

```typescript
function checkAgentsMdFreshness(repo: string, agentsMd: AgentsMd): void {
  const currentHead = gitRevParse(repo, "origin/main");
  if (currentHead === agentsMd.meta.generatedAtCommit) return;

  const commitsSince = gitLogCount(repo, { since: agentsMd.meta.generatedAtCommit });
  if (commitsSince > 50) {
    agentsMd.freshness = "stale";
    // 在分析报告中注明：该仓库 AGENTS.md 已落后 N 个 commit，建议更新
  }
}
```

后续（Phase 2）可在 CI 中触发 AGENTS.md 重新生成：当仓库主干新增 commit 时，CI 判断是否有 API/导出变更，有则自动提 PR 更新 AGENTS.md。

---

## 15. ast-grep 盲区补偿方案（D2）

### 问题

ast-grep 无法覆盖的调用场景：
- Python 动态分派：`getattr(obj, method_name)()`
- 字符串拼接 HTTP 调用：`requests.get(f"{BASE_URL}/api/{endpoint}")`
- MQ/事件驱动：`publish("order.created", data)` → 消费者在另一个仓库
- 配置驱动依赖：YAML/JSON 中引用的 class path

### 解决方案：两阶段预筛（解决鸡生蛋问题）

ast-grep 需要 worktree 才能运行，但要创建 worktree 就要先知道哪些仓库命中了——这是鸡生蛋问题。解法：Phase 1 用 `git grep` 直接在 bare repo 上运行（无需 worktree），Phase 2 只对粗筛命中的仓库创建 worktree 再跑 ast-grep 精筛。

```typescript
/**
 * Phase 1：在 bare repo 上用 git grep 粗筛（无需 worktree，解决鸡生蛋问题）
 * 同时覆盖 HTTP 端点 / MQ topic / 配置引用 / 反向依赖等动态调用场景
 */
async function coarseFilter(
  symbols: Symbol[],
  allRepos: string[],
  agentsMdIndex: AgentsMdIndex
): Promise<Set<string>> {
  const coarseHits = new Set<string>();

  for (const repo of allRepos) {
    const barePath = path.join(BARE_DIR, `${repo}.git`);

    for (const symbol of symbols) {
      // Layer 1: 直接符号名匹配
      const symResult = spawnSync("git", ["grep", "-l", symbol.name, "origin/main"], { cwd: barePath });
      if (symResult.status === 0) { coarseHits.add(repo); continue; }

      // Layer 2: HTTP 端点 URL（从 AGENTS.md apis 段读取）
      if (symbol.isApiHandler && symbol.endpointUrl) {
        const httpResult = spawnSync("git", ["grep", "-l", symbol.endpointUrl, "origin/main"], { cwd: barePath });
        if (httpResult.status === 0) { coarseHits.add(repo); continue; }
      }

      // Layer 3: MQ topic（从 AGENTS.md events 段读取）
      if (symbol.eventTopic) {
        const mqResult = spawnSync("git", ["grep", "-l", symbol.eventTopic, "origin/main"], { cwd: barePath });
        if (mqResult.status === 0) { coarseHits.add(repo); continue; }
      }

      // Layer 4: 配置引用（class path 出现在 YAML/JSON/TOML 中）
      if (symbol.fullyQualifiedName) {
        const cfgResult = spawnSync("git", [
          "grep", "-l", symbol.fullyQualifiedName, "origin/main", "--",
          "*.yaml", "*.yml", "*.json", "*.toml"
        ], { cwd: barePath });
        if (cfgResult.status === 0) { coarseHits.add(repo); continue; }
      }

      // Layer 5: 反向依赖（谁 import 了变更文件所属的包）
      if (symbol.packageName) {
        const importResult = spawnSync("git", ["grep", "-l", symbol.packageName, "origin/main"], { cwd: barePath });
        if (importResult.status === 0) { coarseHits.add(repo); continue; }
      }
    }
  }

  return coarseHits;
}

/** Phase 2：只对粗筛命中的仓库创建 worktree，再用 ast-grep 精筛 */
async function fineFilter(
  symbols: Symbol[],
  coarseHits: Set<string>,
  taskId: string
): Promise<Set<string>> {
  const fineHits = new Set<string>();

  for (const repo of coarseHits) {
    await repoManager.withTaskWorktree(taskId, repo, "origin/main", async (wt) => {
      for (const symbol of symbols) {
        const results = await runAstGrep(symbol.pattern, wt);
        if (results.length > 0) fineHits.add(repo);
      }
    });
  }

  return fineHits;
}

/** 两阶段预筛入口：Phase 1 git grep（bare repo）→ Phase 2 ast-grep（worktree） */
async function preFilter(
  diff: Diff,
  projectConfig: ProjectConfig,
  taskId: string
): Promise<Set<string>> {
  const symbols = parseDiffSymbols(diff);
  // Phase 1 覆盖 5 层：直接调用 + HTTP + MQ + 配置引用 + 反向依赖（取并集）
  const coarseHits = await coarseFilter(symbols, projectConfig.repos, projectConfig.agentsMdIndex);
  // Phase 2 精筛：只为粗筛命中仓库创建 worktree
  return fineFilter(symbols, coarseHits, taskId);
}
```

---

## 16. Ground Truth 积累方案（D3）

### 核心矛盾

```
需要评估准确性 → 需要 ground truth → 需要人标注/历史数据
人标注需要时间 → 上线初期数据不够 → 无法评估 → 死循环
```

### 选定方案：C + 少量 A（立即 Shadow Mode + 5-10 个已知事件作锚点）

**立即启动 Shadow Mode**（Option C）：分析系统上线第一天就开始产出报告，但不发通知。所有报告进入 Opik Dataset，等待标注。同时，从 git 历史回溯 5-10 个团队已知的跨仓影响事件作为初始锚点（Option A 的精简版），用于校准初始阈值，不做全量历史挖掘。

### 三阶段解决方案

#### 阶段一：少量回溯锚点（上线前 1-2 天）

不做全量历史挖掘，只找 5-10 个团队亲历的跨仓影响事件，用于校准初始阈值：

```typescript
async function generateRetrospectiveGroundTruth(): Promise<GroundTruthItem[]> {
  // 只回溯 5-10 个团队亲历的已知事件（不做全量扫描）
  // 方法1：从 bug fix commit 反查原因 PR
  const fixCommits = await gitLog({ grep: "fix|hotfix|revert|caused by", repos: allRepos });
  const groundTruth: GroundTruthItem[] = [];

  for (const fix of fixCommits) {
    const rootCause = await traceRootCause(fix);
    if (rootCause && rootCause.repo !== fix.repo) {
      groundTruth.push({
        triggerPr: rootCause,
        affectedRepo: fix.repo,
        affectedFile: fix.file,
        riskLevel: "P0",
        source: "retrospective_git_history",
      });
    }
    if (groundTruth.length >= 10) break; // 锚点够用就停，不做全量
  }

  // 方法2：团队知道的 incident（手动补充 2-3 条）
  // 方法3：从 revert commit 反查（可选，补充数量）

  return groundTruth;
}
```

**预期产出**：5-10 条 P0 级 ground truth 锚点，**上线前 1-2 天完成**。

#### 阶段二：Shadow Mode + 分层标注（上线第 1-4 周）

```
                    ┌─────────────────────────────┐
                    │   分析系统产出报告           │
                    └───────────┬─────────────────┘
                                │
                    ┌───────────▼─────────────────┐
                    │   不自动发通知（shadow mode）  │
                    └───────────┬─────────────────┘
                                │
              ┌─────────────────┼──────────────────┐
              ▼                 ▼                   ▼
     快速标注（全量）     深度标注（抽样）      自动验证（全量）
     "P0 对吗？"         "逐条审查调用链"     "文件路径存在吗？"
     1min/报告           15min/报告           0 人力
     PR 作者标注         架构师标注           自动化脚本
```

**快速标注界面**（PR comment 中）：

```markdown
## 跨仓影响分析报告 - PR#1234

| # | 节点 | 标记 | 你的判断 |
|---|------|------|---------|
| 1 | cvm-api/views/login.py:18 | P0 | ✅ / ❌ / 🤷 |
| 2 | payment-service/handler.py:42 | P0 | ✅ / ❌ / 🤷 |

是否有遗漏？
- [ ] 有，___仓库/___文件
- [x] 没有

> 回复：`/feedback p0_correct=1,2 p0_wrong= missed=billing/invoice.py`
```

**自动验证**（零人力）：

```typescript
async function autoValidate(analysisResult: AnalysisResult): Promise<Validation[]> {
  const validations: Validation[] = [];

  for (const node of analysisResult.nodes) {
    // 文件是否存在
    if (!await fileExists(node.repo, node.file)) {
      validations.push({ kind: "file_not_found", node, verdict: "DEFINITE_ERROR" });
      continue;
    }

    // 行号处是否包含相关代码
    const lineContent = await readLine(node.repo, node.file, node.line);
    if (!lineContent.includes(node.symbol)) {
      validations.push({ kind: "symbol_not_at_line", node, verdict: "LIKELY_ERROR" });
    }

    // 调用关系是否真实存在（ast-grep 验证）
    if (!await astGrepConfirms(node.caller, node.callee)) {
      validations.push({ kind: "call_not_confirmed", node, verdict: "NEEDS_REVIEW" });
    }
  }

  return validations;
}
```

#### 阶段三：Production Feedback Loop（第 5 周+）

```
PR 作者收到分析报告
    ├── 确认 P0 → TP
    ├── 否认 P0 → FP
    ├── 补充遗漏 → FN
    └── 7天无反馈 → 自动检查：
        - 该仓库有 hotfix？→ 可能是 FN
        - 该仓库无异常？→ 可能是 TN
```

### LLM-as-Judge 的合法用法

不评估"分析对不对"（循环论证），而是评估"分析过程是否遵循了规则"（过程审计）：

```typescript
async function llmAsJudgeLegitimateUse(analysisTrace: AnalysisTrace): Promise<AuditResult> {
  // 过程审计，非结果审计
  const judgePrompt = `
检查推理过程：
1. 是否有"跳步"——直接给结论但没给推理过程？
2. 是否有"幻觉调用"——声称 A 调用了 B 但没引用代码证据？
3. 是否有"风险膨胀"——把明显安全的节点标了 P0？
4. 推理链是否自洽？
注意：不判断最终结论正确性，只判断推理过程有无明显漏洞。
`;
  return llmAudit(judgePrompt, analysisTrace);
}
```

### 时间线

| 周 | 数据来源 | 预期数据量 | 可做的事 |
|----|---------|-----------|---------|
| -2~0 (上线前) | 回溯 5-10 个已知事件（锚点） | 5-10 条 P0 | 校准初始阈值 |
| 1-2 | 自动验证（Shadow Mode 产出） | 每次分析 5-10 条 | 修文件路径/行号错误 |
| 1-4 | Shadow mode 快速标注 | 50-100 条 | 调 risk_weight |
| 3-4 | 深度标注（抽样） | 10-20 条高质量 | 校准调用链完整性 |
| 5+ | Production feedback | 持续积累 | 喂给自进化系统 |

---

## 17. 公网 LLM 安全方案（D4）

### 设计原则

跨仓分析大部分时候只需要**函数签名 + 调用关系 + 类型信息**，不需要完整函数体。

### 分层防护

```
代码原文 → 预处理层（脱敏）→ LLM API（公网）→ 返回结果 → 后处理（还原引用）
```

### 实现

```typescript
class CodeSanitizer {
  // 全局排除（永远不发给 LLM）
  static readonly EXCLUDE_PATHS = [
    "**/secrets/**", "**/.env*", "**/credentials*",
    "**/private_key*", "**/*.pem", "**/*.key",
    "**/config/production.yml",
  ];

  // 正则脱敏（发送前替换）
  static readonly REDACT_PATTERNS: [RegExp, string][] = [
    [/(?i)(password|secret|token|api_key)\s*[=:]\s*["']([^"']+)["']/g, '$1 = "[REDACTED]"'],
    [/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "[INTERNAL_IP]"],
    [/(?i)(mysql|postgres|redis|mongo):\/\/[^\s"']+/g, "[DB_CONNECTION_REDACTED]"],
  ];

  sanitize(codeSnippet: string, filePath: string): string {
    if (CodeSanitizer.EXCLUDE_PATHS.some(p => minimatch(filePath, p))) {
      return `[FILE EXCLUDED: ${filePath}]`;
    }
    let result = codeSnippet;
    for (const [pattern, replacement] of CodeSanitizer.REDACT_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    return result;
  }
}
```

### 上下文升级规则

默认发送 3 行上下文。以下条件任一满足时，自动升级为 50 行：

- `node.isPublicApi === true`（公网 API 入口）
- `node.isAuthCritical === true`（鉴权/支付相关节点）
- `confidence < 0.8`（首轮置信度不足时追加上下文）

```typescript
function getContextLines(node: CallNode, confidence?: number): number {
  if (node.isPublicApi || node.isAuthCritical || (confidence !== undefined && confidence < 0.8)) {
    return 50;
  }
  return 3;
}
```

### 最小化发送策略

```typescript
function prepareContextForLlm(callNode: CallNode, confidence?: number): LlmContext {
  const sanitizer = new CodeSanitizer();
  const lines = getContextLines(callNode, confidence);

  return {
    file: callNode.file,
    function: callNode.symbol,
    signature: callNode.signature,            // e.g. "verify_token(token: str) -> bool"
    callerContext: sanitizer.sanitize(        // 升级规则：3行 or 50行
      callNode.getSurroundingLines(lines),
      callNode.file
    ),
    isPublicApi: callNode.isEndpoint,
    // 不发：完整函数实现、import 列表、生产配置
  };
}
```

### `.analysisignore` 配置

```gitignore
# .analysisignore — 分析时排除的路径
**/secrets/
**/.env*
**/credentials*
**/config/production*
**/migrations/      # 数据库迁移通常不需要分析
**/vendor/          # 第三方代码
**/node_modules/
**/*_test.go        # 测试文件不参与风险传播
**/tests/
```

---

## 18. 风险传播模型（D5）

### 设计决策

**主机制不依赖固定深度**。改为风险衰减模型：关键路径自然展得深，无关路径自然截断。同时设置 `MAX_DEPTH = 5` 作为硬安全网——防止环形调用或衰减系数配置错误时无限展开。

### 问题分析

50+ 模块时，真正的风险不是"链太深"，而是"每层扇出太宽"：

```
Layer 0: shared-lib/utils.py::format_date()  ← 变更点
         │
    Layer 1: 25 个直接调用者（12仓）   ← 扇出=25
         │
    Layer 2: 75 个间接调用者          ← 扇出=75
         │
    Layer 3: ???                      ← 爆炸
```

### 风险衰减实现

```typescript
type CallType = "direct_call" | "http_api" | "mq_event" | "config_reference" | "dynamic_dispatch";

interface RiskNode {
  node: CallNode;
  propagatedRisk: number;
  depth: number;
  truncated?: boolean;
  belowThreshold?: boolean;
  prunedCallers?: number;
}

class RiskPropagation {
  /** 调用类型的衰减系数（每跨一层，风险乘以此系数） */
  static readonly DECAY_FACTORS: Record<CallType, number> = {
    direct_call: 0.8,          // 直接函数调用：强耦合，衰减少
    http_api: 0.6,             // HTTP 调用：有接口契约，衰减中
    mq_event: 0.4,             // MQ 消息：松耦合，衰减多
    config_reference: 0.3,     // 配置引用：最松
    dynamic_dispatch: 0.5,     // 动态分派：不确定性高
  };

  static readonly MIN_RISK_THRESHOLD = 0.15;  // 低于此值停止展开
  static readonly MAX_FANOUT_PER_LAYER = 20;   // 每层最多展开 20 个节点
  static readonly MAX_DEPTH = 5;               // 硬上限安全网

  /** 根据节点属性推导初始风险值（Step 1 LLM 判断 + 规则 baseline） */
  computeInitialRisk(node: CallNode): number {
    if (node.isPublicApi)                           return 1.0;  // 公网 API 入口
    if (node.isAuthCritical || node.isPayment)      return 0.9;  // 鉴权/支付
    if (node.isExportedSymbol)                      return 0.7;  // 跨仓导出符号
    if (node.isTestHelper)                          return 0.1;  // 测试辅助，低风险
    return 0.5;                                                   // 内部工具函数默认
  }

  propagate(rootNode: CallNode, initialRisk?: number): RiskNode[] {
    const risk = initialRisk ?? this.computeInitialRisk(rootNode);
    const queue: Array<[CallNode, number, number]> = [[rootNode, risk, 0]];
    const visited = new Set<string>();
    const resultNodes: RiskNode[] = [];

    while (queue.length > 0) {
      const [node, nodeRisk, depth] = queue.shift()!;

      if (visited.has(node.id)) continue;
      visited.add(node.id);

      const riskNode: RiskNode = {
        node,
        propagatedRisk: nodeRisk,
        depth,
        truncated: depth >= RiskPropagation.MAX_DEPTH,
      };
      resultNodes.push(riskNode);

      if (depth >= RiskPropagation.MAX_DEPTH) continue;

      let callers = getCallers(node);

      // 扇出剪枝：优先展开高风险调用者
      if (callers.length > RiskPropagation.MAX_FANOUT_PER_LAYER) {
        riskNode.prunedCallers = callers.length - RiskPropagation.MAX_FANOUT_PER_LAYER;
        callers = this.prioritizeCallers(callers).slice(0, RiskPropagation.MAX_FANOUT_PER_LAYER);
      }

      for (const caller of callers) {
        const callType = classifyCall(node, caller);
        const decay = RiskPropagation.DECAY_FACTORS[callType];
        const newRisk = nodeRisk * decay;

        if (newRisk < RiskPropagation.MIN_RISK_THRESHOLD) {
          // 已识别但不再深入
          resultNodes.push({ node: caller, propagatedRisk: newRisk, depth: depth + 1, belowThreshold: true });
          continue;
        }

        queue.push([caller, newRisk, depth + 1]);
      }
    }

    return resultNodes;
  }

  /** 扇出过大时，按风险排序只展开 Top N */
  prioritizeCallers(callers: CallNode[]): CallNode[] {
    return [...callers].sort((a, b) => {
      const score = (c: CallNode) =>
        (c.isPublicApi ? 8 : 0) +
        (c.isCriticalPath ? 4 : 0) +
        c.changeFrequency * 2 -
        c.testCoverage;
      return score(b) - score(a);
    });
  }
}
```

### 初始风险推导与 P0/P1/P2 映射

`computeInitialRisk()` 将 Step 1 LLM 的语义判断转为数值，作为传播起点：

| 节点属性 | 初始风险值 | 典型场景 |
|---------|-----------|---------|
| `isPublicApi` | 1.0 | 公网 REST/GraphQL 入口 |
| `isAuthCritical \|\| isPayment` | 0.9 | 鉴权中间件、支付处理器 |
| `isExportedSymbol` | 0.7 | 跨仓 SDK 导出的公共接口 |
| *(default)* | 0.5 | 内部工具函数 |
| `isTestHelper` | 0.1 | 测试辅助函数 |

传播后的 `propagatedRisk` 映射到报告等级（阈值可通过 `project_config.risk_thresholds` 调整）：

| 等级 | 风险值范围 | 含义 |
|------|-----------|------|
| P0   | ≥ 0.6     | 高风险，必须处理 |
| P1   | 0.3 – 0.6 | 中风险，建议处理 |
| P2   | 0.15 – 0.3| 低风险，回归验证 |
| P3   | < 0.15    | 极低风险，记录观察（对应 MIN_RISK_THRESHOLD 以下的"已识别未深入"节点） |

默认阈值：`{ p0: 0.6, p1: 0.3, p2: 0.15 }`。

### 实际行为对比

| 场景 | 固定3层 | 风险衰减 |
|------|---------|---------|
| shared-lib 被 50 仓直接调用 | Layer 1 爆出 50 个 P0 | 只展开 Top 20，其余标注"已识别未深入" |
| 核心鉴权函数变更 | 3 层截断可能漏掉支付链路 | direct_call ×0.8 衰减慢，自然展到 4-5 层 |
| 工具函数 format_date() | 3 层全展产出大量 P2 噪音 | 起始风险低，1-2 层就衰减到阈值 |
| MQ 事件传播 | 3 层可能到达 | MQ ×0.4 衰减快，2 跳就低于阈值（合理：松耦合） |

### 报告格式

```markdown
### P0 高风险（risk ≥ 0.6）
| 节点 | 风险值 | 路径 |
|------|--------|------|
| cvm-api/views/login.py:18 | 0.80 | shared-lib → cvm-api (direct_call) |
| payment-service/handler.py:42 | 0.64 | shared-lib → cvm-api → payment (direct×2) |

### P1 中风险（0.3 ≤ risk < 0.6）
| 节点 | 风险值 | 路径 |
|------|--------|------|
| monitor-agent/check.py:7 | 0.48 | shared-lib → monitor (http_api) |

### 已识别未深入（risk < 0.15 或被剪枝）
- 12 个节点风险值低于阈值
- 3 个节点因扇出过大被剪枝（billing 仓 15 调用者中只分析 Top 5）
```

---

## 19. 57 仓 Git 存储方案（D6）

> ⚠️ **存储方案已被 `cross-repo-impact-analysis.md` §7「仓库存储」覆盖。**
> 主要差异：规格文档采用**双模式 worktree**（持久 worktree 供索引服务 + 临时 worktree 供分析任务），本段只设计了临时 worktree。
> 本段的"为什么不用 NFS"分析、磁盘估算、并发安全论证仍有效。

### 架构：本地 SSD bare repo + per-task worktree

```
/data/repos/                          # 持久化目录（本地 SSD）
├── bare/                             # bare repo（只存 git 对象，无工作树）
│   ├── cvm-api.git/                  # ~200MB
│   ├── auth-service.git/
│   └── ... (57个)                    # 总计 ~5-8GB（--filter=blob:none）
│
├── worktrees/                        # 临时工作树（per-task，用完即删）
│   ├── task-abc123/                  # 某次分析任务
│   │   ├── cvm-api/                  # PR branch
│   │   └── auth-service/            # main（对照）
│   └── task-def456/                  # 另一个并发任务（互不干扰）
│       ├── cvm-api/                  # 不同 PR branch
│       └── payment-service/
│
└── index/                            # ast-grep 预计算索引（可选）
    └── ...
```

### 核心实现

```typescript
import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const BARE_DIR = "/data/repos/bare";
const WORKTREE_DIR = "/data/repos/worktrees";

interface RepoConfig {
  name: string;
  gitUrl: string;
}

interface PrInfo {
  repo: string;
  headSha: string;
}

class RepoManager {
  /** 首次部署时 clone bare repos（只执行一次） */
  ensureBareRepos(allRepos: RepoConfig[]): void {
    for (const repo of allRepos) {
      const barePath = path.join(BARE_DIR, `${repo.name}.git`);
      if (!fs.existsSync(barePath)) {
        execFileSync("git", ["clone", "--bare", "--filter=blob:none", repo.gitUrl, barePath]);
      }
    }
  }

  /** 增量更新（只拉 objects，不 checkout。很快） */
  fetchLatest(repoName: string): void {
    const barePath = path.join(BARE_DIR, `${repoName}.git`);
    spawnSync("git", ["fetch", "--all", "--prune"], { cwd: barePath, timeout: 60_000 });
  }

  /**
   * 为分析任务创建独立工作树，用完自动清理。
   * 并发安全：每个 task 独立目录，--detach 避免 branch name 冲突。
   */
  async withTaskWorktree<T>(
    taskId: string,
    repoName: string,
    ref: string,
    fn: (wtPath: string) => Promise<T>
  ): Promise<T> {
    const barePath = path.join(BARE_DIR, `${repoName}.git`);
    const wtPath = path.join(WORKTREE_DIR, taskId, repoName);

    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    execFileSync("git", ["worktree", "add", "--detach", wtPath, ref], { cwd: barePath });

    try {
      return await fn(wtPath);
    } finally {
      spawnSync("git", ["worktree", "remove", "--force", wtPath], { cwd: barePath });
    }
  }

  /** 为一次分析准备所需 worktree（只建需要的，不是全部 57 个） */
  async prepareForAnalysis(taskId: string, prInfo: PrInfo): Promise<Record<string, string>> {
    const changedRepo = prInfo.repo;
    this.fetchLatest(changedRepo);

    // 两阶段预筛（在 bare repo 上跑，见 §15）
    const hitRepos = await this.preFilterRepos(prInfo);

    // 只为命中仓库创建 worktree
    const worktrees: Record<string, string> = {};
    for (const repo of [changedRepo, ...hitRepos]) {
      this.fetchLatest(repo);
      const ref = repo === changedRepo ? prInfo.headSha : "origin/main";
      const barePath = path.join(BARE_DIR, `${repo}.git`);
      const wtPath = path.join(WORKTREE_DIR, taskId, repo);
      fs.mkdirSync(path.dirname(wtPath), { recursive: true });
      execFileSync("git", ["worktree", "add", "--detach", wtPath, ref], { cwd: barePath });
      worktrees[repo] = wtPath;
    }

    return worktrees;
  }
}
```

### 并发安全

```
# 并发场景：
# Task A: cvm-api@PR#123 + auth-service@main
# Task B: auth-service@PR#456 + cvm-api@main
# 同时执行，互不干扰

# git worktree 允许同一个 bare repo 同时有多个 worktree
# --detach 确保不创建 branch name 冲突
```

### 为什么不用 NFS

| 问题 | NFS 的坑 |
|------|---------|
| ast-grep 性能 | 大量随机读小文件，NFS 延迟 ×10-100 |
| git 操作 | `git worktree add` NFS 上 10s+，本地 <1s |
| 锁文件 | git 的 `.lock` 文件在 NFS 上不可靠 |
| 成本 | 云 NFS 按量计费，57 仓可能很贵 |

**如果必须多节点共享**：bare repo 放网络存储（只做 fetch），worktree 放本地 SSD（高 IOPS）：

```yaml
# K8s Pod spec
volumes:
  - name: bare-repos
    persistentVolumeClaim:
      claimName: repo-bare-pvc     # NFS，存 bare repo
  - name: worktrees
    emptyDir:
      medium: ""                    # 本地磁盘，做 worktree
      sizeLimit: 20Gi
```

### Fetch 策略

```typescript
const FETCH_POLICY = {
  onAnalysisRequest: [
    "changed_repo",         // 只 fetch PR 所在仓库
    "hit_repos",            // 预筛命中仓库
  ],
  periodicBackground: {
    interval: "5min",       // 高频仓库后台 fetch
    repos: "top_10_by_pr_frequency",
  },
  daily: {
    interval: "1day",       // 凌晨全量 fetch
    repos: "all_57",
  },
} as const;
```

### 磁盘估算

| 项目 | 大小 |
|------|------|
| 57 bare repo（`--filter=blob:none`） | ~3-5 GB |
| 单次分析 worktree（5-10 仓） | ~1-3 GB |
| 并发 5 个任务 | ~5-15 GB |
| **总计推荐配置** | **20-30 GB SSD** |

---

## 20. 准确性优先的成本策略（D7）

### 设计原则

```
原则1: 宁可多花钱多验证，不可少花钱少看
原则2: 不确定的节点标"不确定"，不标"安全"
原则3: LLM 不确信时，自动追加一轮工具验证
原则4: 输出中明确标注置信度
```

### 双模式配置

系统支持两种分析模式，通过 `project_config.yaml` 切换：

```yaml
# project_config.yaml
analysis_mode: accuracy_first  # accuracy_first | budget_balanced

# 省钱模式覆盖项（仅 budget_balanced 生效）
budget_balanced_overrides:
  max_verification_rounds_per_node: 1   # accuracy_first = 3
  cross_validation: false               # accuracy_first = true
  preferred_model: claude-haiku-4-5     # accuracy_first = claude-sonnet-4-5
  skip_cross_validation_above_confidence: 0.7  # 置信度 >0.7 直接跳过二次验证
```

| 配置项 | accuracy_first | budget_balanced |
|--------|---------------|-----------------|
| 验证轮数/节点 | 3 | 1 |
| 交叉验证 | 是 | 否 |
| 模型 | claude-sonnet-4-5 | claude-haiku-4-5 |
| 典型成本/PR | $1–3 | $0.2–0.5 |
| 适用场景 | 核心仓库、上线前 | 草稿 PR、低优先级变更 |

### 实现

```typescript
type RiskLevel = "P0" | "P1" | "P2" | "NEEDS_HUMAN_REVIEW";

interface AnalysisResult {
  riskLevel: RiskLevel;
  confidence: number;
  note?: string;
}

interface AnalyzerConfig {
  maxVerificationRoundsPerNode: number;
  crossValidation: boolean;
  skipCrossValidationAboveConfidence?: number;
}

const ACCURACY_FIRST_CONFIG: AnalyzerConfig = {
  maxVerificationRoundsPerNode: 3,
  crossValidation: true,
  // skipCrossValidationAboveConfidence 未设置 → 默认 1.0 → 永远不跳过
};

const BUDGET_BALANCED_CONFIG: AnalyzerConfig = {
  maxVerificationRoundsPerNode: 1,
  crossValidation: false,
  skipCrossValidationAboveConfidence: 0.7,
};

class AccuracyFirstAnalyzer {
  constructor(private readonly config: AnalyzerConfig = ACCURACY_FIRST_CONFIG) {}

  async analyzeNode(node: CallNode): Promise<AnalysisResult> {
    // 第一轮：初步判断
    let result = await llmAnalyze(node, { context: this.getContext(node) });
    let rounds = 1;

    // 置信度 < 0.8 → 追加上下文验证
    if (result.confidence < 0.8 && rounds < this.config.maxVerificationRoundsPerNode) {
      const extraContext = await this.readSurroundingCode(node, 50);
      result = await llmAnalyze(node, { context: extraContext });
      rounds++;
    }

    // 仍不确信 → 独立 prompt 交叉验证
    const skipThreshold = this.config.skipCrossValidationAboveConfidence ?? 1.0;
    const shouldSkipCrossValidation = result.confidence >= skipThreshold;

    if (
      result.confidence < 0.8 &&
      this.config.crossValidation &&
      !shouldSkipCrossValidation &&
      rounds < this.config.maxVerificationRoundsPerNode
    ) {
      const extraContext = await this.readSurroundingCode(node, 50);
      const secondOpinion = await llmAnalyzeIndependent(node, extraContext);
      result = this.reconcile(result, secondOpinion);
      rounds++;
    }

    // 最終仍不确信 → 标注"需人工确认"
    if (result.confidence < 0.7) {
      return {
        ...result,
        riskLevel: "NEEDS_HUMAN_REVIEW",
        note: `AI 置信度仅 ${(result.confidence * 100).toFixed(0)}%，建议人工确认`,
      };
    }

    return result;
  }

  private reconcile(opinionA: AnalysisResult, opinionB: AnalysisResult): AnalysisResult {
    /** 两个独立判断不一致时的处理 */
    if (opinionA.riskLevel === opinionB.riskLevel) {
      return { ...opinionA, confidence: Math.min(opinionA.confidence + 0.15, 1.0) };
    }
    // 不一致 → 取更高风险 + 标注分歧
    const higher = riskRank(opinionA.riskLevel) >= riskRank(opinionB.riskLevel) ? opinionA : opinionB;
    return {
      riskLevel: higher.riskLevel,
      confidence: 0.5,
      note: `分析分歧：${opinionA.riskLevel} vs ${opinionB.riskLevel}`,
    };
  }
}
```

### 故障安全限制（防死循环，非省钱）

```typescript
const SAFETY_LIMITS = {
  maxLlmCallsPerAnalysis: 100,          // 防止验证循环无限追加
  maxDurationMs: 600_000,               // 10 分钟超时返回已有结果
  maxVerificationRoundsPerNode: 3,      // 单节点最多验证 3 轮
  maxTotalNodes: 200,                   // 防止扇出爆炸
  // 触发时标注 "分析未完成，受限于 X"，不静默截断
} as const;
```

### 可观测性（不限制，但看得见）

```typescript
interface TaskCost {
  input: number;
  output: number;
  cacheRead: number;
  totalUsd: number;
}

interface TaskSummary {
  id: string;
  cost: TaskCost;
  durationS: number;
  llmCallCount: number;
  verificationRounds: number;
  needsHumanCount: number;
}

function reportCostSummary(task: TaskSummary): string {
  /** 每次分析结束输出成本摘要 */
  return [
    "┌─────────────────────────────────────┐",
    `│ 分析成本摘要 - ${task.id.slice(0, 16).padEnd(16)}    │`,
    "├─────────────────────────────────────┤",
    `│ Input tokens:  ${String(task.cost.input).padStart(8)} │`,
    `│ Output tokens: ${String(task.cost.output).padStart(8)} │`,
    `│ Cache read:    ${String(task.cost.cacheRead).padStart(8)} │`,
    `│ Total cost:    $${task.cost.totalUsd.toFixed(2).padStart(7)} │`,
    `│ Duration:      ${String(task.durationS).padStart(5)}s │`,
    `│ LLM calls:     ${String(task.llmCallCount).padStart(5)} │`,
    `│ 验证追加次数:  ${String(task.verificationRounds).padStart(5)} │`,
    `│ 人工确认节点:  ${String(task.needsHumanCount).padStart(5)} │`,
    "└─────────────────────────────────────┘",
  ].join("\n");
}
```

### 报告置信度标注格式

```markdown
## 风险传播分析报告

### P0 高风险
| 节点 | 置信度 | 判断依据 | 建议 |
|------|--------|---------|------|
| cvm-api/views/login.py:18 | 🟢 95% | 直接调用，签名匹配已验证 | 需要测试 |
| payment/handler.py:42 | 🟡 72% | 间接调用链，中间层逻辑复杂 | 建议人工确认 |
| billing-php/api.php:88 | 🔴 45% | 两次分析结论不一致 | **需人工确认** |

### 分析元信息
- LLM 调用：23 次（含 7 次验证追加）
- Token：~85K input + ~12K output
- 预估成本：$1.2
- 2 个节点触发交叉验证，1 个标记"需人工确认"
```

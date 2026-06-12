# pi-skill Prompt 优化建议

> 对照 [ECC_SKILL_DESIGN_LEARNINGS.md](./ECC_SKILL_DESIGN_LEARNINGS.md) 14 条"健康 skill checklist"
> 审视 `packages/pi-skill/SKILL.md`（570 行 / 主文件）+ `references/risk-rules.md`（35 行）+ `scripts/scan-callers.sh`（30 行）
>
> **结论**：pi-skill 的 **业务逻辑** 已经很扎实——5 步流水线、严格 schema、priority/severity 二维拆分，这些是 ECC 同类 skill 的"模范"。**主要优化空间在结构与维护性**：主文件过长、缺少标准化的触发声明 / 输出前自检 / Examples / Anti-Patterns。

---

## 一、Checklist 现状对照

| #  | 健康指标                                    | pi-skill 现状                | 评分    |
| -- | --------------------------------------- | -------------------------- | ----- |
| 1  | yaml frontmatter（name/description/origin/tools） | ❌ 完全没有 frontmatter         | **缺**  |
| 2  | description 内 TRIGGER + DO NOT TRIGGER  | ❌ 没 description            | **缺**  |
| 3  | "When to Use" / "When NOT to Use" 两节    | ❌ 直接进入"输入"和分析步骤            | **缺**  |
| 4  | Phase 编号 + 每阶段输入输出表                     | ✅ Step 1-6 编号清晰            | 合格    |
| 5  | Phase 0 上下文探针                           | ⚠️ 没有显式 Step 0；隐式假定 AGENTS.md 已注入  | **可加** |
| 6  | severity 与 priority 拆分                  | ✅ 已是范例                     | 满分    |
| 7  | 输出前自检速查表                                | ❌ 没有                       | **缺**  |
| 8  | Output Format + schema_version          | ✅ `cross-repo-impact/2.0` schema 严格 | 满分  |
| 9  | Anti-Patterns 节                         | ⚠️ 散落在文中，没集中               | **可整合** |
| 10 | Related Skills 表                        | ❌ 没有                       | **缺**  |
| 11 | 至少 2 个端到端 Examples                      | ⚠️ Step 5 给了 schema 示例，但缺"完整 input → output"端到端 | **可加** |
| 12 | 主 SKILL.md ≤ 400 行                      | ❌ 570 行，需瘦身                | **缺**  |
| 13 | fixtures / regression eval              | ⚠️ 有 `analysis-service/__tests__/`，但 pi-skill 自己没有 eval 层 | **可加** |
| 14 | description ≤ 30 词                      | ❌ 没 description            | **缺**  |

**总分**：满分 14 项，达成 2 项，部分达成 4 项，缺失 8 项。优化空间集中在**结构合规性**而不是**业务逻辑**。

---

## 二、按优先级排序的优化清单

### P0：必做（修一次受益长期）

#### 优化 1：补全 yaml frontmatter

当前 SKILL.md 第一行直接是 `# DeepInsight Cross-Repo Analysis Skill`。无法被 ECC/Skill router 识别。

建议改为：

```markdown
---
name: deepinsight-cross-repo-analysis
description: >-
  Diff 跨仓库影响范围分析。读取 git diff 与各仓 AGENTS.md，
  追踪上下行调用链，按 priority/severity 二维矩阵评估风险，
  输出 cross-repo-impact/2.0 schema 报告。
  TRIGGER when: 收到 patch 输入需要做跨仓影响分析、风险评估、回归测试场景生成。
  DO NOT TRIGGER when: 单文件代码 review、纯语法/格式建议、不涉及调用链的 lint。
origin: deepinsight
tools: Read, Bash, Grep, Glob
metadata:
  version: "2.0"
  schema_version: "cross-repo-impact/2.0"
---
```

**收益**：description 同时承担"路由"与"摘要"，全 session 加载也只 ~50 词。

---

#### 优化 2：抽 Step 5 的 schema 详情到 references/

`Step 5: 输出报告` 这一节包含：

- 顶层结构表（30 行）
- ID 命名规则（10 行）
- 完整示例 JSON（150 行）
- 字段约束清单（80 行）
- 旧字段→新字段速查表（30 行）

**总计 ~300 行，占主文件 53%**。这些都是"字典型 reference"，不是流程主线。

建议拆为：

```text
packages/pi-skill/
  SKILL.md                          # 主流程（保留 step 1-6 的"做什么"）
  references/
    risk-rules.md                   # 已有
    output-schema.md                # NEW: schema 字段约束清单 + 完整示例
    schema-migration.md             # NEW: 旧字段 → 新字段速查表
    domain-routing.md               # NEW: graphify 知识库路由 + AGENTS.md 探针
```

主文件 Step 5 缩为：

```markdown
### Step 5：输出报告（cross-repo-impact/2.0 schema）

按 [`references/output-schema.md`](references/output-schema.md) 严格输出，
用 ```json ... ``` 包裹。所有字段名 snake_case，schema_version 固定为
`"cross-repo-impact/2.0"`。

关键约束摘要（违反任一条会导致 pipeline 解析失败）：
1. `symbols[].id = SYM-NNN`，`test_scenarios[].id = RT-NNN`，`unanalyzable[].id = UA-NNN`
2. 入口节点用结构化字段 `is_entry: true` + `entry_kind`，禁止在 `domain_context` 写 `[ENTRY]` 字符串
3. `severity` 闭合枚举 `high/medium/low`（不接受 `critical`/`info`）
4. `priority`（行动紧迫度）与 `severity`（影响量级）独立填写
5. 任何字符串字段不得包含 emoji 或 `[ENTRY]` 装饰文本

旧版本字段迁移：见 [`references/schema-migration.md`](references/schema-migration.md)
完整示例：见 [`references/output-schema.md`](references/output-schema.md) §Example
```

**收益**：

- 主文件从 570 行 → ~280 行
- 维护时改 schema 只动 references，避免误改主流程
- LLM 在不需要看完整 schema 时（仅 step 1-3 推理阶段）token 节省 ~3000

---

#### 优化 3：加 Step 0 上下文探针

当前 skill 隐式假定"分析服务已经注入 AGENTS.md / GLOBAL_PATTERNS.md / 知识库描述"，但没有让 agent 主动核对。建议加：

```markdown
### Step 0：上下文体检（30 秒，必做）

在动手前先核对：

| 必备资源              | 缺失时的行为                                |
| ----------------- | ------------------------------------- |
| diff 文件存在且可读      | 报错并停止                                  |
| 相关仓 AGENTS.md 已注入 | 在 unanalyzable[] 写 missing_repo 项     |
| 仓库 workspace 可访问  | 检查 `<repos_root>/<repo>/` 是否存在        |
| graphify 知识库路由表   | 若声明则记下 graph 路径与 keywords，按需调用       |

完成后，在主 reasoning 中显式声明："上下文齐备 / 缺 X，已记入 unanalyzable"。
```

**收益**：避免静默走完 5 步发现"原来 AGENTS.md 没注入"导致全部 call_tree 为空。

---

#### 优化 4：加"输出前自检"速查表

模仿 `agent-architecture-audit` 的 Quick Diagnostic Questions，加一节：

```markdown
## 输出前自检（提交报告前过一遍）

| # | 问题                                              | 若 Yes →                              |
|---|-------------------------------------------------|--------------------------------------|
| 1 | 每个 symbol 是否都有 SYM-NNN id？                    | 修：补 id                              |
| 2 | call_tree 是否追到了入口仓库（cvm_api / cxm_api / 调度器）？ | 修：继续追 step 2，否则降置信度                  |
| 3 | 至少一个 call_tree 节点 is_entry=true 了吗？           | 修：识别入口或在 unanalyzable 解释为何无入口         |
| 4 | priority=P0/P1 的 risk_table 行 test_coverage 写了吗？ | 修：补 has_test/partial/no_test          |
| 5 | downstream_contracts 触达 sink 的项 sink 字段是对象不是 null？ | 修：补 {type, repo}                    |
| 6 | test_scenarios.assertions 每项只有一个 kind？         | 修：拆成多个 assertion 元素                  |
| 7 | 任何字符串字段含 emoji / [ENTRY] / mermaid 装饰？        | 修：清洗（mask sweep 会拦）                   |
| 8 | schema_version 字段值 == "cross-repo-impact/2.0"? | 修：必填且固定                              |
| 9 | 置信度 < 0.7 的节点是否标 NEEDS_HUMAN_REVIEW？          | 修：标记                                 |
```

**收益**：把"消费方报错原因"前置到 agent 自检，减少 schema 反复修复。

---

### P1：建议做（提升可维护性）

#### 优化 5：拆出 Anti-Patterns 集中节

当前文中分散写了不少"禁止 / 不得"，整理到末尾一节：

```markdown
## Anti-Patterns

- 不要在 `domain_context` 用 `[ENTRY]` 字符串标记入口（mask sweep 拦截）
- 不要把多种检查塞进一个 `assertion.expression`（每项只有一个 kind）
- 不要用 `severity: critical / info`（已收窄到 high/medium/low）
- 不要在 priority 字段写 severity 含义（两者独立）
- 不要在 unanalyzable 写裸字符串（必须结构化对象）
- 不要在 priority < 0.8 时跳过条件追加（强制 ±50 行上下文）
- 不要为了缩短输出删 schema 必填字段（pipeline 会丢整份报告）
- 不要把代码行号写入 hermes-memory（代码会变）
- 不要在子 agent 里做 Step 3 风险传播（只授权 Step 2）
- 不要广撒 graphify 查询（≤3 次/任务，按 keywords 选 1 个库）
```

**收益**：reviewer 一眼看出"哪些是 hard rule"，做 PR review 时直接逐条对。

---

#### 优化 6：加 Related Skills / Hand-off 表

```markdown
## Related Skills

| 时机                                     | 交棒到                                    |
| -------------------------------------- | -------------------------------------- |
| 单仓库内代码审查（不涉及跨仓）                       | 用 ECC `code-review` / `flutter-dart-code-review` |
| diff 解析失败 / 仓库未同步                      | 触发 `deepinsight-repo-sync` CronJob 后重跑 |
| 跨会话需要查询历史风险路径                          | 调用 `pi-hermes-memory` 的 memory_search   |
| 上下文 > 10 仓库或 prompt 紧张                 | 调用 `context-mode` 的 search_knowledge_base |
| AGENTS.md 之外的领域概念                      | 调 graphify (cvm_design_docs / cvm_domain) |
| 3+ 独立符号同时变更                            | 用 pi-subagents 并行 Step 2，主 agent 合并 Step 3-5 |
```

**收益**：让 agent 知道"哪些工作不该自己扛"。

---

#### 优化 7：补 2 个端到端 Examples

模仿 prompt-optimizer 的 Example 1-3，加：

```markdown
## Examples

### Example 1：单符号 + 简单调用链

**Input**：diff 改 `verify_token`（auth.py:42, `is` → `==`）

**Output**：
- 1 个 SYM（initial_severity: high，因 is→==）
- call_tree: 3 层（auth.py → middleware.py → cvm_api/views/RunInstances.py）
- 1 个 RT（target_api: RunInstances）
- risk_table: 1 行 P1
- downstream_contracts: 1 项（CDbAccess.update，sink=db_write，medium）

### Example 2：多符号 + 入口缺失

**Input**：diff 改 3 个内部 helper 函数，无任何对外 API 调用

**Output**：
- 3 个 SYM（initial_severity: low/medium）
- 所有 call_tree 末端 is_entry=false（entry_kind=internal_only）
- 1 个 unanalyzable（category: not_imported）
- test_scenarios: [] （没有 P0/P1 + 无 sink）

### Example 3：动态分派 + 不可分析

**Input**：diff 改 dispatch_table 字典 key，调用方用 `getattr(obj, key)()`

**Output**：
- 1 个 SYM
- call_tree 深度 1（无法静态展开）
- 1 个 unanalyzable（category: runtime_only, suggested_handling: manual）
- 整份报告 priority 拉到 NEEDS_HUMAN_REVIEW
```

**收益**：让首次接触 skill 的 LLM/工程师快速对齐"什么样的 input 该产出什么样的 output"。

---

### P2：可选优化（长期收益）

#### 优化 8：加 fixtures/ + regression eval

参考 `agent-eval`，在 `packages/pi-skill/fixtures/` 放 5-10 个固定 diff 样例，每个搭配 expected output，pre-commit 跑：

```bash
pnpm --filter pi-skill test:eval
```

校验：

- schema_version 正确
- 所有 SYM-NNN id 唯一
- call_tree 深度合理（叶子或 sink 收敛）
- assertion.kind / channel 组合合法

记 `pass@1` / `pass@3` 指标到 docs/releases/<version>/eval-summary.md。

---

#### 优化 9：把成本不对称原则上提到主线

当前"成本不对称原则"埋在文末，作用是劝 agent "怀疑就读代码不要猜"。建议提到 Step 0 之前，作为**核心心法**单独成节：

```markdown
## 核心心法

1. **成本不对称**：读代码 / ast-grep 验证 → 便宜；猜测 / 宣称"没有更多调用者" → 昂贵。怀疑就扫。
2. **入口为王**：找不到对外可观察入口（HTTP/调度/MQ/RPC）的风险评估都是空中楼阁。
3. **二维分桶**：priority 是动作紧迫度，severity 是影响量级；测试覆盖度是 priority 的关键调节因子。
4. **结构 > 字符串**：所有输出走 schema，禁止用 `[ENTRY]` / emoji 等装饰文本承载语义。
5. **置信度 < 0.7 → 标 NEEDS_HUMAN_REVIEW**，不要硬编 priority。
```

**收益**：5 行心法，比文档中 200 行规则更容易在长上下文里被坚守。

---

#### 优化 10：description 同步到 ECC skill router 命名规范

ECC 的 description 长这样（一行长文本）：

```yaml
description: >-
  Full-stack diagnostic for agent and LLM applications. Audits the 12-layer
  agent stack for wrapper regression, memory pollution, tool discipline failures,
  hidden repair loops, and rendering corruption. Produces severity-ranked
  findings with code-first fixes.
```

deepinsight pi-skill 的 description 应同样精简到 1 段、≤ 60 词、首句即触发摘要。

---

## 三、推荐落地顺序

```text
Round 1（不破坏现网行为）：
  ├─ 优化 1：补 frontmatter
  ├─ 优化 2：拆 references/
  ├─ 优化 4：加输出前自检表
  └─ 优化 9：核心心法上提

Round 2（改 prompt 行为）：
  ├─ 优化 3：加 Step 0 上下文探针
  ├─ 优化 5：Anti-Patterns 集中节
  ├─ 优化 6：Related Skills 表
  └─ 优化 7：3 个端到端 Examples

Round 3（建立长期闭环）：
  └─ 优化 8：fixtures/ + regression eval（pass@k 指标）
```

每一轮可独立 PR，互不依赖。Round 1 是纯结构改写，可用 fixtures 在本地端到端跑一遍 pi 验证未改变行为再 merge。

---

## 四、可量化的预期收益

| 维度          | 现状           | Round 1 后     | Round 2 后     | Round 3 后     |
| ----------- | ------------ | ------------ | ------------ | ------------ |
| SKILL.md 行数 | 570          | ~280         | ~320         | ~320         |
| 全 session token 占用 | ~12k         | ~6k          | ~7k          | ~7k          |
| schema 解析失败率 | 估 ~10%       | ~10%（结构未变）   | ~3%          | ~1%          |
| 新人接入周期      | 0.5d 看懂      | 0.5d         | 0.2d         | 0.2d         |
| 回归发现率       | 无            | 无            | 无            | 有 pass@k 指标  |

---

## 五、不建议改的地方

1. **Step 1-4 的业务逻辑**：5 步流水线 + risk-rules 表 + 调用类型衰减权重，是 deepinsight 的核心知识，不要"为了向 ECC 看齐"动它。
2. **graphify / context-mode / pi-hermes-memory / pi-web-access / pi-subagents 五个扩展**：是和分析服务深度耦合的能力，ECC 没有同类，不要替换或合并。
3. **`cross-repo-impact/2.0` schema**：消费侧（report renderer / pipeline）已强依赖，调整只允许通过 schema_version bump + 迁移表（已经在 Step 5 维护了）。

---

## 六、参考

- ECC 设计经验：[ECC_SKILL_DESIGN_LEARNINGS.md](./ECC_SKILL_DESIGN_LEARNINGS.md)
- 当前 skill 主文件：[`packages/pi-skill/SKILL.md`](../packages/pi-skill/SKILL.md)
- 现有 references：[`packages/pi-skill/references/risk-rules.md`](../packages/pi-skill/references/risk-rules.md)
- 现有 scripts：[`packages/pi-skill/scripts/scan-callers.sh`](../packages/pi-skill/scripts/scan-callers.sh)

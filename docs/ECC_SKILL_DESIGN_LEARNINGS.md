# ECC Skill 设计经验提炼

> 来源：通读 `/mnt/ECC/skills/` 下与 prompt 工程、agent 编排、code review、agent audit、token 预算相关的 9 个核心 skill：
> `prompt-optimizer` · `eval-harness` · `agent-architecture-audit` · `agent-eval` ·
> `skill-comply` · `skill-scout` · `rules-distill` · `code-tour` · `context-budget`
>
> 本文档总结 ECC 在 Skill/Prompt 设计上反复出现的"九个支柱"，作为 deepinsight 后续编写 / 重构 skill 时的统一参考。

---

## 1. Frontmatter：skill 的"接口签名"

每个 SKILL.md 顶部都用 yaml frontmatter 把元数据声明清楚，作用类似函数签名：

```yaml
---
name: prompt-optimizer
description: >-
  Analyze raw prompts, identify intent and gaps, match ECC components ...
  TRIGGER when: ...
  DO NOT TRIGGER when: ...
origin: community            # ECC | community | <仓库名>
tools: Read, Write, Edit, Bash, Grep, Glob   # 允许使用的工具白名单
metadata:
  author: YannJY02
  version: "1.0.0"
---
```

关键字段约定：

| 字段          | 作用                                                                 | 注意                       |
| ----------- | ------------------------------------------------------------------ | ------------------------ |
| `name`      | 全仓库唯一 ID                                                            | kebab-case               |
| `description` | **同时承担"路由提示"**：里面 inline 写 `TRIGGER when:` / `DO NOT TRIGGER when:` | 用一段长文本，不要拆成多个 yaml 字段 |
| `tools`     | 显式工具白名单                                                             | 避免误用如 WebFetch           |
| `origin`    | 来源溯源                                                                | community / fork / 内部     |

**经验**：description 既是给人看的简介，也是给 router 用的 trigger，把正负触发都写进去能极大降低误触发。

---

## 2. TRIGGER / DO NOT TRIGGER 双向触发

ECC 几乎所有 skill 在 frontmatter 和"When to Use"双重声明触发条件：

- `prompt-optimizer` 在 description 同时写 "TRIGGER when ..." 和 "DO NOT TRIGGER when ..."
- 区分中英文触发词（`优化prompt` vs `优化代码`）
- 区分**任务意图相近但不同**的关键词（`优化代码` 是 refactor，不是 prompt 优化）

```markdown
### Do Not Use When
- User wants the task done directly (just execute it)
- User says "优化代码", "优化性能" — these are refactoring tasks
- User is asking about ECC configuration (use `configure-ecc` instead)
- User wants a skill inventory (use `skill-stocktake` instead)
- User says "just do it" or "直接做"
```

**为何重要**：LLM router 优先看正向 trigger，但负向 trigger 是防止"语义相邻关键词"导致错误启用的护栏。每个 skill 都应该把"我不该做什么"写下来。

---

## 3. 显式编号 Pipeline（Phase 0 → Phase N）

复杂 skill 都用 **Phase N + 表格** 的固定模板：

| skill                       | Pipeline 形状                                                          |
| --------------------------- | ------------------------------------------------------------------- |
| `prompt-optimizer`          | Phase 0 项目检测 → 1 意图识别 → 2 范围评估 → 3 ECC 组件匹配 → 4 缺失上下文 → 5 工作流推荐       |
| `agent-architecture-audit`  | Phase 1 Scope → 2 Evidence Collection → 3 Failure Mapping → 4 Fix Strategy |
| `code-tour`                 | 1 Discover → 2 Infer Reader → 3 Verify Anchors → 4 Write → 5 Validate |
| `rules-distill`             | Phase 1 Inventory → 2 Cross-read & Verdict → 3 User Review & Execute  |
| `eval-harness`              | 1 Define → 2 Implement → 3 Evaluate → 4 Report                       |

**共性**：

1. **Phase 0 一定是"环境/上下文探针"**——读 CLAUDE.md、检测语言栈、扫描已存在的资源，避免空转。
2. 每个 Phase 都用**表格固定输入/输出**，而不是自由散文。
3. 最后一个 Phase 一定是 **Report / Output**，而不是把"输出"耦合在最后一个动作里。

---

## 4. 维度二分：priority ≠ severity

`agent-architecture-audit` 与 deepinsight 的 pi-skill 都把"严重性"和"行动紧迫度"拆成两个独立维度：

| 维度        | 含义       | 取值                                 |
| --------- | -------- | ---------------------------------- |
| `severity` | 影响**量级** | `critical` / `high` / `medium` / `low` |
| `priority`/`action` | 行动**紧迫度**  | `fix-before-release` / `this-sprint` / `next-cycle` / `backlog` |

**为何重要**：一个 high-severity 但已有完整测试覆盖的变更，priority 应该 ≤ medium；一个 medium 但无任何测试的变更，priority 可以 ≥ high。把两者绑成一个字段，就丢失了"测试覆盖度"这个调节因子。

deepinsight pi-skill 里 `priority(P0..P3) × severity(high/medium/low)` 的二维表已经对了，可以作为标准范式继续复用。

---

## 5. Quick Diagnostic Questions（速查表）

`agent-architecture-audit` 末尾给了一份 7 题速查表：

```markdown
| # | Question                                                  | If Yes →                |
|---|-----------------------------------------------------------|-------------------------|
| 1 | Can the model skip a required tool and still answer?      | Tool not code-gated    |
| 2 | Does old conversation content appear in new turns?        | Memory contamination   |
| ...
```

这是 skill 的"自检 checklist"——用户/agent 在结束后过一遍，避免高频疏漏。

**模板**：每个 skill 应该有一个 **5-10 题的"输出前自检"**，每题都对应一个具体失败模式 + 处置建议。

---

## 6. Severity Model + 行动表

每个产出风险评估的 skill 都有一张"严重性 → 行动"对照表：

```markdown
| Level    | Meaning                                                          | Action               |
|----------|------------------------------------------------------------------|----------------------|
| critical | Agent can confidently produce wrong operational behavior         | Fix before release   |
| high     | Agent frequently degrades correctness or stability               | Fix this sprint      |
| medium   | Correctness usually survives but output is fragile or wasteful   | Plan for next cycle  |
| low      | Mostly cosmetic or maintainability issues                        | Backlog              |
```

- 取值是**闭合枚举**（4 档），不允许 freeform。
- 每档明确"Action"——避免 reviewer 自己脑补。
- deepinsight pi-skill 已经收窄了 `severity` 到 `high/medium/low`（删掉 `critical/info`），是同一思路。

---

## 7. Output Format / Report Schema

ECC 几乎所有产出型 skill 都强制 **JSON Schema 形式的输出**，并用 `schema_version` 字段做兼容：

```json
{
  "schema_version": "ecc.agent-architecture-audit.report.v1",
  "executive_verdict": { ... },
  "scope": { ... },
  "findings": [ ... ],
  "ordered_fix_plan": [ ... ]
}
```

设计要点：

1. **`schema_version` 是必填字段**：消费方根据它选择解析路径，避免破坏性升级。
2. **顶层 4-5 个 key**，超出就拆子对象。
3. **数组里的对象用闭合 ID** (`SYM-001` / `RT-001` / `UA-001`)，便于交叉引用。
4. **字段名一致性**：snake_case，永不混 camelCase（pi-skill 早期版本踩过坑）。
5. **旧字段 → 新字段迁移表**：版本升级时单独维护一张速查表，让历史 prompt 也能产出新格式。

`prompt-optimizer` 还把"Output Format"分成了"Section 1-5 + Footer"的固定章节模板，比纯 JSON schema 更适合人读型输出。

---

## 8. Anti-Patterns 节（"不要做"清单）

每个 skill 末尾都有一段 5-10 条的 Anti-Patterns：

```markdown
## Anti-Patterns to Avoid
- Avoid blaming the model before falsifying wrapper-layer regressions.
- Avoid blaming memory without showing the contamination path.
- Do not let a clean current state erase a dirty historical incident.
- Do not treat markdown prose as a trustworthy internal protocol.
- Do not accept "must use tool" in prompt text when code never enforces it.
- Keep findings direct, evidence-backed, and severity-ranked.
```

这是和"When NOT to Use"不一样的层级——

- `When NOT to Use` 处理 **是否启用 skill**
- `Anti-Patterns` 处理 **启用之后哪些动作是错的**

**经验**：Anti-Patterns 来自 bug report 和事后复盘。每次发现"agent 又这样错了"，往这一节追加一条。

---

## 9. Related / 协作矩阵

`prompt-optimizer` 和 `agent-architecture-audit` 都在末尾列出兄弟 skill 的协作关系：

```markdown
## Related Skills

| Component               | When to Reference                              |
|-------------------------|------------------------------------------------|
| configure-ecc           | User hasn't set up ECC yet                     |
| skill-stocktake         | Audit which components are installed           |
| search-first            | Research phase in optimized prompts            |
| blueprint               | EPIC-scope optimized prompts                    |
```

**为何重要**：单个 skill 不是孤立的，要把"什么时候交棒给别的 skill"写明，避免 agent 在一个 skill 里硬扛超出范围的任务。

---

## 10. 两个反复出现的元原则

### 10.1 Deterministic Collection + LLM Judgment（来自 rules-distill）

> 脚本保证收集穷尽，LLM 保证语义判断。

凡是涉及"扫整个仓库 + 给评分"的工作，都把它拆成：

1. **bash 脚本扫描**（确定性、可枚举、便宜）→ 产出原始清单
2. **LLM 跨读**（语义、归纳、判断）→ 在原始清单基础上做归类/打分

deepinsight pi-skill 的"成本不对称原则"是同一思想：

> 读取代码（bash）：便宜。有疑问就读。
> 猜测代码行为：昂贵（猜错会拐到错误方向）。

### 10.2 Search Before Build（来自 skill-scout）

新建任何 skill 前先问：

1. 本仓库已经有同名/近义 skill 吗？(`find ~/.claude/skills`)
2. 上游 marketplace 有吗？(`gh search code "name: keyword" --filename SKILL.md`)
3. 相关 web 资源有吗？

deepinsight 内部对应物：写新分析维度前先看 `packages/pi-skill/SKILL.md` + `references/risk-rules.md` 是否已有近似规则。

---

## 11. Token / Context 预算意识（来自 context-budget）

每个 skill 都被默认计入 session token 预算。粗算：`words × 1.3`。

| 类别            | Skill 内典型规模          | 行动建议                                              |
| ------------- | ------------------- | ------------------------------------------------- |
| skill > 400 行 | 重型                 | 拆 references/                                     |
| agent > 200 行 | 重型                 | 拆 sub-agent                                       |
| description > 30 词 | 全 session 都加载  | 收紧                                              |
| MCP 工具 > 20    | schema 开销 ~10k token | 慎装                                              |

**deepinsight 启示**：pi-skill SKILL.md 当前 570 行，已逼近"重型"阈值。后续维护时优先把 `Step 5 schema 字段约束`、`旧字段→新字段速查表`、`高风险目录` 这种**字典型内容**外移到 `references/`，主文件保留 step 1-6 主线即可。

---

## 12. Examples 节：至少 2-3 个端到端示例

每个 skill 都有完整 input → output 示例。`prompt-optimizer` 给了 3 个：

1. 模糊中文 prompt + 自动检测项目栈
2. 中等 English prompt + Go 项目
3. EPIC 项目 + blueprint skill

**模板要求**：

- 至少一个**最小可行**示例
- 至少一个**典型完整**示例
- 至少一个**边界 / 失败处理**示例

---

## 13. Eval / Compliance 反向闭环

ECC 用 `eval-harness` 和 `skill-comply` 做"skill 是不是真在被遵循"的实证：

- `eval-harness`：pre-commit 写好 capability eval（"Claude 应该能 X"）+ regression eval，跑 `pass@k` 指标
- `skill-comply`：自动生成 supportive / neutral / competing 三档 prompt，对每条规则跑 trace，看 agent 是否真按规则走

**deepinsight 启示**：pi-skill 的输出 schema 已经够严格，但**没有"输出合格率"指标**。可以把现有 `__tests__/` 升级为：

- 给定一组固定 diff fixture
- 跑 pi 端到端
- 用 zod schema 校验每个 symbol/test_scenario 字段
- 记录 `pass@1` / `pass@3` 趋势

---

## 14. Skill 文件结构推荐布局

ECC 中"健康"的 skill 通常长这样：

```text
skills/<name>/
  SKILL.md                  # 主文件，<400 行：frontmatter + when/not + pipeline + output + anti-patterns
  references/
    <topic>.md              # 字典型详尽参考（可被按需查阅，不进 SKILL.md 主线）
  scripts/
    <helper>.sh             # bash 脚本（deterministic collection）
  prompts/
    <task>.md               # subagent 用的 prompt 模板
  fixtures/                 # eval / 端到端测试用的输入样例
  tests/
```

deepinsight `packages/pi-skill/` 已经有 `references/` 和 `scripts/`，结构是对的，只是 SKILL.md 还能进一步瘦身。

---

## 15. 一份"健康 skill"的硬指标 checklist

把上面所有支柱浓缩为一份 binary checklist。新建/重构 skill 时逐条对：

- [ ] 有 yaml frontmatter（name / description / origin / tools）
- [ ] description 内含 TRIGGER when + DO NOT TRIGGER when
- [ ] 有 "When to Use" 与 "When NOT to Use" 两节
- [ ] Pipeline 用 Phase 编号 + 每阶段输入输出表
- [ ] Phase 0 是上下文探针（不是直接动手）
- [ ] severity 与 priority 是两个独立字段
- [ ] 有 "输出前自检" 速查表（5-10 题）
- [ ] 有 Output Format / Report Schema（含 `schema_version`）
- [ ] 有 Anti-Patterns 节（3+ 条）
- [ ] 有 Related Skills 表
- [ ] 至少 2 个端到端 Examples
- [ ] 主 SKILL.md 行数 ≤ 400，重内容外移到 references/
- [ ] 有 fixtures/ 或 tests/ 用于 regression eval
- [ ] description ≤ 30 词，避免全 session token 占用

---

## 附：源文件参考

| ECC skill                      | 主要借鉴点                                       |
| ------------------------------ | ------------------------------------------- |
| `prompt-optimizer`             | TRIGGER 双向触发、Phase 0 探针、Output Format 章节模板 |
| `agent-architecture-audit`     | 12-layer stack、Quick Diagnostic、JSON schema |
| `agent-eval`                   | YAML task + git worktree 隔离、4 项指标          |
| `eval-harness`                 | pass@k、regression eval、4 类 grader           |
| `skill-comply`                 | 跑 prompt 测合规率、temporal ordering            |
| `skill-scout`                  | Search before build、6 步检索流程                 |
| `rules-distill`                | Deterministic + LLM、verdict 闭合枚举            |
| `code-tour`                    | 编号工作流、persona 表、SMIG 写作规则                 |
| `context-budget`               | 4 阶段：Inventory → Classify → Detect → Report |
| `prompt-optimizer Section 1-5` | 强制人读型 Output 模板                            |

> 后续：每发现一个新的"反复出现的优秀模式"，往本文档追加一节。本文档是"共识库"，不是 changelog。

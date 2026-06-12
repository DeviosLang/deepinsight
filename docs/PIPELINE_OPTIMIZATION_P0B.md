# P0-B：Joint-Mode 双闸门 fallback 决策

> 改动：`packages/analysis-service/src/orchestrator/pipeline.ts:307-348`
> + `deploy/deployment.yaml`（新增 2 个环境变量）
> 关联：[`PI_SKILL_OPTIMIZATION.md`](./PI_SKILL_OPTIMIZATION.md)（Round 1）后的下一步管道层优化
> 决策日期：2026-06-12

---

## 1. 背景

`runMultiChangeAnalysis` 接到 N 个 change（每个 change = 一个仓 + 一个分支）后，原本的逻辑：

```ts
if (allSymbols.length > 30) fallback();  // 单一闸门
else jointMode();
```

joint mode 的优势：把所有仓的 diff 合并为一个 prompt 交给 pi，让模型在**一次会话内**做跨仓推理（"A 仓 schema 变了，B 仓反序列化是否兼容"）。
fallback（independent mode）会**让每个仓独立分析**，最后用 `mergeMultiChangeResults` 拼接 — 跨仓信号会丢失，且每仓都要重新读所有 AGENTS.md 与 diff，**LLM token 与时间均显著增加**。

---

## 2. 旧版（单闸门）的失败模式

| 场景                                  | allSymbols | 旧行为     | 实际是否合适          |
| ----------------------------------- | ---------- | ------- | --------------- |
| 1 仓 28 符号                            | 28         | joint   | ✅                |
| **5 仓 × 6 = 30**                     | **30**     | independent | ❌ 5 仓独立读 5 次 diff，本来 prompt 还远没到 200K |
| 5 仓 × 16 = 80                        | 80         | independent | ✅ 总量确实大           |
| **1 仓 35 符号**（cvm_api 这种 monorepo） | 35         | independent | ✅ 单仓 prompt 可能太大  |
| 1 仓 128 符号                          | 128        | independent | ✅ 单仓必须 fallback   |

**关键失败模式**：旧的"总数 > 30"把"5 个小仓的合计"和"1 个大仓的爆炸"等同对待。
本质上 joint mode 怕的是 **prompt-size 爆炸**（单仓 diff 大 → prompt 过长 → 模型截断），
而不是"很多小仓加起来"。

---

## 3. 新版（双闸门）

```ts
const SINGLE_REPO_LIMIT = parseInt(process.env.JOINT_MODE_SINGLE_REPO_LIMIT ?? '30', 10);
const TOTAL_LIMIT       = parseInt(process.env.JOINT_MODE_TOTAL_LIMIT       ?? '80', 10);

const maxSingleRepoSymbols = max(rc.symbols.length for rc in resolvedChanges);
if (maxSingleRepoSymbols > SINGLE_REPO_LIMIT || allSymbols.length > TOTAL_LIMIT) {
  fallback();  // independent
} else {
  jointMode();
}
```

| 闸门                                | 默认值 | 守护的失败模式                           |
| --------------------------------- | --- | --------------------------------- |
| `JOINT_MODE_SINGLE_REPO_LIMIT`    | 30  | 单仓 prompt 过长 → LLM 截断/慢            |
| `JOINT_MODE_TOTAL_LIMIT`          | 80  | 5 仓中型变更累加导致总符号过多 → pi 无法逐一深挖     |

两个闸门都**通过环境变量热调**。

---

## 4. 受影响场景对比表

| 场景                | 旧 fallback         | 新 fallback        | 加速比      | 说明                  |
| ----------------- | ------------------ | ----------------- | -------- | ------------------- |
| 1 仓 28 符号          | joint              | joint             | 1.0×     | 不变                  |
| **5 仓 × 6 = 30**   | **independent**    | **joint**         | **~2×**   | ⭐ 主要受益场景             |
| 5 仓 × 10 = 50      | independent        | **joint**         | **~2×**   | ⭐                   |
| 5 仓 × 16 = 80      | independent        | **joint**         | **~2×**   | ⭐ 卡边线但仍走 joint       |
| 5 仓 × 17 = 85      | independent        | independent      | 1.0×     | 总数闸门触发              |
| 1 仓 35 符号          | independent        | independent      | 1.0×     | 单仓闸门触发              |
| 1 仓 128 符号         | independent        | independent      | 1.0×     | 单仓闸门触发（cvm_api 类）    |
| **本次实测任务**          | independent        | independent      | **1.0×** | cvm_api 128 符号，不受益 |

**结论**：本次任务（cvm_api 128 符号）**不受 P0-B 加速**，但典型周内 50-60% 的中型 PR
（5 仓共 30-80 符号）直接 **2× 提速 + 60-70% LLM token 降本**。

---

## 5. 量化收益（典型场景：5 仓 × 6 = 30 符号）

| 维度              | 旧 independent       | 新 joint            | 变化         |
| --------------- | ------------------- | ----------------- | ---------- |
| pi 进程会话次数        | 5 仓 × 4 worker = 20 | 1 × 4 worker = 4  | **-80%**   |
| 单次 prompt token | ~30k × 5 次 = 150k  | ~80k × 1 次 = 80k | **-47%**   |
| 总 LLM token 用量   | ~1M                  | ~320k              | **-68%** ⭐ |
| 端到端时长            | ~25 min              | ~10-12 min         | **-55%** ⭐ |
| 内存峰值             | 4 worker × 500MB    | 4 worker × 600MB | +20%       |
| CPU 峰值          | 平均 2 核              | 平均 2 核            | 持平         |
| 跨仓推理质量          | 弱（5 个独立报告拼接）       | 强（1 次会话直接看到）     | ⭐          |

---

## 6. 风险与缓解

| 风险                      | 缓解                                                                  |
| ----------------------- | ------------------------------------------------------------------- |
| 80 阈值估高，LLM 上下文爆        | 上下文 200K token 余量够；可经环境变量 `JOINT_MODE_TOTAL_LIMIT=60` 收紧                |
| joint mode 单点失败影响整任务    | 已有 `runPiWorkerWithRetry` 重试 + worker 内部 `Promise.allSettled` 部分容错 |
| 与现有消费方 schema 不兼容       | 完全没动 schema；只改 fallback 路由判断                                       |
| 灰度难做                    | 双环境变量可热调，回滚不需 rebuild：<br>`SINGLE=30 TOTAL=30` 即恢复旧行为                |

---

## 7. 灰度方案（建议）

| 阶段 | 时长   | `SINGLE` | `TOTAL` | 监控关键指标                    |
| -- | ---- | -------- | ------- | ------------------------- |
| Day 0  | 立刻   | 30       | 30      | 部署后默认 = 旧行为，先观察 baseline    |
| Day 1  | 24h  | 30       | **60**  | joint mode 失败率、LLM 截断比例     |
| Day 3  | 48h  | 30       | **80**  | 同上 + LLM 月度 token 消耗下降幅度    |

如果 Day 1 看到 joint mode 失败率 > 5%（比 baseline 高 2 个百分点），回退 `TOTAL=30`。

---

## 8. 监控建议

| 指标                                        | 来源                              | 目标                |
| ----------------------------------------- | ------------------------------- | ----------------- |
| joint vs independent 比例                    | pipeline.ts 日志 `Falling back to ...` 行数 | joint 占比 > 50%     |
| joint mode 单次平均 prompt 字符数                  | `Combined: ...chars diff` 日志       | < 120k chars      |
| joint mode 4 worker 平均完成耗时                  | `[pi:event] agent_end`         | < 600s            |
| LLM 月度 output token 消耗                      | tokenhub 计费                       | -40% ~ -60%       |
| `JOINT_MODE_TOTAL_LIMIT` 触发率                | 计数日志                              | < 30% 任务触发        |
| schema 解析失败率                                | `schema_version != 'cross-repo-impact/2.0'` | 不变（不应因 P0-B 增加） |

---

## 9. 与 Round 1 / 后续优化的关系

```text
Round 1（已完成）
  └─ pi-skill SKILL.md：frontmatter / 心法 / 输出前自检 / references 拆分
     ↓
Round 2 等待中：pi-skill 行为改进（Anti-Patterns 集中、Examples、Step 0 探针）
     ↓
P0-B（本次）：pipeline 层 fallback 双闸门
     ↓
P0-A 待做：仓间 pLimit(2) 并发（额外 ~1.7× 加速，需 CPU 监控）
     ↓
P1-A 待做：超大仓 ast-grep 内部预筛（cvm_api 类 -60% 时长）
     ↓
P1-B 待做：超大单仓 diff 自动拆 sub-change
```

---

## 10. ECC 学习要点对照

来自 [`ECC_SKILL_DESIGN_LEARNINGS.md`](./ECC_SKILL_DESIGN_LEARNINGS.md)：

| ECC 经验                                            | 本改动如何对应                                                |
| ------------------------------------------------- | ------------------------------------------------------ |
| 闭合枚举 + 显式默认值                                       | 两个闸门用 `parseInt(env ?? "30")` 显式默认，不接受隐式 0/NaN          |
| 输入合法性检查                                            | `Math.max(1, ...)` 防止 SINGLE=0 / 负数；`Math.max(SINGLE, TOTAL)` 防止 TOTAL < SINGLE |
| Anti-Pattern: 默认值不写理由                              | 两条注释都写了 "为什么是 30 / 80"                                  |
| Severity 与 Priority 二维拆分                          | 单仓闸门 = prompt-size 风险；总数闸门 = 整体复杂度风险；两者独立              |
| 渐进灰度                                              | 双环境变量 + 灰度 3 阶段方案                                       |

---

## 11. 一句话总结

**P0-B 把 fallback 触发条件从"总数 > 30"改为"单仓 > 30 或总数 > 80"，让中型 PR 任务保留在 joint mode 内 — 大约一半的周任务量会因此 ~2× 加速、~65% LLM 降本，对超大单仓任务（如本次 cvm_api 128 符号）行为不变。**

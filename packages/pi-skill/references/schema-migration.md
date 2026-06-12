# Schema 迁移速查表（旧字段 → 新字段）

> 由 [`SKILL.md`](../SKILL.md) 引用。如果不小心写了旧字段，按本表转成新字段。
>
> 当前版本：`cross-repo-impact/2.0`（详见 [`output-schema.md`](./output-schema.md)）

---

## 顶层

| 旧名 | 新名 | 备注 |
|------|------|------|
| `summary` 顶层对象 | _(移除)_ | 由消费者自行汇总 |
| `untrackable: string[]` | `unanalyzable[]` | 改成结构化对象 |
| `globalPatternsMatched` | `global_patterns_matched` | snake_case |

## symbols[]

| 旧名 | 新名 | 备注 |
|------|------|------|
| `symbols[].diffSemantic` | `symbols[].diff_semantic` | snake_case |
| `symbols[].initialRisk` | `symbols[].initial_severity` | 重命名 + 收窄到 `high/medium/low`（旧 `critical`→`high`，旧 `info`→`low`） |
| `symbols[].callTree` | `symbols[].call_tree` | snake_case |
| `symbols[].riskTable` | `symbols[].risk_table` | snake_case |
| `symbols[].downstreamContracts` | `symbols[].downstream_contracts` | snake_case |

## call_tree[]

| 旧名 | 新名 | 备注 |
|------|------|------|
| `callTree[].callType` | `call_tree[].call_type` | snake_case |
| `callTree[].risk` | `call_tree[].priority` | **重命名**（语义未变，仍是 P0..P3） |
| `callTree[].testCoverage` | `call_tree[].test_coverage` | snake_case |
| `callTree[].domainContext` 含 `[ENTRY]` | 改用 `is_entry: true` + `entry_kind`/`entry_route` | 字符串标记禁止 |

## risk_table[]

| 旧名 | 新名 | 备注 |
|------|------|------|
| `riskTable[].risk: critical/high/...` | `risk_table[].severity: high/medium/low` | 重命名 + 收窄 |
| `riskTable[].testCoverage` | `risk_table[].test_coverage` | snake_case |
| `riskTable[].domainContext` | `risk_table[].domain_context` | snake_case |

## downstream_contracts[]

| 旧名 | 新名 | 备注 |
|------|------|------|
| `downstreamContracts[].callType` | `downstream_contracts[].call_kind` | 重命名 |
| `downstreamContracts[].contractKind` | `downstream_contracts[].contract_kind` | snake_case |
| `downstreamContracts[].status: ok` | `downstream_contracts[].status: satisfied` | 改名 |
| `downstreamContracts[].reachesSink + sinkRepo + risk` | `downstream_contracts[].sink: { type, repo, priority?, severity? } \| null` | 整体重构成 sink 对象 |

## test_scenarios[]

| 旧名 | 新名 | 备注 |
|------|------|------|
| `test_scenarios[].risk_change_id: string` | `test_scenarios[].risk_change_ids: string[]` | 改成 SYM-NNN id 数组 |
| `test_scenarios[].affected_api: string` | `test_scenarios[].target_api: object` | 改成结构化（见 [output-schema §4.4](./output-schema.md)） |
| `test_scenarios[].oracle: dict` | `test_scenarios[].assertions[]: object[]` | 改成闭合枚举数组（见 [output-schema §4.5](./output-schema.md)） |

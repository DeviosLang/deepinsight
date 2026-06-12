# cross-repo-impact/2.0 Output Schema

> 由 [`SKILL.md`](../SKILL.md) Step 5 / Step 6 引用。pi 输出报告**必须严格遵守本文档**，
> 用 ` ```json ... ``` ` 包裹。pipeline 自动解析，格式不对会导致结果丢失。
>
> **所有字段名是 snake_case**（不是 camelCase）。

---

## 1. 顶层结构与必填字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|----|------|
| `schema_version` | `"cross-repo-impact/2.0"` | ✅ | 固定值 |
| `meta` | object | ✅ | 见 §2 |
| `changes[]` | array | ✅ | 至少 1 项；分析服务会注入此字段，**LLM 也要按收到的输入复刻一份** |
| `symbols[]` | array | ✅ | 至少 1 项 |
| `test_scenarios[]` | array | ✅ | 可空 `[]` |
| `unanalyzable[]` | array | ✅ | 可空 `[]` |
| `global_patterns_matched[]` | array | ⛔ 可选 | — |

---

## 2. ID 命名规则（**必须严格遵守**）

| 数组 | id 前缀 | 说明 |
|------|------|------|
| `symbols[].id` | `SYM-001`, `SYM-002`... | 三位数字编号，跨整次输出唯一 |
| `test_scenarios[].id` | `RT-001`, `RT-002`... | 同上 |
| `unanalyzable[].id` | `UA-001`, `UA-002`... | 同上 |

`test_scenarios[].risk_change_ids[]` 是**数组**，每个元素必须是上面已经出现过的 `SYM-NNN` id（不要写函数名）。

---

## 3. 完整示例

```json
{
  "schema_version": "cross-repo-impact/2.0",
  "meta": {
    "tool_name": "deepinsight-pi",
    "tool_version": "2.0",
    "generated_at": "2026-06-11T03:30:00Z",
    "dimension_catalog_version": "tapd-requirement-analyzer/4.A-2/v1"
  },
  "changes": [
    { "repo": "aurora", "branch": "feature/x", "head_commit": "abc1234", "base_commit": "def5678" }
  ],
  "symbols": [
    {
      "id": "SYM-001",
      "name": "push_db",
      "location": "aurora/db/tasks/db_period_task.py:1421",
      "diff_semantic": "添加 hasattr 守卫防止跨版本反序列化 AttributeError，条件分支逻辑不变",
      "initial_severity": "medium",
      "call_tree": [
        {
          "depth": 1,
          "repo": "aurora",
          "file": "aurora/db/tasks/db_period_task.py",
          "line": 1421,
          "function": "push_db",
          "is_entry": false,
          "call_type": "direct_call",
          "priority": "P2",
          "test_coverage": "has_test",
          "domain_context": "DB 同步任务"
        },
        {
          "depth": 2,
          "repo": "vstation_compute",
          "file": "vstation_compute/steps/sync_grid.py",
          "line": 45,
          "function": "sync_grid_info",
          "is_entry": false,
          "call_type": "mq_event",
          "priority": "P2",
          "test_coverage": "no_test",
          "domain_context": "Grid 同步步骤",
          "via": "MQ: aurora partition → sync_grid_info"
        },
        {
          "depth": 3,
          "repo": "cxm_api",
          "file": "cxm_api/views/reserved_pack.py",
          "line": 120,
          "function": "CreateReservedPacks",
          "is_entry": true,
          "is_primary_entry": true,
          "entry_kind": "http_api",
          "entry_route": "POST /?Action=CreateReservedPacks",
          "call_type": "http_call",
          "priority": "P1",
          "test_coverage": "partial",
          "domain_context": "公网 API 入口",
          "via": "HTTP: cxm_api → vstation_api → aurora"
        }
      ],
      "risk_table": [
        {
          "priority": "P1",
          "severity": "high",
          "location": "cxm_api/views/reserved_pack.py:120",
          "function": "CreateReservedPacks",
          "via": "cxm_api → vstation_api → aurora(MQ) → push_db",
          "test_coverage": "partial",
          "domain_context": "公网 API 入口",
          "remediation": "需补充 hasattr 场景的集成测试"
        }
      ],
      "downstream_contracts": [
        {
          "callee": "CDbAccess.update",
          "repo": "vstation_compute",
          "file": "vstation_compute/db/dao.py",
          "line": 88,
          "call_kind": "direct_call",
          "contract_kind": "schema",
          "status": "uncertain",
          "detail": "push_db 反序列化字段后写入 DAO，hasattr 守卫后字段可能缺失，下游 update 的列映射需确认",
          "sink": {
            "type": "db_write",
            "repo": "vstation_compute",
            "priority": "P2",
            "severity": "medium"
          }
        }
      ]
    }
  ],
  "test_scenarios": [
    {
      "id": "RT-001",
      "scenario": "白名单租户调用 CreateReservedPacks 成功路径",
      "risk_change_ids": ["SYM-001"],
      "target_api": {
        "name": "CreateReservedPacks",
        "namespace": "cxm",
        "transport": "cloud_api",
        "route": "POST /?Action=CreateReservedPacks"
      },
      "api_params": { "InstanceCount": 1 },
      "preconditions": [
        "DB: t_task_process 有 taskId=xxx 的记录, status=running",
        "MQ: routing_key 对应 dispatcher"
      ],
      "steps": [
        "1. 调用入口 API: POST /?Action=CreateReservedPacks",
        "2. 等待 MQ 消息路由到 sync_grid",
        "3. 检查 DB 写入"
      ],
      "assertions": [
        {
          "kind": "api_response",
          "channel": "cvm_api",
          "expression": "Response.Status eq Running",
          "human_description": "API 返回 Running 状态",
          "severity": "must"
        },
        {
          "kind": "db_check",
          "channel": "mysql",
          "expression": "t_task_process.status eq finished WHERE taskId='xxx'",
          "human_description": "任务状态最终落到 finished",
          "severity": "must"
        }
      ]
    }
  ],
  "unanalyzable": [
    {
      "id": "UA-001",
      "category": "runtime_only",
      "subject": "动态调用 getattr(obj, method)() 在 xxx 中存在",
      "implication": "无法静态枚举 method 名，可能漏掉调用点",
      "suggested_handling": "manual"
    }
  ],
  "global_patterns_matched": []
}
```

---

## 4. 字段约束清单

> **本节是 schema 的唯一真源。** SKILL.md 与 piWorker.ts 中的"输出格式"段落只列摘要 + 跳转，真正的必填/可选/枚举值以本节为准。

### 4.0 `symbols[]` 顶层

| 字段 | 必填 | 类型 | 备注 |
|---|---|---|---|
| `id` | ✅ | string | `SYM-NNN` 三位编号，全输出唯一 |
| `symbol` | ✅ | string | 函数/类/常量名（与 diff 中的标识符一致） |
| `location` | ✅ | string | `"<repo-relative-path>:<line>"` 单字段；**禁止**拆成 `file` + `line` 两个字段 |
| `diff_semantic` | ✅ | **string** | 一句话描述变更语义；**禁止**写成 `{description, change_type, ...}` 对象 |
| `change_type` | ⚠️ 可选 | string | 顶层兄弟字段（不嵌套在 `diff_semantic` 内）；取值 `additive_conditional` / `class_added` / `signature_change` / `behavior_change` / `new_constant` 等 |
| `initial_severity` | ✅ | string | `high` / `medium` / `low`（顶层兄弟字段，不嵌套） |
| `call_tree` | ✅ | array | 至少 1 项，详见 §4.1 |
| `risk_table` | ✅ | array | 可空 `[]`，详见 §4.2 |
| `downstream_contracts` | ✅ | array | 可空 `[]`，详见 §4.3 |
| `name` | ⚠️ 可选 | string | 仅作展示用别名；**与 `symbol` 同源**（描述同一个对象），不要错位写成"另一个变更点的名字" |

### 4.1 `call_tree[]` 节点

| 字段 | 必填 | 类型 | 备注 |
|---|---|---|---|
| `depth` | ✅ | integer | ≥ 1 |
| `repo` | ✅ | string | 节点所在仓 |
| `file` | ✅ | string | 节点所在文件路径 |
| `line` | ⚠️ 可选 | integer | 行号（已知时填） |
| `function` | ✅ | string | 节点函数/方法名；**禁止**用 `caller` / `symbol` 字段名替代 |
| `is_entry` | ✅ | boolean | `true` 时必须给 `entry_kind` |
| `entry_kind` | ⚠️ 条件必填 | enum | 仅 `is_entry=true` 时必填，闭合枚举 `http_api` / `scheduler_job` / `mq_consumer` / `rpc_method` / `internal_only` |
| `entry_route` | ⚠️ 条件必填 | string | 仅 `entry_kind="http_api"` 必填，必须以大写 HTTP 方法 + 空格 + `/` 路径开头（如 `"POST /?Action=Foo"`、`"GET /api/v2/foo"`） |
| `is_primary_entry` | ⚠️ 可选（tie-break） | boolean | **不是必填字段**。整个 `symbols[].call_tree` 中**至多一个**节点为 `true`，仅用于消歧多个 `is_entry=true` 节点；下游消费时**不存在此字段则按 `is_entry=true && depth 最大` 的节点为主入口**（fallback 路径才是主路径） |
| `call_type` | ✅ | enum | 闭合枚举（见下文）；**禁止**用 `transport` / `kind` 字段名替代 |
| `priority` | ✅ | enum | `P0` / `P1` / `P2` / `P3` / `NEEDS_HUMAN_REVIEW` |
| `test_coverage` | ✅ | enum | `no_test` / `partial` / `has_test` |
| `domain_context` | ⚠️ 可选 | string | 自由文本。**禁止**包含 `[ENTRY]` 字符串或 mermaid/HTML/emoji 装饰（消费侧 mask sweep 会拦截 emoji） |
| `via` | ⚠️ 可选 | string | 跨仓路径描述（如 `"HTTP: cxm_api → vstation_api → aurora"`） |

`call_type` 闭合枚举：`direct_call` / `http_call` / `mq_event` / `scheduler_trigger` /
`shared_data_flow` / `framework_dispatch` / `import_usage` / `constant_definition` /
`field_definition` / `parallel_definition` / `schema_validation` / `dispatch_table` /
`callback_lookup` / `data_transform` / `data_read` / `indirect_call`

### 4.2 `risk_table[]` 行

| 字段 | 必填 | 类型 | 备注 |
|---|---|---|---|
| `priority` | ✅ | enum | 动作紧迫度 — `P0` / `P1` / `P2` / `P3` / `NEEDS_HUMAN_REVIEW` |
| `severity` | ✅ | enum | 影响量级 — `high` / `medium` / `low`；**不接受** `critical` / `info` |
| `function` | ✅ | string | 风险节点的函数/方法名；**禁止**用 `caller_path` 替代 |
| `location` | ✅ | string | `"<file>:<line>"`，与 `symbols[].location` 同格式 |
| `via` | ⚠️ 可选 | string | 跨仓路径描述（如 `"cxm_api → vstation_api → aurora(MQ) → push_db"`） |
| `test_coverage` | ✅ | enum | `no_test` / `partial` / `has_test` |
| `domain_context` | ⚠️ 可选 | string | 风险点领域上下文 |
| `remediation` | ✅ | string | 开发者修复建议；**P0/P1 行此字段必填**，不能用 `domain_context` 兜底 |
| `description` | ⚠️ 可选 | string | 风险描述（与 `change_impact` 同义；只填一个） |

`priority` 与 `severity` 是**两个独立字段**，必须分别填写——不要用 priority 推 severity 或反之。

### 4.3 `downstream_contracts[]`

| 字段 | 必填 | 类型 | 备注 |
|---|---|---|---|
| `callee` | ✅ | string | 被调函数/方法/MQ 主题等 |
| `repo` | ⚠️ 可选 | string | 被调对象所在仓 |
| `file` | ⚠️ 可选 | string | 被调对象所在文件 |
| `line` | ⚠️ 可选 | integer | 行号 |
| `call_kind` | ✅ | enum | **字段名固定为 `call_kind`**；**禁止**用 `kind` / `transport` 替代 |
| `contract_kind` | ✅ | enum | **字段名固定为 `contract_kind`**；**禁止**用 `contract_type` 替代 |
| `status` | ✅ | enum | `satisfied` / `uncertain` / `violated`；**不是** `ok` |
| `detail` | ✅ | string | 契约细节；**不要**写成 `{status, detail}` 嵌套对象 |
| `sink` | ✅ | object \| null | 触达 sink 时为对象 `{type, repo, priority?, severity?}`；未触达时 `null` |

`call_kind` 闭合枚举：`direct_call` / `http_call` / `mq_event` / `scheduler_trigger` /
`shared_data_flow` / `framework_dispatch` / `indirect_call`

`contract_kind` 闭合枚举：`param` / `schema` / `transaction` / `other`

`sink.type` 闭合枚举：`db_write` / `db_read` / `http_internal` / `mq_producer` / `external_api`

> **常见错误（实测）**：把 `param` / `schema` / `transaction` 单独作为字段写出 `{status, detail}` 子对象——这是错的；应该用一行 `contract_kind` + `status` + `detail` 表达**一种**契约。多种契约就写多个 `downstream_contracts[]` 元素。

### 4.4 `test_scenarios[].target_api`（结构化对象，不是字符串）

| 字段 | 必填 | 类型 | 备注 |
|---|---|---|---|
| `name` | ✅ | string | 纯 API 标识符（如 `"CreateReservedPacks"`，无前缀、无中文） |
| `namespace` | ✅ | enum | `cvm` / `vstation` / `ceres` / `ccdb` / `billing_internal` / `cxm` |
| `transport` | ✅ | enum | **闭合 4 枚举：`cloud_api` / `vstation` / `internal_rpc` / `scheduler`**；**禁止**用 `HTTP` / `http` / `http_api` / `des_pipeline` 等自由文本（DES 流水线步骤用 `internal_rpc`） |
| `route` | ⚠️ 条件必填 | string | 仅 `transport="cloud_api"` 时必填，HTTP 完整路径（带方法） |

### 4.5 `test_scenarios[]` 顶层

| 字段 | 必填 | 类型 | 备注 |
|---|---|---|---|
| `id` | ✅ | string | `RT-NNN` 三位编号 |
| `scenario` | ✅ | string | 场景名称（一句话，描述从入口 API 到受影响代码路径的完整链路） |
| `risk_change_ids` | ✅ | array<string> | 数组，每元素必须是已出现的 `SYM-NNN` id（不要写函数名） |
| `target_api` | ✅ | object | 见 §4.4 |
| `api_params` | ✅ | object | **必填**，即使无参也要填 `{}`；从 diff/调用点提取关键参数（如 `{"InstanceCount": 1, "InstanceChargeType": "PERIODIC_CONTRACT"}`） |
| `preconditions` | ✅ | array<string> | 环境准备（DB 数据、服务运行、配置） |
| `steps` | ✅ | array<string> | 可重现操作步骤（从对外 API 入口开始） |
| `assertions` | ✅ | array<object> | 数组，每项一个 `kind`，见下表 |

### 4.6 `test_scenarios[].assertions[]`（数组，**不是** `oracle` 字典）

每个 assertion 必填 `kind` / `channel` / `expression` / `severity`。

> **🔴 红线：`kind` 必须从下表 9 个枚举中选一个，禁止生造。**
> 实测常见错误：`http_status` / `http_response` / `response_field` / `error_code` / `error_message` /
> `context_value` / `des_task` / `external_call` / `trade_goods` / `log_contains` 等**全部非法**。
> 映射建议：HTTP 返回 → `api_response`；DB 状态 → `db_check`；日志关键字 → `log_check`；
> 内存上下文/DES 流水线状态 → `state_check`；内部 RPC 是否被调 → `external_call_check`。

| `kind` | 允许 `channel` | `expression` 语法示例 | 适用场景 |
|---|---|---|---|
| `api_response` | `cvm_api` / `vstation` | `Response.<JSONPath> <op> <value>`（op: `eq`/`ne`/`exists`/`in`/`matches`/`contains`/`lt`/`gt`/...） | 公网 API 返回值检查 |
| `db_check` | `mysql` / `redis` / `ccdb` | `<table>.<col> <op> <value> WHERE <where>` | DB 状态检查 |
| `log_check` | `cls` | `grep "<regex>" in <service>.<log>` | 日志关键字 |
| `metric_check` | `cls` / `internal` | `<metric> <op> <threshold> over <window>` | 监控指标 |
| `state_check` | `internal` | `pipeline.<path> <op> <value>` | 内存上下文 |
| `external_call_check` | `billing_internal` / `ccdb` / `internal` | `<service>.<api>(<param>=<value>) called=<bool>[, times=<n>]` | 验证内部 RPC 是否被调 |
| `mock_check` | `internal` | `mock(<callee>).called == <bool>` | 单测 mock |
| `human_observation` | `internal` | `human verifies: <自然语言>` | 必须人工目检 |
| `code_fix_directive` | `internal` | 自由文本（`severity` 不能为 `must`，仅作为代码修复建议） | 不是运行时断言 |

`severity`：`must` / `should` / `informational`。

> **关键约束**：每个 assertion 必须**只对应一个 oracle 类型**。如果一个场景需要"调 API
> 同时检查 DB"，就写两个 `assertions[]` 元素，**禁止**把多种检查塞进一个 `expression`。
> **禁止**生造新 `kind`（旧版本的 `oracle` 字典自由 key 已被取消）。

### 4.7 `unanalyzable[]`（结构化，**不是字符串列表**）

- `id`：`UA-NNN`
- `category`：`missing_repo` / `runtime_only` / `external_service` /
  `duplicated_codebase` / `not_imported` / `schema_unknown`
- `subject`：人话描述
- `implication`：影响后果
- `suggested_handling`：`manual` / `deferred` / `external_team`

### 4.8 `meta`（顶层元数据）

| 字段 | 必填 | 类型 | 备注 |
|---|---|---|---|
| `tool_name` | ✅ | string | 固定 `"deepinsight-pi"` |
| `tool_version` | ✅ | string | `"2.0"` |
| `generated_at` | ✅ | string | ISO 8601 时间戳 |
| `dimension_catalog_version` | ⚠️ 可选 | string | 下游消费 agent 期望的目录版本 |

> `meta` **只接受上述 4 个 key**。**禁止**自创 `total_symbols` / `total_test_scenarios` / `entry_repos` / `summary` 等字段——这些信息直接从 `symbols[].length` / `test_scenarios[].length` / 各项内容推得，写在 meta 里会引入计数不一致问题（实测 `total_test_scenarios=8` 但实际数组 10 项）。

---

## 5. 关键要求（输出前必查 — 唯一权威清单）

> **本清单是 SKILL.md 自检表与 piWorker.ts 输出格式段落引用的唯一真源。**
> 三处其它位置只列摘要 + 跳转，真正的必填/可选/枚举值以本节为准。
> 输出 18+ 个 symbol 时**强烈建议每写完 3-5 个 symbol 回到此清单走一遍**——
> 长上下文 LLM 容易在第 5 个 symbol 之后开始字段名漂移（实测过）。

### 5.1 顶层结构

1. `schema_version` 必须正好等于 `"cross-repo-impact/2.0"`
2. 顶层必须有 `schema_version` / `meta` / `changes` / `symbols` / `test_scenarios` / `unanalyzable`
3. `meta` **只填 §4.8 的 4 个 key**，不要塞 `total_symbols` / `summary` / `entry_repos` 等自造字段

### 5.2 `symbols[]`

4. 每个元素必须有 `id`（`SYM-NNN`），`call_tree`/`risk_table`/`downstream_contracts` 是数组（可为空 `[]`）
5. `location` 是 `"file:line"` **单字段**（不要拆成 `file` + `line`）
6. `diff_semantic` 是**字符串**（不是 `{description, change_type, ...}` 对象）；`change_type` / `initial_severity` 是顶层兄弟字段
7. `name` 字段（如填）必须与 `symbol` 同源（同一个对象的别名/展示名），**禁止错位**写成另一个变更点的名字

### 5.3 `call_tree[]`

8. 从变更点出发，逐层向上追踪到入口仓库
9. **入口节点必须用 `is_entry: true` + `entry_kind` 标记**，不要用 `[ENTRY]` 文本
10. 节点字段名固定为 `function` / `call_type`（**不要**用 `caller` / `transport` / `kind` 替代）
11. `is_primary_entry` 是**可选** tie-break 字段，不必填

### 5.4 `risk_table[]`

12. 列出所有 P0/P1/P2 风险节点（从高到低排序）
13. `priority` 和 `severity` 都要写（两个独立维度）
14. **P0/P1 行 `remediation` 必填**，不能用 `domain_context` / `description` 兜底（消费 agent 只读 remediation）
15. 字段名固定为 `function` / `location`（不要用 `caller_path` 替代）

### 5.5 `downstream_contracts[]`

16. 字段名固定为 **`call_kind`** + **`contract_kind`**；**禁止**用 `kind` / `contract_type` / `transport` 替代
17. `status` 用 `satisfied` / `uncertain` / `violated`（**不是** `ok`）
18. 触达 sink 时 `sink` 填对象 `{type, repo, priority?, severity?}`，否则 `sink: null`
19. **不要**写成 `{param: {status, detail}, schema: {status, detail}, ...}` 嵌套结构——一行只表达**一种** `contract_kind`，多种契约就写多个数组元素

### 5.6 `test_scenarios[]`

20. 放在顶层（不要嵌套在 symbols 内），废弃的 `oracle` 字典已改成 `assertions[]` 数组
21. **每个场景必须有 `api_params` 字段**（即使无参也填 `{}`）——下游 agent 会直接消费这个字段执行 API 调用
22. `target_api.transport` 闭合 4 枚举：**`cloud_api` / `vstation` / `internal_rpc` / `scheduler`**；**禁止**写 `HTTP` / `http_api` / `des_pipeline`（DES 流水线步骤用 `internal_rpc`）
23. `assertions[]` 每项**只有一个 `kind`**，从 §4.6 的 9 枚举里选；**禁止**生造 `http_status` / `response_field` / `context_value` / `des_task` / `trade_goods` 等

### 5.7 通用

24. `unanalyzable[]` 是结构化对象数组（**不是字符串列表**）
25. **任何字符串字段都不得包含 emoji / `[ENTRY]` / mermaid / HTML 装饰**（消费方有 mask sweep）
26. 置信度 < 0.7 的节点 `priority` 标 `NEEDS_HUMAN_REVIEW`，不要硬编 P0-P3

---

## 6. 测试验证场景生成（Step 6）

对**以下三类**触发点生成 `test_scenarios[]`：

1. 每个 P0/P1 风险项
2. 每个受影响的入口仓库 API（`call_tree[].is_entry==true`）
3. 每个触达 [SINK] 的下行契约项（`downstream_contracts[].sink != null`）

下行触达 [SINK] 的场景应在 `assertions[]` 中通过 `db_check` / `external_call_check` 验证 sink 侧状态。

```json
{
  "test_scenarios": [
    {
      "id": "RT-001",
      "scenario": "场景名称（描述从入口 API 触发到受影响代码路径的完整链路）",
      "risk_change_ids": ["SYM-001"],
      "target_api": {
        "name": "RunInstances",
        "namespace": "cvm",
        "transport": "cloud_api",
        "route": "POST /?Action=RunInstances"
      },
      "api_params": { "InstanceCount": 1 },
      "preconditions": [
        "DB: t_task_process 表有 taskId=xxx 的记录, status=running",
        "MQ: routing_key 对应 dispatcher 模块",
        "Service: vstation_frame callback_adapter 进程运行中"
      ],
      "steps": [
        "1. 调用入口 API: POST /?Action=RunInstances {参数}",
        "2. 等待 MQ 消息路由到 callback_adapter",
        "3. 模拟 DB 更新失败（mock CDbAccess 返回 -1）"
      ],
      "assertions": [
        {
          "kind": "db_check",
          "channel": "mysql",
          "expression": "t_task_process.status eq running WHERE taskId='xxx'",
          "human_description": "任务状态保持 running（DB 更新失败时不应推进）",
          "severity": "must"
        },
        {
          "kind": "log_check",
          "channel": "cls",
          "expression": "grep \"\\[ERROR\\] Update task_status failed\" in callback_adapter.log",
          "human_description": "callback_adapter 必须打印更新失败的 ERROR 日志",
          "severity": "must"
        },
        {
          "kind": "api_response",
          "channel": "cvm_api",
          "expression": "Response.Status eq running",
          "human_description": "API 查询返回 running",
          "severity": "should"
        }
      ]
    }
  ]
}
```

每个场景必须包含：

- **id**: `RT-NNN` 三位编号
- **risk_change_ids**: 关联的 `SYM-NNN` id 数组
- **target_api**: 结构化对象（`name` / `namespace` / `transport` / 可选 `route`）
- **preconditions**: 环境准备（哪些表要有数据、哪些服务要运行、哪些配置要设置）
- **steps**: 可重现的操作步骤（从对外 API 入口开始）
- **assertions**: 数组，每项一个 `kind`（**禁止**多种检查塞进一项 expression）。
  `kind` / `channel` 组合必须满足 §4.5 的合法表。

---

## 7. 优先级与严重性

`priority`（动作紧迫度）和 `severity`（影响量级）是**两个独立维度**，必须分别填写：

| `priority` | 触发条件 | 处置 |
|------------|----------|------|
| P0 阻塞 | `severity=high` 且 `test_coverage=no_test` | 必须在合并前解决 |
| P1 必修 | `severity=high` 且 `test_coverage=partial` | 补测试后回归 |
| P2 回归 | `severity=high` 且 `test_coverage=has_test`，或 `severity=medium` | 回归测试通过则可合并 |
| P3 观察 | `severity=low` | 无需特殊处置 |
| NEEDS_HUMAN_REVIEW | 验证后置信度 < 0.7 | 人工评估 |

`severity` 取值仅 `high` / `medium` / `low`（**不再使用** `critical`/`info`，旧 `critical` → `high`，旧 `info` → `low`）。

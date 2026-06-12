/**
 * Tests for renderMarkdown — the human-friendly report renderer.
 *
 * The renderer is intentionally tolerant of loose LLM output (missing fields,
 * snake_case vs camelCase, extra fields, malformed shapes). These tests pin
 * the contract for both happy-path inputs and graceful degradation.
 */
import { describe, test, expect } from "vitest";
import { renderMarkdown } from "../render/markdown.js";

describe("renderMarkdown", () => {
  test("renders the canonical sections for a populated result", () => {
    const md = renderMarkdown({
      taskId: "analysis-test-1",
      project: "demo",
      status: "completed",
      changes: [{ repo: "demo-api", branch: "feature/x", commit: "abcdef0123456789" }],
      result: {
        summary: {
          totalSymbolsChanged: 1,
          affectedRepos: 1,
          unaffectedRepos: 0,
          riskBreakdown: { P0: 1, P1: 0, P2: 0, P3: 0, NEEDS_HUMAN_REVIEW: 0 },
        },
        symbols: [
          {
            name: "verify_token",
            location: "demo-api/auth.py:42",
            diffSemantic: "is → ==",
            initialRisk: "high",
            callTree: [
              {
                depth: 1,
                repo: "demo-api",
                file: "auth.py",
                line: 42,
                function: "verify_token",
                callType: "direct_call",
                risk: "P0",
                domainContext: "auth",
                testCoverage: "no_test",
              },
            ],
            riskTable: [
              {
                priority: "P0",
                location: "demo-api/auth.py:42",
                function: "verify_token",
                via: "direct",
                risk: "high",
                testCoverage: "no_test",
                domainContext: "auth",
                remediation: "block merge — add type guards",
              },
            ],
            downstreamContracts: [],
          },
        ],
        untrackable: ["dynamic getattr"],
        globalPatternsMatched: [],
      },
    });

    // Header
    expect(md).toContain("# 跨仓影响分析报告");
    expect(md).toContain("analysis-test-1");
    expect(md).toContain("Project**: demo");

    // Summary
    expect(md).toContain("## 📊 Summary");
    expect(md).toContain("| 🔴 **P0** | 1 |");

    // Action checklist surfaces P0 remediation
    expect(md).toContain("## ✅ 行动清单");
    expect(md).toContain("阻塞合并 (P0)");
    expect(md).toContain("block merge — add type guards");

    // Symbols section
    expect(md).toContain("## 📍 Symbols (1)");
    expect(md).toContain("verify_token");

    // Untrackable section
    expect(md).toContain("## ⚠️ 无法静态追踪 (1)");
    expect(md).toContain("dynamic getattr");
  });

  test("accepts a bare result object (no envelope)", () => {
    const md = renderMarkdown({
      summary: {
        totalSymbolsChanged: 0,
        affectedRepos: 0,
        unaffectedRepos: 0,
        riskBreakdown: { P0: 0, P1: 0, P2: 0, P3: 0, NEEDS_HUMAN_REVIEW: 0 },
      },
      symbols: [],
    });
    expect(md).toContain("## 📊 Summary");
    expect(md).toContain("## 📍 Symbols");
  });

  test("omits empty sections", () => {
    const md = renderMarkdown({
      result: {
        summary: {
          totalSymbolsChanged: 0,
          affectedRepos: 0,
          unaffectedRepos: 0,
          riskBreakdown: { P0: 0, P1: 0, P2: 0, P3: 0, NEEDS_HUMAN_REVIEW: 0 },
        },
        symbols: [],
        untrackable: [],
        globalPatternsMatched: [],
      },
    });
    expect(md).not.toContain("## ✅ 行动清单");
    expect(md).not.toContain("## ⚠️ 无法静态追踪");
    expect(md).not.toContain("## 🧪 回归测试场景");
    expect(md).not.toContain("## 🔁 历史风险模式匹配");
  });

  test("escapes pipe characters in table cells", () => {
    // A remediation note containing "|" must not break the markdown table.
    const md = renderMarkdown({
      result: {
        summary: { totalSymbolsChanged: 1, affectedRepos: 1, unaffectedRepos: 0, riskBreakdown: { P0: 1, P1: 0, P2: 0, P3: 0, NEEDS_HUMAN_REVIEW: 0 } },
        symbols: [
          {
            name: "f",
            location: "x.py:1",
            riskTable: [{ priority: "P0", location: "x.py:1", function: "f", remediation: "do A | do B" }],
            callTree: [],
            downstreamContracts: [],
          },
        ],
      },
    });
    // The "|" inside a cell should be escaped with backslash to remain valid markdown.
    expect(md).toContain("do A \\| do B");
  });

  test("renders test_scenarios checklist with oracle key:value", () => {
    const md = renderMarkdown({
      result: {
        summary: { totalSymbolsChanged: 0, affectedRepos: 0, unaffectedRepos: 0, riskBreakdown: { P0: 0, P1: 0, P2: 0, P3: 0, NEEDS_HUMAN_REVIEW: 0 } },
        symbols: [],
        test_scenarios: [
          {
            scenario: "test login flow",
            risk_change_id: "verify_token",
            preconditions: ["DB seeded"],
            steps: ["call /login"],
            oracle: { http_code: "200", db: "row exists" },
          },
        ],
      },
    });
    expect(md).toContain("## 🧪 回归测试场景 (1)");
    expect(md).toContain("test login flow");
    expect(md).toContain("- [ ] call /login");
    expect(md).toContain("`http_code`: 200");
  });

  test("respects --no-meta via includeMeta=false", () => {
    const md = renderMarkdown(
      {
        taskId: "x",
        result: {
          summary: { totalSymbolsChanged: 0, affectedRepos: 0, unaffectedRepos: 0, riskBreakdown: { P0: 0, P1: 0, P2: 0, P3: 0, NEEDS_HUMAN_REVIEW: 0 } },
          symbols: [],
          _meta: { durationMs: 1234 },
        },
      },
      { includeMeta: false },
    );
    expect(md).not.toContain("## 📋 执行元信息");
  });

  test("does not crash on missing/malformed sections", () => {
    // Worst-case input: every optional field is wrong type or missing.
    expect(() =>
      renderMarkdown({
        // No taskId, no project, no result.
      }),
    ).not.toThrow();

    expect(() =>
      renderMarkdown({
        result: {
          summary: null, // wrong type
          symbols: "not an array", // wrong type
          untrackable: { not: "array" }, // wrong type
        },
      }),
    ).not.toThrow();
  });

  test("downstreamContracts section uses badges and reachesSink display", () => {
    const md = renderMarkdown({
      result: {
        summary: { totalSymbolsChanged: 1, affectedRepos: 1, unaffectedRepos: 0, riskBreakdown: { P0: 0, P1: 0, P2: 1, P3: 0, NEEDS_HUMAN_REVIEW: 0 } },
        symbols: [
          {
            name: "f",
            location: "x.py:1",
            riskTable: [],
            callTree: [],
            downstreamContracts: [
              {
                callee: "Redis.hgetall",
                callType: "redis",
                contractKind: "schema",
                status: "uncertain",
                reachesSink: true,
                sinkRepo: "cache-svc",
                detail: "key format may have shifted",
                risk: "P2",
              },
            ],
          },
        ],
      },
    });
    expect(md).toContain("**下行契约 (1)**");
    expect(md).toContain("Redis.hgetall");
    expect(md).toContain("✅ cache-svc"); // reachesSink badge + sinkRepo
    expect(md).toContain("⚠️ uncertain"); // status badge + label
  });
});

// ─── cross-repo-impact/2.0 schema rendering ────────────────────────────────

describe("renderMarkdown (cross-repo-impact/2.0)", () => {
  test("renders new-schema artifact: header, recomputed summary, structured pieces", () => {
    const md = renderMarkdown({
      taskId: "task-2",
      project: "cvm",
      status: "completed",
      result: {
        schema_version: "cross-repo-impact/2.0",
        meta: {
          tool_name: "deepinsight-pi",
          tool_version: "2.0",
          generated_at: "2026-06-11T03:30:00Z",
          dimension_catalog_version: "tapd-requirement-analyzer/4.A-2/v1",
        },
        changes: [
          { repo: "aurora", branch: "feature/x", head_commit: "abcdef0123456789", base_commit: "1111111111" },
        ],
        symbols: [
          {
            id: "SYM-001",
            name: "push_db",
            location: "aurora/db.py:10",
            diff_semantic: "guard added",
            initial_severity: "medium",
            call_tree: [
              {
                depth: 1,
                repo: "aurora",
                file: "aurora/db.py",
                line: 10,
                function: "push_db",
                is_entry: false,
                call_type: "direct_call",
                priority: "P2",
                test_coverage: "has_test",
              },
              {
                depth: 2,
                repo: "cxm_api",
                file: "cxm_api/views/x.py",
                line: 120,
                function: "CreateReservedPacks",
                is_entry: true,
                is_primary_entry: true,
                entry_kind: "http_api",
                entry_route: "POST /?Action=CreateReservedPacks",
                call_type: "http_call",
                priority: "P1",
                test_coverage: "partial",
              },
            ],
            risk_table: [
              {
                priority: "P1",
                severity: "high",
                location: "cxm_api/views/x.py:120",
                function: "CreateReservedPacks",
                via: "cxm_api → aurora",
                test_coverage: "partial",
                domain_context: "公网 API 入口",
                remediation: "补充集成测试",
              },
            ],
            downstream_contracts: [
              {
                callee: "CDbAccess.update",
                call_kind: "direct_call",
                contract_kind: "schema",
                status: "uncertain",
                detail: "字段可能缺失",
                sink: { type: "db_write", repo: "vstation_compute", priority: "P2", severity: "medium" },
              },
            ],
          },
        ],
        test_scenarios: [
          {
            id: "RT-001",
            scenario: "白名单租户成功",
            risk_change_ids: ["SYM-001"],
            target_api: {
              name: "CreateReservedPacks",
              namespace: "cxm",
              transport: "cloud_api",
              route: "POST /?Action=CreateReservedPacks",
            },
            api_params: { InstanceCount: 1 },
            preconditions: ["DB seeded"],
            steps: ["call API"],
            assertions: [
              {
                kind: "api_response",
                channel: "cvm_api",
                expression: "Response.Status eq Running",
                human_description: "API returns running",
                severity: "must",
              },
              {
                kind: "db_check",
                channel: "mysql",
                expression: "t_task.status eq finished WHERE id='x'",
                severity: "must",
              },
            ],
          },
        ],
        unanalyzable: [
          {
            id: "UA-001",
            category: "runtime_only",
            subject: "dynamic getattr",
            implication: "may miss callers",
            suggested_handling: "manual",
          },
        ],
        global_patterns_matched: ["mq-without-idempotency-token"],
      },
    });

    // Header includes schema banner
    expect(md).toContain("# 跨仓影响分析报告");
    expect(md).toContain("**Schema**: `cross-repo-impact/2.0`");

    // Summary (recomputed from symbols since new schema has no `summary`)
    expect(md).toContain("## 📊 Summary");
    expect(md).toContain("| 🟠 **P1** | 1 |"); // recomputed from risk_table

    // Action checklist surfaces P1 from risk_table
    expect(md).toContain("## ✅ 行动清单");
    expect(md).toContain("必修 (P1)");
    expect(md).toContain("CreateReservedPacks");

    // Sink action: P2 doesn't reach checklist by design (only P0/P1)
    // — but the contract row in Symbols section should still show.
    expect(md).toContain("**下行契约 (1)**");
    expect(md).toContain("`db_write`");

    // Test scenarios — assertions[] table, NOT oracle dict
    expect(md).toContain("## 🧪 回归测试场景 (1)");
    expect(md).toContain("`RT-001`");
    expect(md).toContain("**关联变更**: `SYM-001`");
    expect(md).toContain("`CreateReservedPacks`");
    expect(md).toContain("**Assertions (验证规则)**");
    expect(md).toContain("`api_response`");
    expect(md).toContain("`db_check`");

    // Symbols section with id + new fields
    expect(md).toContain("## 📍 Symbols (1)");
    expect(md).toContain("`SYM-001`");
    expect(md).toContain("[ENTRY* http_api: POST /?Action=CreateReservedPacks]");

    // Unanalyzable (structured table, not bullet list)
    expect(md).toContain("## ⚠️ 无法静态追踪 (1)");
    expect(md).toContain("`UA-001`");
    expect(md).toContain("`runtime_only`");

    // Global patterns
    expect(md).toContain("## 🔁 历史风险模式匹配 (1)");
    expect(md).toContain("mq-without-idempotency-token");
  });

  test("scenarios with assertions[] render kind/channel/severity columns", () => {
    const md = renderMarkdown({
      result: {
        schema_version: "cross-repo-impact/2.0",
        symbols: [],
        test_scenarios: [
          {
            id: "RT-002",
            scenario: "edge",
            risk_change_ids: ["SYM-001"],
            target_api: { name: "X", namespace: "cvm", transport: "cloud_api", route: "POST /" },
            assertions: [
              { kind: "log_check", channel: "cls", expression: "grep ERROR", severity: "should" },
            ],
          },
        ],
        unanalyzable: [],
      },
    });
    expect(md).toContain("`log_check`");
    expect(md).toContain("`cls`");
    expect(md).toContain("🟡 should");
  });

  test("downstream sink object renders type+repo and sink priority", () => {
    const md = renderMarkdown({
      result: {
        schema_version: "cross-repo-impact/2.0",
        symbols: [
          {
            id: "SYM-1",
            name: "f",
            location: "x.py:1",
            initial_severity: "medium",
            call_tree: [],
            risk_table: [],
            downstream_contracts: [
              {
                callee: "Redis.hgetall",
                call_kind: "direct_call",
                contract_kind: "schema",
                status: "satisfied",
                detail: "ok",
                sink: { type: "db_read", repo: "cache-svc", priority: "P0" },
              },
            ],
          },
        ],
        test_scenarios: [],
        unanalyzable: [],
      },
    });
    expect(md).toContain("✅ `db_read` `cache-svc`");
    expect(md).toContain("🔴 P0");
    expect(md).toContain("✅ satisfied"); // satisfied → ✅ badge
    // P0 sink contract surfaces as a sink action checklist item
    expect(md).toContain("数据/存储层操作 (Sink)");
  });

  test("is_entry=true with entry_kind=http_api shows the entry tag in call tree", () => {
    const md = renderMarkdown({
      result: {
        schema_version: "cross-repo-impact/2.0",
        symbols: [
          {
            id: "SYM-1",
            name: "f",
            location: "x.py:1",
            initial_severity: "low",
            call_tree: [
              {
                depth: 1,
                repo: "cxm_api",
                file: "v.py",
                line: 1,
                function: "Foo",
                is_entry: true,
                entry_kind: "http_api",
                entry_route: "POST /?Action=Foo",
                call_type: "http_call",
                priority: "P3",
                test_coverage: "has_test",
              },
            ],
          },
        ],
        test_scenarios: [],
        unanalyzable: [],
      },
    });
    // No * (not primary), kind + route shown
    expect(md).toContain("[ENTRY http_api: POST /?Action=Foo]");
  });

  test("structured unanalyzable[] renders as a table", () => {
    const md = renderMarkdown({
      result: {
        schema_version: "cross-repo-impact/2.0",
        symbols: [],
        test_scenarios: [],
        unanalyzable: [
          {
            id: "UA-001",
            category: "missing_repo",
            subject: "repo X not in workspace",
            implication: "callers unknown",
            suggested_handling: "deferred",
          },
        ],
      },
    });
    expect(md).toContain("| ID | 类别 | 主题 | 影响 | 处置 |");
    expect(md).toContain("`UA-001`");
    expect(md).toContain("`missing_repo`");
    expect(md).toContain("repo X not in workspace");
    expect(md).toContain("`deferred`");
  });

  test("legacy untrackable bullet list still renders when new unanalyzable absent", () => {
    const md = renderMarkdown({
      result: {
        // No schema_version — legacy path
        summary: { totalSymbolsChanged: 0, affectedRepos: 0, unaffectedRepos: 0, riskBreakdown: { P0: 0, P1: 0, P2: 0, P3: 0, NEEDS_HUMAN_REVIEW: 0 } },
        symbols: [],
        untrackable: ["dynamic getattr"],
      },
    });
    expect(md).toContain("## ⚠️ 无法静态追踪 (1)");
    expect(md).toContain("- dynamic getattr");
  });

  test("_rawOutput surfaces a raw-output banner section", () => {
    const md = renderMarkdown({
      result: {
        schema_version: "cross-repo-impact/2.0",
        symbols: [],
        test_scenarios: [],
        unanalyzable: [],
        _rawOutput: "...(truncated)...\nsome raw pi text",
      },
    });
    expect(md).toContain("## 🪵 原始输出 (JSON 解析失败)");
    expect(md).toContain("some raw pi text");
  });
});

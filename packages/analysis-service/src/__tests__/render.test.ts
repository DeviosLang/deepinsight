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

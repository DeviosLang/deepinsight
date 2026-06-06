/**
 * Tests for the dedup-by-(file:line, name) merge strategy in pipeline.ts.
 *
 * Background: parallel pi workers occasionally label the same function
 * differently — e.g. one worker says `name="check_rate_limit"`, another says
 * `name="check_rate_limit (rate_limiter.py v2.0)"`. Both refer to the same
 * source location. The previous dedup-by-name implementation kept these as
 * two separate symbols in the merged output, polluting the report.
 *
 * The fix: dedup primarily on a normalized location (basename:line), with
 * name as fallback. These tests pin that contract.
 */
import { describe, test, expect } from "vitest";
import {
  __mergeAnalysisJsonsForTest as mergeAnalysisJsons,
  __symbolDedupKeyForTest as symbolDedupKey,
  __pickBetterNameForTest as pickBetterName,
} from "../orchestrator/pipeline.js";

describe("symbolDedupKey", () => {
  test("uses basename:line as primary key when location has line", () => {
    const k = symbolDedupKey({
      name: "check_rate_limit",
      location: "cvm_api/framework/rate_limiter.py:734",
    });
    expect(k.primary).toBe("rate_limiter.py:734");
    expect(k.fallback).toBe("check_rate_limit");
  });

  test("strips repo prefix differences for the same file:line", () => {
    // Two LLM workers report the same function with different prefixes.
    const a = symbolDedupKey({
      name: "check_rate_limit",
      location: "cvm_api/framework/rate_limiter.py:734",
    });
    const b = symbolDedupKey({
      name: "check_rate_limit (rate_limiter.py v2.0)",
      location: "framework/rate_limiter.py:734",
    });
    expect(a.primary).toBe(b.primary);
  });

  test("uses basename only when line is missing", () => {
    const k = symbolDedupKey({
      name: "CreateRateLimitPolicy.entry",
      location: "cvm_api/business/ops/CreateRateLimitPolicy.py",
    });
    expect(k.primary).toBe("CreateRateLimitPolicy.py");
  });

  test("falls back to normalized name when location is missing", () => {
    const k = symbolDedupKey({ name: "check_rate_limit (v2)" });
    // trailing "(...)" annotation stripped so it collides with the bare name
    expect(k.primary).toBe("check_rate_limit");
    expect(k.fallback).toBe("check_rate_limit (v2)");
  });

  test("handles empty input gracefully", () => {
    const k = symbolDedupKey({});
    expect(k.primary).toBe("");
    expect(k.fallback).toBe("");
  });
});

describe("pickBetterName", () => {
  test("prefers the longer (more informative) name", () => {
    expect(pickBetterName("foo", "foo (v2)")).toBe("foo (v2)");
    expect(pickBetterName("foo (v2)", "foo")).toBe("foo (v2)");
  });

  test("handles empty inputs", () => {
    expect(pickBetterName("", "foo")).toBe("foo");
    expect(pickBetterName("foo", "")).toBe("foo");
    expect(pickBetterName("", "")).toBe("");
  });
});

describe("mergeAnalysisJsons", () => {
  test("merges two workers reporting same function under different names", () => {
    // Reproduces the rate_limiter_v2 production case where the same function
    // appeared twice in symbols[] because workers labelled it differently.
    const workerA = {
      symbols: [
        {
          name: "check_rate_limit (rate_limiter.py v2.0)",
          location: "cvm_api/framework/rate_limiter.py:734",
          diffSemantic: "v1 单桶 → v2 四桶",
          callTree: [
            { repo: "cvm_api", file: "rate_limiter.py", line: 734, function: "check_rate_limit", risk: "P1" },
          ],
          riskTable: [{ priority: "P1", location: "rate_limiter.py:734", function: "check_rate_limit" }],
          downstreamContracts: [],
        },
      ],
      summary: {
        totalSymbolsChanged: 1,
        affectedRepos: 1,
        riskBreakdown: { P0: 0, P1: 1, P2: 0, P3: 0, NEEDS_HUMAN_REVIEW: 0 },
      },
    };
    const workerB = {
      symbols: [
        {
          name: "check_rate_limit",
          location: "framework/rate_limiter.py:734",
          diffSemantic: "core decision logic rewrite",
          callTree: [
            { repo: "cvm_api", file: "rate_limiter.py", line: 734, function: "check_rate_limit", risk: "P1" },
            { repo: "cvm_api", file: "bone.py", line: 553, function: "check_rate_limit", risk: "P1" },
          ],
          riskTable: [{ priority: "P1", location: "rate_limiter.py:734", function: "check_rate_limit" }],
          downstreamContracts: [],
        },
      ],
      summary: {
        totalSymbolsChanged: 1,
        affectedRepos: 1,
        riskBreakdown: { P0: 0, P1: 1, P2: 0, P3: 0, NEEDS_HUMAN_REVIEW: 0 },
      },
    };

    const merged = mergeAnalysisJsons([workerA, workerB]);

    // Crux of the fix: ONE merged symbol, not two.
    expect((merged.symbols as unknown[]).length).toBe(1);

    // Better name is preserved (longer = more context)
    const sym = (merged.symbols as unknown[])[0] as Record<string, unknown>;
    expect(sym.name).toBe("check_rate_limit (rate_limiter.py v2.0)");

    // Larger callTree wins
    expect((sym.callTree as unknown[]).length).toBe(2);
  });

  test("treats different file:line as different symbols", () => {
    // Sanity check: don't over-merge.
    const workerA = {
      symbols: [
        {
          name: "check_rate_limit",
          location: "cvm_api/framework/rate_limiter.py:734",
          diffSemantic: "in rate_limiter.py",
          callTree: [{ repo: "cvm_api", file: "x.py", line: 1 }],
          riskTable: [],
          downstreamContracts: [],
        },
      ],
    };
    const workerB = {
      symbols: [
        {
          name: "check_rate_limit",
          location: "cvm_api/framework/prototype/bone.py:553",
          diffSemantic: "wrapper in bone.py",
          callTree: [{ repo: "cvm_api", file: "y.py", line: 1 }],
          riskTable: [],
          downstreamContracts: [],
        },
      ],
    };

    const merged = mergeAnalysisJsons([workerA, workerB]);
    expect((merged.symbols as unknown[]).length).toBe(2);
  });

  test("merges riskTable entries from both workers (dedup by location)", () => {
    const workerA = {
      symbols: [
        {
          name: "foo",
          location: "x.py:10",
          callTree: [{ repo: "r", file: "x.py", line: 10 }],
          riskTable: [
            { priority: "P0", location: "x.py:10", function: "foo", remediation: "fix A" },
          ],
          downstreamContracts: [],
        },
      ],
    };
    const workerB = {
      symbols: [
        {
          name: "foo",
          location: "x.py:10",
          callTree: [{ repo: "r", file: "x.py", line: 10 }],
          riskTable: [
            { priority: "P0", location: "x.py:10", function: "foo", remediation: "fix A" }, // dup
            { priority: "P1", location: "y.py:20", function: "foo", remediation: "fix B" }, // new
          ],
          downstreamContracts: [],
        },
      ],
    };
    const merged = mergeAnalysisJsons([workerA, workerB]);
    const sym = (merged.symbols as unknown[])[0] as Record<string, unknown>;
    expect((sym.riskTable as unknown[]).length).toBe(2); // dedup by location
  });

  test("preserves affectedRepos union from callTrees", () => {
    const workerA = {
      symbols: [
        {
          name: "foo",
          location: "x.py:1",
          callTree: [{ repo: "repo-a" }, { repo: "repo-b" }],
          riskTable: [],
          downstreamContracts: [],
        },
      ],
    };
    const workerB = {
      symbols: [
        {
          name: "bar",
          location: "y.py:1",
          callTree: [{ repo: "repo-b" }, { repo: "repo-c" }], // repo-b overlap
          riskTable: [],
          downstreamContracts: [],
        },
      ],
    };
    const merged = mergeAnalysisJsons([workerA, workerB]);
    expect((merged.summary as Record<string, unknown>).affectedRepos).toBe(3);
  });

  test("skips empty shells (no callTree, no riskTable, no contracts, no diffSemantic)", () => {
    const worker = {
      symbols: [
        { name: "shell", location: "x.py:1", callTree: [], riskTable: [], downstreamContracts: [] },
        {
          name: "real",
          location: "y.py:1",
          diffSemantic: "actual change",
          callTree: [{ repo: "r" }],
          riskTable: [],
          downstreamContracts: [],
        },
      ],
    };
    const merged = mergeAnalysisJsons([worker]);
    expect((merged.symbols as unknown[]).length).toBe(1);
  });
});

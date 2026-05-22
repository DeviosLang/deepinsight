import { describe, expect, test } from "vitest";
import {
  computeInitialRisk,
  propagateRisk,
  prioritizeCallers,
  riskToLevel,
  DECAY_FACTORS,
} from "../src/risk/propagation.js";
import type { CallNode, CallType } from "../src/types/index.js";

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeNode(overrides: Partial<CallNode> & { id: string; symbol: string }): CallNode {
  return {
    repo: "test-repo",
    file: "src/test.py",
    line: 1,
    isPublicApi: false,
    isAuthCritical: false,
    isPayment: false,
    isExportedSymbol: false,
    isTestHelper: false,
    isCriticalPath: false,
    changeFrequency: 0,
    testCoverage: 0,
    ...overrides,
  };
}

// ─── computeInitialRisk ────────────────────────────────────────────────────────

describe("computeInitialRisk", () => {
  test("public API → 1.0", () => {
    const node = makeNode({ id: "a", symbol: "handler", isPublicApi: true });
    expect(computeInitialRisk(node)).toBe(1.0);
  });

  test("auth critical → 0.9", () => {
    const node = makeNode({ id: "a", symbol: "verify", isAuthCritical: true });
    expect(computeInitialRisk(node)).toBe(0.9);
  });

  test("payment → 0.9", () => {
    const node = makeNode({ id: "a", symbol: "charge", isPayment: true });
    expect(computeInitialRisk(node)).toBe(0.9);
  });

  test("exported symbol → 0.7", () => {
    const node = makeNode({ id: "a", symbol: "utils", isExportedSymbol: true });
    expect(computeInitialRisk(node)).toBe(0.7);
  });

  test("test helper → 0.1", () => {
    const node = makeNode({ id: "a", symbol: "mock", isTestHelper: true });
    expect(computeInitialRisk(node)).toBe(0.1);
  });

  test("default internal → 0.5", () => {
    const node = makeNode({ id: "a", symbol: "internal" });
    expect(computeInitialRisk(node)).toBe(0.5);
  });
});

// ─── riskToLevel ───────────────────────────────────────────────────────────────

describe("riskToLevel", () => {
  test("0.65 → P0", () => expect(riskToLevel(0.65)).toBe("P0"));
  test("0.60 → P0 (boundary)", () => expect(riskToLevel(0.6)).toBe("P0"));
  test("0.40 → P1", () => expect(riskToLevel(0.4)).toBe("P1"));
  test("0.30 → P1 (boundary)", () => expect(riskToLevel(0.3)).toBe("P1"));
  test("0.20 → P2", () => expect(riskToLevel(0.2)).toBe("P2"));
  test("0.15 → P2 (boundary)", () => expect(riskToLevel(0.15)).toBe("P2"));
  test("0.10 → P3", () => expect(riskToLevel(0.1)).toBe("P3"));
});

// ─── propagateRisk ─────────────────────────────────────────────────────────────

describe("propagateRisk", () => {
  test("linear chain with direct_call decay", () => {
    const A = makeNode({ id: "A", symbol: "A", isPublicApi: true });
    const B = makeNode({ id: "B", symbol: "B" });
    const C = makeNode({ id: "C", symbol: "C" });

    const callGraph: Record<string, CallNode[]> = {
      A: [B],
      B: [C],
      C: [],
    };

    const results = propagateRisk(
      A,
      (node) => callGraph[node.id] ?? [],
      () => "direct_call",
      undefined,
      1.0,
    );

    const riskOf = (id: string) => results.find((r) => r.node.id === id)?.propagatedRisk;
    expect(riskOf("A")).toBe(1.0);
    expect(riskOf("B")).toBeCloseTo(0.8);
    expect(riskOf("C")).toBeCloseTo(0.64);
  });

  test("MQ event decays fast — 2 hops below threshold", () => {
    const A = makeNode({ id: "A", symbol: "A" });
    const B = makeNode({ id: "B", symbol: "B" });
    const C = makeNode({ id: "C", symbol: "C" });

    const callGraph: Record<string, CallNode[]> = { A: [B], B: [C], C: [] };

    const results = propagateRisk(
      A,
      (node) => callGraph[node.id] ?? [],
      () => "mq_event",
      undefined,
      1.0,
    );

    const nodeB = results.find((r) => r.node.id === "B");
    const nodeC = results.find((r) => r.node.id === "C");

    expect(nodeB?.propagatedRisk).toBeCloseTo(0.4);
    // 0.4 * 0.4 = 0.16 > 0.15 threshold, still expanded
    expect(nodeC?.propagatedRisk).toBeCloseTo(0.16);
  });

  test("mixed call types decay correctly", () => {
    const A = makeNode({ id: "A", symbol: "A" });
    const B = makeNode({ id: "B", symbol: "B" });
    const C = makeNode({ id: "C", symbol: "C" });

    const callGraph: Record<string, CallNode[]> = { A: [B], B: [C], C: [] };
    const callTypes: Record<string, CallType> = { "A→B": "direct_call", "B→C": "http_api" };

    const results = propagateRisk(
      A,
      (node) => callGraph[node.id] ?? [],
      (callee, caller) => callTypes[`${callee.id}→${caller.id}`] ?? "direct_call",
      undefined,
      1.0,
    );

    const riskOf = (id: string) => results.find((r) => r.node.id === id)?.propagatedRisk;
    expect(riskOf("B")).toBeCloseTo(0.8); // direct_call: 1.0 * 0.8
    expect(riskOf("C")).toBeCloseTo(0.48); // http_api: 0.8 * 0.6
  });

  test("fanout pruning — only expands top 20", () => {
    const root = makeNode({ id: "root", symbol: "root" });
    const callers = Array.from({ length: 25 }, (_, i) =>
      makeNode({ id: `c${i}`, symbol: `caller_${i}` }),
    );

    const results = propagateRisk(
      root,
      (node) => (node.id === "root" ? callers : []),
      () => "direct_call",
      { maxFanoutPerLayer: 20 },
      1.0,
    );

    const rootResult = results.find((r) => r.node.id === "root");
    expect(rootResult?.prunedCallers).toBe(5);
    // root + 20 expanded callers = 21 (pruned 5 are not expanded)
    expect(results.length).toBe(21);
  });

  test("cycle detection — A→B→A does not loop", () => {
    const A = makeNode({ id: "A", symbol: "A" });
    const B = makeNode({ id: "B", symbol: "B" });

    const callGraph: Record<string, CallNode[]> = { A: [B], B: [A] };

    const results = propagateRisk(
      A,
      (node) => callGraph[node.id] ?? [],
      () => "direct_call",
      undefined,
      1.0,
    );

    // Should only have A and B, no infinite loop
    expect(results.length).toBe(2);
    expect(results.map((r) => r.node.id).sort()).toEqual(["A", "B"]);
  });

  test("MAX_DEPTH safety net — truncates at depth 5", () => {
    // Build a chain of 10 nodes
    const nodes = Array.from({ length: 10 }, (_, i) =>
      makeNode({ id: `n${i}`, symbol: `node_${i}` }),
    );
    const callGraph: Record<string, CallNode[]> = {};
    for (let i = 0; i < 9; i++) {
      callGraph[nodes[i].id] = [nodes[i + 1]];
    }
    callGraph[nodes[9].id] = [];

    const results = propagateRisk(
      nodes[0],
      (node) => callGraph[node.id] ?? [],
      () => "direct_call",
      { maxDepth: 5 },
      1.0,
    );

    // Should stop at depth 5 (6 nodes: depth 0,1,2,3,4,5)
    const maxDepthNode = results.reduce((max, r) => (r.depth > max.depth ? r : max), results[0]);
    expect(maxDepthNode.depth).toBe(5);
    expect(maxDepthNode.truncated).toBe(true);
    expect(results.length).toBe(6);
  });

  test("threshold boundary — 0.15 still expands, below does not", () => {
    const A = makeNode({ id: "A", symbol: "A" });
    const B = makeNode({ id: "B", symbol: "B" });
    const C = makeNode({ id: "C", symbol: "C" });

    const callGraph: Record<string, CallNode[]> = { A: [B], B: [C], C: [] };

    // Start at 0.2, direct_call decay 0.8 → B=0.16 (above 0.15) → C=0.128 (below)
    const results = propagateRisk(
      A,
      (node) => callGraph[node.id] ?? [],
      () => "direct_call",
      undefined,
      0.2,
    );

    const nodeB = results.find((r) => r.node.id === "B");
    const nodeC = results.find((r) => r.node.id === "C");

    expect(nodeB?.propagatedRisk).toBeCloseTo(0.16);
    expect(nodeB?.belowThreshold).toBeUndefined();
    expect(nodeC?.propagatedRisk).toBeCloseTo(0.128);
    expect(nodeC?.belowThreshold).toBe(true);
  });
});

// ─── prioritizeCallers ─────────────────────────────────────────────────────────

describe("prioritizeCallers", () => {
  test("public API nodes come first", () => {
    const nodes = [
      makeNode({ id: "a", symbol: "internal" }),
      makeNode({ id: "b", symbol: "public", isPublicApi: true }),
      makeNode({ id: "c", symbol: "critical", isCriticalPath: true }),
    ];

    const sorted = prioritizeCallers(nodes);
    expect(sorted[0].id).toBe("b"); // public API has highest score
    expect(sorted[1].id).toBe("c"); // critical path next
  });
});

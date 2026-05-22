import { describe, expect, test } from "vitest";
import { mergeWorkerResults, riskPriority } from "../src/merger/index.js";
import type { CallNode, RiskNode, WorkerResult } from "../src/types/index.js";

function makeRiskNode(overrides: Partial<RiskNode> & { id: string }): RiskNode {
  return {
    node: {
      id: overrides.id,
      repo: "test-repo",
      file: `src/${overrides.id}.py`,
      line: 10,
      symbol: overrides.id,
      isPublicApi: false,
      isAuthCritical: false,
      isPayment: false,
      isExportedSymbol: false,
      isTestHelper: false,
      isCriticalPath: false,
      changeFrequency: 0,
      testCoverage: 0,
      ...overrides.node,
    } as CallNode,
    propagatedRisk: 0.5,
    depth: 1,
    ...overrides,
  };
}

describe("mergeWorkerResults", () => {
  test("no-conflict merge — union of disjoint nodes", () => {
    const worker1: WorkerResult = {
      workerId: "w1",
      symbols: ["A"],
      callTreeNodes: [makeRiskNode({ id: "nodeA", propagatedRisk: 0.8 })],
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 },
      durationMs: 1000,
      verificationRounds: 0,
    };
    const worker2: WorkerResult = {
      workerId: "w2",
      symbols: ["B"],
      callTreeNodes: [makeRiskNode({ id: "nodeB", propagatedRisk: 0.6 })],
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 },
      durationMs: 1000,
      verificationRounds: 0,
    };

    const result = mergeWorkerResults([worker1, worker2]);
    expect(result.callTree.size).toBe(2);
    expect(result.riskTable.length).toBe(2);
  });

  test("same node hit by 2 workers — takes highest risk + hitCount=2", () => {
    const sharedNode1 = makeRiskNode({
      id: "login",
      node: { repo: "cvm-api", file: "views/login.py", line: 18 } as CallNode,
      propagatedRisk: 0.6,
    });
    const sharedNode2 = makeRiskNode({
      id: "login",
      node: { repo: "cvm-api", file: "views/login.py", line: 18 } as CallNode,
      propagatedRisk: 0.8,
    });

    const worker1: WorkerResult = {
      workerId: "w1",
      symbols: ["A"],
      callTreeNodes: [sharedNode1],
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 },
      durationMs: 1000,
      verificationRounds: 0,
    };
    const worker2: WorkerResult = {
      workerId: "w2",
      symbols: ["B"],
      callTreeNodes: [sharedNode2],
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 },
      durationMs: 1000,
      verificationRounds: 0,
    };

    const result = mergeWorkerResults([worker1, worker2]);
    expect(result.callTree.size).toBe(1);

    const merged = result.riskTable[0];
    expect(merged.propagatedRisk).toBe(0.8); // takes highest
    expect(merged.hitCount).toBe(2);
    expect(merged.annotation).toBe("被 2 条调用链命中");
  });

  test("risk table sorted by priority descending", () => {
    const nodes = [
      makeRiskNode({ id: "low", propagatedRisk: 0.2 }),
      makeRiskNode({ id: "high", propagatedRisk: 0.9 }),
      makeRiskNode({ id: "mid", propagatedRisk: 0.5 }),
    ];

    const worker: WorkerResult = {
      workerId: "w1",
      symbols: ["X"],
      callTreeNodes: nodes,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 },
      durationMs: 1000,
      verificationRounds: 0,
    };

    const result = mergeWorkerResults([worker]);
    expect(result.riskTable[0].node.id).toBe("high");
    expect(result.riskTable[1].node.id).toBe("mid");
    expect(result.riskTable[2].node.id).toBe("low");
  });

  test("empty worker result — returns empty", () => {
    const worker: WorkerResult = {
      workerId: "w1",
      symbols: [],
      callTreeNodes: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      durationMs: 0,
      verificationRounds: 0,
    };

    const result = mergeWorkerResults([worker]);
    expect(result.callTree.size).toBe(0);
    expect(result.riskTable.length).toBe(0);
  });
});

describe("riskPriority", () => {
  test("higher risk = higher priority", () => {
    const high = makeRiskNode({ id: "a", propagatedRisk: 0.9 });
    const low = makeRiskNode({ id: "b", propagatedRisk: 0.3 });
    expect(riskPriority(high)).toBeGreaterThan(riskPriority(low));
  });

  test("public API gets bonus", () => {
    const publicNode = makeRiskNode({
      id: "a",
      propagatedRisk: 0.5,
      node: { isPublicApi: true } as CallNode,
    });
    const internalNode = makeRiskNode({ id: "b", propagatedRisk: 0.5 });
    expect(riskPriority(publicNode)).toBeGreaterThan(riskPriority(internalNode));
  });
});

/**
 * DeepInsight Core — Deterministic Merger
 *
 * Merges results from multiple parallel pi workers into a single
 * unified call tree. No LLM calls — pure deterministic logic.
 */

import type { MergedResult, RiskNode, WorkerResult } from "../types/index.js";

/**
 * Compare risk priority for sorting (higher = more urgent).
 */
export function riskPriority(node: RiskNode): number {
  return node.propagatedRisk * 1000 + (node.node.isPublicApi ? 100 : 0);
}

/**
 * Generate a unique key for a call node (repo/file:line).
 */
function nodeKey(node: RiskNode): string {
  return `${node.node.repo}/${node.node.file}:${node.node.line}`;
}

/**
 * Merge results from multiple workers into a single unified result.
 *
 * Rules:
 * - Same node hit by multiple workers → take highest risk, merge via chains
 * - Multi-hit nodes get annotation ("被 N 条调用链命中")
 * - Final table sorted by risk priority (descending)
 */
export function mergeWorkerResults(results: WorkerResult[]): MergedResult {
  const callTree = new Map<string, RiskNode>();

  for (const result of results) {
    for (const node of result.callTreeNodes) {
      const key = nodeKey(node);

      if (callTree.has(key)) {
        const existing = callTree.get(key)!;

        // Take highest risk
        if (node.propagatedRisk > existing.propagatedRisk) {
          existing.propagatedRisk = node.propagatedRisk;
        }

        // Merge via chains
        const hitCount = (existing.hitCount ?? 1) + 1;
        existing.hitCount = hitCount;
        existing.annotation = `被 ${hitCount} 条调用链命中`;
      } else {
        callTree.set(key, { ...node, hitCount: 1 });
      }
    }
  }

  // Sort by risk priority descending
  const riskTable = [...callTree.values()].sort((a, b) => riskPriority(b) - riskPriority(a));

  return { callTree, riskTable };
}

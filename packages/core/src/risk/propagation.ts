/**
 * DeepInsight Core — Risk Propagation Algorithm
 *
 * Propagates risk scores through a call graph using decay factors
 * based on call types. Does NOT use fixed depth — risk naturally
 * attenuates based on coupling strength.
 */

import type { CallNode, CallType, RiskNode } from "../types/index.js";

// ─── Configuration ─────────────────────────────────────────────────────────────

/** Decay factor per call type: risk multiplied by this when crossing a call edge */
export const DECAY_FACTORS: Record<CallType, number> = {
  direct_call: 0.8,
  http_api: 0.6,
  mq_event: 0.4,
  config_reference: 0.3,
  dynamic_dispatch: 0.5,
};

/** Stop expanding when propagated risk falls below this threshold */
export const MIN_RISK_THRESHOLD = 0.15;

/** Maximum callers to expand per layer (prune by priority) */
export const MAX_FANOUT_PER_LAYER = 20;

/** Hard safety net — never expand beyond this depth */
export const MAX_DEPTH = 5;

/** Risk value thresholds for P0/P1/P2/P3 classification */
export const RISK_THRESHOLDS = {
  p0: 0.6,
  p1: 0.3,
  p2: 0.15,
} as const;

// ─── Types ─────────────────────────────────────────────────────────────────────

export type GetCallersFunction = (node: CallNode) => CallNode[];
export type ClassifyCallFunction = (callee: CallNode, caller: CallNode) => CallType;

export interface PropagationConfig {
  decayFactors?: Partial<Record<CallType, number>>;
  minRiskThreshold?: number;
  maxFanoutPerLayer?: number;
  maxDepth?: number;
}

// ─── Core Algorithm ────────────────────────────────────────────────────────────

/**
 * Compute the initial risk value for a node based on its properties.
 * This is the starting point before propagation.
 */
export function computeInitialRisk(node: CallNode): number {
  if (node.isPublicApi) return 1.0;
  if (node.isAuthCritical || node.isPayment) return 0.9;
  if (node.isExportedSymbol) return 0.7;
  if (node.isTestHelper) return 0.1;
  return 0.5;
}

/**
 * Prioritize callers for expansion when fanout exceeds limit.
 * Higher score = expand first.
 */
export function prioritizeCallers(callers: CallNode[]): CallNode[] {
  return [...callers].sort((a, b) => {
    const score = (c: CallNode) =>
      (c.isPublicApi ? 8 : 0) +
      (c.isCriticalPath ? 4 : 0) +
      c.changeFrequency * 2 -
      c.testCoverage;
    return score(b) - score(a);
  });
}

/**
 * Map a numeric risk value to P0/P1/P2/P3 classification.
 */
export function riskToLevel(risk: number): "P0" | "P1" | "P2" | "P3" {
  if (risk >= RISK_THRESHOLDS.p0) return "P0";
  if (risk >= RISK_THRESHOLDS.p1) return "P1";
  if (risk >= RISK_THRESHOLDS.p2) return "P2";
  return "P3";
}

/**
 * Propagate risk from a root node through the call graph.
 *
 * @param rootNode - The changed symbol (starting point)
 * @param getCallers - Function to retrieve callers of a node
 * @param classifyCall - Function to classify the call type between two nodes
 * @param config - Optional configuration overrides
 * @param initialRisk - Optional override for the root node's initial risk
 */
export function propagateRisk(
  rootNode: CallNode,
  getCallers: GetCallersFunction,
  classifyCall: ClassifyCallFunction,
  config?: PropagationConfig,
  initialRisk?: number,
): RiskNode[] {
  const decayFactors = { ...DECAY_FACTORS, ...config?.decayFactors };
  const minThreshold = config?.minRiskThreshold ?? MIN_RISK_THRESHOLD;
  const maxFanout = config?.maxFanoutPerLayer ?? MAX_FANOUT_PER_LAYER;
  const maxDepth = config?.maxDepth ?? MAX_DEPTH;

  const risk = initialRisk ?? computeInitialRisk(rootNode);
  const queue: Array<[CallNode, number, number, string]> = [[rootNode, risk, 0, rootNode.symbol]];
  const visited = new Set<string>();
  const resultNodes: RiskNode[] = [];

  while (queue.length > 0) {
    const [node, nodeRisk, depth, viaChain] = queue.shift()!;

    if (visited.has(node.id)) continue;
    visited.add(node.id);

    const riskNode: RiskNode = {
      node,
      propagatedRisk: nodeRisk,
      depth,
      viaChain,
      truncated: depth >= maxDepth,
    };
    resultNodes.push(riskNode);

    // Hard depth limit
    if (depth >= maxDepth) continue;

    let callers = getCallers(node);

    // Fanout pruning
    if (callers.length > maxFanout) {
      riskNode.prunedCallers = callers.length - maxFanout;
      callers = prioritizeCallers(callers).slice(0, maxFanout);
    }

    for (const caller of callers) {
      if (visited.has(caller.id)) continue;

      const callType = classifyCall(node, caller);
      const decay = decayFactors[callType];
      const newRisk = nodeRisk * decay;

      if (newRisk < minThreshold) {
        // Record but don't expand further
        resultNodes.push({
          node: caller,
          propagatedRisk: newRisk,
          depth: depth + 1,
          callType,
          viaChain: `${viaChain} → ${caller.symbol}`,
          belowThreshold: true,
        });
        continue;
      }

      queue.push([caller, newRisk, depth + 1, `${viaChain} → ${caller.symbol}`]);
    }
  }

  return resultNodes;
}

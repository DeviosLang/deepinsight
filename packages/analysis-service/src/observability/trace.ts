/**
 * Observability — Opik trace integration + cost tracking.
 *
 * Records each analysis task as an Opik trace with spans for:
 * - getDiff (step 1)
 * - extractSymbols (step 2)
 * - coarseFilter (step 3)
 * - piWorker (step 4) — includes token usage and tool call count
 * - parseResult (step 5)
 *
 * Cost model: token-based pricing from tokenhub.
 */

import type { AnalysisTask } from "@deepinsight/core";
import type { PiWorkerResult } from "../orchestrator/piWorker.js";

// Opik client — lazy initialized to avoid blocking startup if Opik is down
let opikClient: any = null;
let opikInitialized = false;

const OPIK_BASE_URL = process.env.OPIK_BASE_URL ?? "http://opik-backend:8080";
const OPIK_PROJECT = process.env.OPIK_PROJECT ?? "call_chain";

// Cost model (per 1M tokens, USD)
const COST_PER_1M_INPUT = Number(process.env.LLM_COST_PER_1M_INPUT ?? "0.5");
const COST_PER_1M_OUTPUT = Number(process.env.LLM_COST_PER_1M_OUTPUT ?? "2.0");

async function getOpikClient(): Promise<any> {
  if (opikInitialized) return opikClient;
  opikInitialized = true;

  try {
    const { Opik } = await import("opik");
    opikClient = new Opik({
      apiUrl: OPIK_BASE_URL,
      projectName: OPIK_PROJECT,
    });
    console.log(`[opik] Initialized: ${OPIK_BASE_URL}, project=${OPIK_PROJECT}`);
  } catch (err) {
    console.warn(`[opik] Failed to initialize (analysis will continue without tracing): ${err instanceof Error ? err.message : String(err)}`);
    opikClient = null;
  }
  return opikClient;
}

export interface TraceContext {
  traceId: string;
  startTime: number;
  spans: SpanRecord[];
}

interface SpanRecord {
  name: string;
  startTime: number;
  endTime: number;
  metadata?: Record<string, unknown>;
}

/**
 * Start a new trace for an analysis task.
 */
export function startTrace(task: AnalysisTask): TraceContext {
  return {
    traceId: task.taskId,
    startTime: Date.now(),
    spans: [],
  };
}

/**
 * Record a span (pipeline step).
 */
export function recordSpan(
  ctx: TraceContext,
  name: string,
  startTime: number,
  metadata?: Record<string, unknown>,
): void {
  ctx.spans.push({
    name,
    startTime,
    endTime: Date.now(),
    metadata,
  });
}

/**
 * Calculate cost from pi worker result.
 */
export function calculateCost(piResult: PiWorkerResult): {
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
} {
  const inputTokens = piResult.usage?.inputTokens ?? 0;
  const outputTokens = piResult.usage?.outputTokens ?? 0;
  const totalCostUsd =
    (inputTokens / 1_000_000) * COST_PER_1M_INPUT +
    (outputTokens / 1_000_000) * COST_PER_1M_OUTPUT;

  return { inputTokens, outputTokens, totalCostUsd };
}

/**
 * Flush trace to Opik (fire-and-forget, never blocks pipeline).
 */
export async function flushTrace(
  ctx: TraceContext,
  task: AnalysisTask,
  piResult?: PiWorkerResult,
): Promise<void> {
  const client = await getOpikClient();
  if (!client) return; // Opik unavailable, skip silently

  try {
    const cost = piResult ? calculateCost(piResult) : { inputTokens: 0, outputTokens: 0, totalCostUsd: 0 };
    const durationMs = Date.now() - ctx.startTime;

    const trace = client.trace({
      name: `analysis:${task.taskId}`,
      projectName: OPIK_PROJECT,
      input: {
        project: task.project,
        repo: task.changes[0]?.repo,
        commit: task.changes[0]?.commit,
        base: task.changes[0]?.base,
      },
      output: {
        status: task.status,
        error: task.error,
        hasResult: !!task.result,
        resultSizeChars: task.result ? JSON.stringify(task.result).length : 0,
      },
      metadata: {
        durationMs,
        durationFormatted: `${(durationMs / 1000).toFixed(1)}s`,
        inputTokens: cost.inputTokens,
        outputTokens: cost.outputTokens,
        totalCostUsd: cost.totalCostUsd,
        toolCallCount: piResult?.toolCallCount ?? 0,
        turnCount: piResult?.turnCount ?? 0,
        piOutputChars: piResult?.output.length ?? 0,
        timedOut: piResult ? piResult.durationMs >= 895_000 : false,
        steerTriggered: piResult ? piResult.durationMs >= 800_000 : false,
        degradedMode: !piResult,
      },
      tags: [
        task.status ?? "unknown",
        piResult?.toolCallCount ? `tools:${piResult.toolCallCount}` : "tools:0",
        piResult && piResult.durationMs >= 895_000 ? "timeout" : "completed",
      ],
    });

    // Add spans for each pipeline step
    for (const span of ctx.spans) {
      trace.span({
        name: span.name,
        startTime: new Date(span.startTime),
        endTime: new Date(span.endTime),
        metadata: span.metadata,
      });
    }

    await trace.end();
    await client.flush();
    console.log(`[opik] Trace flushed: ${task.taskId} (${(durationMs / 1000).toFixed(1)}s, $${cost.totalCostUsd.toFixed(4)}, turns=${piResult?.turnCount ?? 0}, tools=${piResult?.toolCallCount ?? 0})`);
  } catch (err) {
    // Never let tracing failure break the pipeline
    console.warn(`[opik] Failed to flush trace ${task.taskId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * LLM failure tracker for degradation logic.
 */
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 3;

export function recordLlmSuccess(): void {
  consecutiveFailures = 0;
}

export function recordLlmFailure(): void {
  consecutiveFailures++;
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    console.warn(`[degradation] LLM failed ${consecutiveFailures} consecutive times — degraded mode active`);
  }
}

export function isInDegradedMode(): boolean {
  return consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
}

export function resetDegradation(): void {
  consecutiveFailures = 0;
}

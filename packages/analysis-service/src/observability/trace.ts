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
 *
 * Uses direct HTTP calls to Opik backend (bypasses SDK due to
 * path mismatch between SDK v2.0.48 and backend v2.0.37).
 * API paths: /v1/private/traces/batch, /v1/private/spans/batch
 * IDs must be UUID v7 format.
 */

import * as crypto from "node:crypto";
import type { AnalysisTask } from "@deepinsight/core";
import type { PiWorkerResult } from "../orchestrator/piWorker.js";

const OPIK_BASE_URL = process.env.OPIK_BASE_URL ?? "http://opik-backend:8080";
const OPIK_PROJECT = process.env.OPIK_PROJECT ?? "call_chain";

// Cost model (per 1M tokens, USD)
const COST_PER_1M_INPUT = Number(process.env.LLM_COST_PER_1M_INPUT ?? "0.5");
const COST_PER_1M_OUTPUT = Number(process.env.LLM_COST_PER_1M_OUTPUT ?? "2.0");

// ─── UUID v7 Generator ────────────────────────────────────────────────────────

/**
 * Generate a UUID v7 (time-ordered, random suffix).
 * Format: xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
 * - First 48 bits: Unix timestamp in milliseconds
 * - Version nibble: 7
 * - Variant bits: 10xx
 * - Remaining: cryptographically random
 */
function uuidV7(): string {
  const now = Date.now();

  // 6 bytes for timestamp (48 bits = ms since epoch)
  const timeBytes = new Uint8Array(6);
  timeBytes[0] = (now / 2 ** 40) & 0xff;
  timeBytes[1] = (now / 2 ** 32) & 0xff;
  timeBytes[2] = (now / 2 ** 24) & 0xff;
  timeBytes[3] = (now / 2 ** 16) & 0xff;
  timeBytes[4] = (now / 2 ** 8) & 0xff;
  timeBytes[5] = now & 0xff;

  // 10 bytes random
  const randBytes = crypto.randomBytes(10);

  // Compose 16-byte UUID
  const uuid = new Uint8Array(16);
  uuid.set(timeBytes, 0); // bytes 0-5: timestamp
  uuid[6] = (0x70 | (randBytes[0] & 0x0f)); // byte 6: version 7 + 4 random bits
  uuid[7] = randBytes[1]; // byte 7: random
  uuid[8] = (0x80 | (randBytes[2] & 0x3f)); // byte 8: variant 10 + 6 random bits
  uuid[9] = randBytes[3]; // bytes 9-15: random
  uuid[10] = randBytes[4];
  uuid[11] = randBytes[5];
  uuid[12] = randBytes[6];
  uuid[13] = randBytes[7];
  uuid[14] = randBytes[8];
  uuid[15] = randBytes[9];

  // Format as UUID string
  const hex = Buffer.from(uuid).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ─── Direct HTTP Client for Opik ──────────────────────────────────────────────

interface OpikTrace {
  id: string;
  project_name: string;
  name: string;
  start_time: string;
  end_time?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

interface OpikSpan {
  id: string;
  project_name: string;
  trace_id: string;
  parent_span_id?: string;
  name: string;
  type?: "general" | "tool" | "llm";
  start_time: string;
  end_time?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  model?: string;
  provider?: string;
  usage?: Record<string, number>;
  total_estimated_cost?: number;
}

async function postTraces(traces: OpikTrace[]): Promise<boolean> {
  try {
    const url = `${OPIK_BASE_URL}/v1/private/traces/batch`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ traces }),
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) return true;

    const body = await response.text().catch(() => "");
    console.warn(`[opik] POST traces/batch → ${response.status}: ${body.slice(0, 200)}`);
    return false;
  } catch (err) {
    console.warn(`[opik] POST traces/batch failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function postSpans(spans: OpikSpan[]): Promise<boolean> {
  try {
    const url = `${OPIK_BASE_URL}/v1/private/spans/batch`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spans }),
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) return true;

    const body = await response.text().catch(() => "");
    console.warn(`[opik] POST spans/batch → ${response.status}: ${body.slice(0, 200)}`);
    return false;
  } catch (err) {
    console.warn(`[opik] POST spans/batch failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

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
 * Uses UUID v7 as trace ID (required by Opik backend).
 */
export function startTrace(task: AnalysisTask): TraceContext {
  return {
    traceId: uuidV7(),
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
 * Uses direct HTTP to /v1/private/traces/batch and /v1/private/spans/batch.
 */
export async function flushTrace(
  ctx: TraceContext,
  task: AnalysisTask,
  piResult?: PiWorkerResult,
): Promise<void> {
  try {
    const cost = piResult ? calculateCost(piResult) : { inputTokens: 0, outputTokens: 0, totalCostUsd: 0 };
    const durationMs = Date.now() - ctx.startTime;
    const endTime = new Date().toISOString();
    const startTime = new Date(ctx.startTime).toISOString();

    // Build trace
    const trace: OpikTrace = {
      id: ctx.traceId,
      project_name: OPIK_PROJECT,
      name: `analysis:${task.taskId}`,
      start_time: startTime,
      end_time: endTime,
      input: {
        project: task.project,
        repo: task.changes[0]?.repo,
        commit: task.changes[0]?.commit,
        base: task.changes[0]?.base,
      },
      output: {
        status: task.status,
        error: task.error ?? null,
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
    };

    // Build spans
    const spans: OpikSpan[] = ctx.spans.map((span) => ({
      id: uuidV7(),
      project_name: OPIK_PROJECT,
      trace_id: ctx.traceId,
      name: span.name,
      type: span.name.includes("piWorker") ? "llm" as const : "general" as const,
      start_time: new Date(span.startTime).toISOString(),
      end_time: new Date(span.endTime).toISOString(),
      metadata: span.metadata,
      ...(span.name.includes("piWorker") && piResult
        ? {
            model: process.env.LLM_MODEL ?? "deepseek-v4-pro",
            provider: "tokenhub",
            usage: {
              input: cost.inputTokens,
              output: cost.outputTokens,
              total: cost.inputTokens + cost.outputTokens,
            },
            total_estimated_cost: cost.totalCostUsd,
          }
        : {}),
    }));

    // Send trace first, then spans (spans reference trace_id)
    const traceOk = await postTraces([trace]);
    if (traceOk && spans.length > 0) {
      await postSpans(spans);
    }

    console.log(
      `[opik] Trace flushed: ${ctx.traceId} (task=${task.taskId}, ${(durationMs / 1000).toFixed(1)}s, $${cost.totalCostUsd.toFixed(4)}, turns=${piResult?.turnCount ?? 0}, tools=${piResult?.toolCallCount ?? 0})`,
    );
  } catch (err) {
    // Never let tracing failure break the pipeline
    console.warn(`[opik] Failed to flush trace ${ctx.traceId}: ${err instanceof Error ? err.message : String(err)}`);
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

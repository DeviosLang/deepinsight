/**
 * Analysis Pipeline — orchestrates the full analysis flow:
 *   1. Get diff from repo
 *   2. Pre-filter (coarse + fine) to narrow target repos
 *   3. Spawn pi worker with prompt
 *   4. Parse result
 *   5. Return structured report
 */

import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import type { AnalysisTask, AnalysisResult, ChangeSpec, RiskLevel } from "@deepinsight/core";
import { RepoManager } from "../repo/repoManager.js";
import { coarseFilter } from "../pre-filter/index.js";
import { runPiWorker, buildAnalysisPrompt, extractJsonFromOutput } from "./piWorker.js";
import type { PiWorkerConfig } from "./piWorker.js";
import type { Symbol } from "../pre-filter/index.js";
import {
  startTrace,
  recordSpan,
  calculateCost,
  flushTrace,
  recordLlmSuccess,
  recordLlmFailure,
  isInDegradedMode,
} from "../observability/trace.js";

export interface PipelineConfig {
  workspaceDir: string;
  scratchDir: string;
  skillPath: string;
  llm: {
    provider: string;
    model: string;
    apiKey: string;
    baseUrl: string;
  };
  /** Repos to analyze against (if empty, scans all available) */
  targetRepos?: string[];
  /** Directory patterns to exclude from diff (e.g., test directories) */
  excludeDirs?: string[];
  /** Entry point repos — always included in analysis regardless of grep hits */
  entryPointRepos?: string[];
}

/**
 * Load pipeline config from environment variables and project config.
 */
export function loadPipelineConfig(): PipelineConfig {
  const projectConfigPath = process.env.PROJECT_CONFIG_PATH ?? "/etc/deepinsight/project.yml";
  let excludeDirs: string[] = [];
  let entryPointRepos: string[] = [];

  try {
    const rawYaml = fs.readFileSync(projectConfigPath, "utf-8");
    const config = YAML.parse(rawYaml) as Record<string, unknown>;

    // Parse filter.exclude_dirs
    const filter = config.filter as Record<string, unknown> | undefined;
    if (filter && Array.isArray(filter.exclude_dirs)) {
      excludeDirs = filter.exclude_dirs.map(String);
    }

    // Parse repos.entry_points
    const repos = config.repos as Record<string, unknown> | undefined;
    if (repos && Array.isArray(repos.entry_points)) {
      entryPointRepos = repos.entry_points.map(String);
    }
  } catch (err) {
    // Differentiate "file missing" (expected on dev) vs "parse / read error"
    // (misconfigured deployment). Without this, a typo'd YAML would silently
    // run with default exclusion lists and entry points — the most common
    // cause of "why did it analyse the wrong repos?" support tickets.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      console.log(`[config] No project config at ${projectConfigPath}, using defaults`);
    } else {
      console.warn(
        `[config] Failed to load project config at ${projectConfigPath}: ${err instanceof Error ? err.message : String(err)} — falling back to defaults`,
      );
    }
  }

  // Default exclude patterns if none configured
  if (excludeDirs.length === 0) {
    excludeDirs = ["tests/", "test/", "*/tests/", "*/test/"];
  }

  return {
    workspaceDir: process.env.WORKSPACE_DIR ?? "/data/workspace",
    scratchDir: process.env.SCRATCH_DIR ?? "/data/scratch",
    skillPath: path.resolve("/app/packages/pi-skill/SKILL.md"),
    llm: {
      provider: "openai",
      model: process.env.LLM_MODEL ?? "deepseek-v4-pro",
      apiKey: process.env.LLM_ANALYSIS_API_KEY ?? "",
      baseUrl: process.env.LLM_BASE_URL ?? "",
    },
    excludeDirs,
    entryPointRepos,
  };
}

/**
 * Execute the full analysis pipeline for a task.
 */
export async function runAnalysisPipeline(
  task: AnalysisTask,
  config: PipelineConfig,
): Promise<AnalysisResult | null> {
  const traceCtx = startTrace(task);
  const repoManager = new RepoManager({
    workspaceDir: config.workspaceDir,
    scratchDir: config.scratchDir,
  });

  const change = task.changes[0]; // Phase 1a: single change
  if (!change) return null;

  // Check degradation mode — if LLM is down, skip pi and return grep-only result
  if (isInDegradedMode()) {
    console.log(`[pipeline:${task.taskId}] ⚠️ Degraded mode active — skipping LLM, returning grep-only result`);
  }

  // ─── Step 1: Get diff ────────────────────────────────────────────────────────
  task.progress = { step: 1, stepName: "获取 diff", reposScanned: 0, reposTotal: 0 };
  console.log(`[pipeline:${task.taskId}] Step 1: Getting diff for ${change.repo} (${change.base} → ${change.commit ?? 'HEAD'})`);

  const diff = getDiff(repoManager, change, config.excludeDirs);
  if (!diff) {
    task.error = `无法获取 ${change.repo} 的 diff`;
    return null;
  }
  console.log(`[pipeline:${task.taskId}] Step 1 done: diff size = ${diff.length} chars (excludeDirs: ${config.excludeDirs?.join(', ') ?? 'none'})`);

  // ─── Step 2: Extract symbols (simple heuristic for Phase 1a) ──────────────────
  task.progress = { step: 2, stepName: "提取变更符号", reposScanned: 0, reposTotal: 0 };

  const symbols = extractSymbolsFromDiff(diff);
  if (symbols.length === 0) {
    task.error = "diff 中未发现可分析的符号变更";
    return null;
  }
  console.log(`[pipeline:${task.taskId}] Step 2 done: ${symbols.length} symbols: ${symbols.map(s => s.name).join(', ')}`);

  // ─── Step 3: Pre-filter (coarse only for Phase 1a) ────────────────────────────
  task.progress = { step: 3, stepName: "预筛目标仓库", reposScanned: 0, reposTotal: 0 };

  const allRepos = config.targetRepos ?? repoManager.listRepos();
  const targetRepos = allRepos.filter((r) => r !== change.repo); // exclude self

  // Coarse filter: parallel git grep on NFS
  console.log(`[pipeline:${task.taskId}] Step 3: Running coarse filter on ${targetRepos.length} repos (parallel)...`);
  const coarseHits = await coarseFilter(symbols, targetRepos, repoManager);
  console.log(`[pipeline:${task.taskId}] Step 3 done: ${coarseHits.size} repos hit: ${[...coarseHits].join(', ')}`);

  task.progress = {
    step: 3,
    stepName: "预筛完成",
    reposScanned: targetRepos.length,
    reposTotal: allRepos.length,
  };

  // ─── Step 3.5: Merge entry point repos (always analyzed) ─────────────────────
  const entryPoints = (config.entryPointRepos ?? []).filter(
    (r) => r !== change.repo && repoManager.repoExists(r),
  );
  const finalTargetRepos = new Set([...coarseHits, ...entryPoints]);
  if (entryPoints.length > 0) {
    console.log(`[pipeline:${task.taskId}] Step 3.5: Added entry point repos: ${entryPoints.join(', ')} → total ${finalTargetRepos.size} repos`);
  }

  // ─── Step 4: Spawn pi worker ──────────────────────────────────────────────────
  task.progress = {
    step: 4,
    stepName: isInDegradedMode() ? "降级模式(跳过LLM)" : "AI 分析中",
    reposScanned: finalTargetRepos.size,
    reposTotal: targetRepos.length,
  };

  recordSpan(traceCtx, "step3_prefilter", traceCtx.startTime, {
    reposScanned: targetRepos.length,
    reposHit: coarseHits.size,
    entryPointsAdded: entryPoints.length,
  });

  let piResult: Awaited<ReturnType<typeof runPiWorker>> | null = null;

  if (!isInDegradedMode()) {
    const prompt = buildAnalysisPrompt({
      diff,
      repoName: change.repo,
      reposRoot: config.workspaceDir,
      targetRepos: [...finalTargetRepos],
      entryPointRepos: entryPoints,
    });
    console.log(`[pipeline:${task.taskId}] Step 4: Spawning pi worker, prompt size = ${prompt.length} chars, target repos = ${[...finalTargetRepos].join(', ') || '(none, will scan all)'}`);

    const piConfig: PiWorkerConfig = {
      provider: "tokenhub",
      model: config.llm.model,
      apiKey: config.llm.apiKey,
      baseUrl: config.llm.baseUrl,
      cwd: config.workspaceDir,
      timeoutMs: 900_000,
      thinkingLevel: "medium",
      skillPath: config.skillPath,
    };

    const step4Start = Date.now();
    piResult = await runPiWorker(prompt, piConfig);

    if (piResult.success) {
      recordLlmSuccess();
    } else {
      recordLlmFailure();
      task.error = `pi agent 分析失败: ${piResult.error}`;
    }

    const cost = calculateCost(piResult);
    recordSpan(traceCtx, "step4_piWorker", step4Start, {
      success: piResult.success,
      durationMs: piResult.durationMs,
      outputChars: piResult.output.length,
      toolCalls: piResult.toolCallCount,
      turns: piResult.turnCount,
      ...cost,
    });
    console.log(`[pipeline:${task.taskId}] Step 4 cost: $${cost.totalCostUsd.toFixed(4)} (input: ${cost.inputTokens}, output: ${cost.outputTokens})`);
  } else {
    // Degraded mode: skip pi, return grep-only result
    console.log(`[pipeline:${task.taskId}] Step 4: SKIPPED (degraded mode)`);
    recordSpan(traceCtx, "step4_degraded", Date.now());
  }

  // ─── Step 5: Parse result ─────────────────────────────────────────────────────
  task.progress = { step: 5, stepName: "解析结果", reposScanned: coarseHits.size, reposTotal: targetRepos.length };

  const piOutput = piResult?.output ?? "";
  const jsonResult = extractJsonFromOutput(piOutput);

  // Schema-validate before trusting the cast. pi can return malformed JSON
  // (missing summary fields, non-array symbols) on partial completion or
  // when the LLM hallucinates structure. Without this guard, downstream
  // consumers crash on `result.summary.riskBreakdown.P0` etc.
  if (jsonResult && isValidAnalysisResult(jsonResult)) {
    // Add metadata about the analysis run
    (jsonResult as Record<string, unknown>)._meta = {
      durationMs: piResult?.durationMs,
      turns: piResult?.turnCount,
      toolCalls: piResult?.toolCallCount,
      timedOut: piResult ? !piResult.success && piResult.error?.includes("timeout") : false,
      degraded: isInDegradedMode(),
    };
    // Flush trace in background (fire-and-forget)
    flushTrace(traceCtx, task, piResult ?? undefined).catch(() => {});
    return jsonResult as unknown as AnalysisResult;
  }

  if (jsonResult) {
    console.warn(
      `[pipeline:${task.taskId}] Step 5: Extracted JSON failed schema validation; falling back to raw partial result. Reason: ${describeValidationFailure(jsonResult)}`,
    );
  }

  // No structured JSON found — return raw output as partial result
  // This happens when pi timed out before producing the final ```json block
  const isTimeout = piResult ? (!piResult.success || (piResult.durationMs ?? 0) >= 895_000) : false;
  console.log(`[pipeline:${task.taskId}] Step 5: No JSON block found in output (${piOutput.length} chars, timeout=${isTimeout}). Returning raw partial result.`);

  // Flush trace for partial result
  flushTrace(traceCtx, task, piResult ?? undefined).catch(() => {});

  return {
    summary: {
      totalSymbolsChanged: symbols.length,
      affectedRepos: coarseHits.size,
      unaffectedRepos: targetRepos.length - coarseHits.size,
      riskBreakdown: { P0: 0, P1: 0, P2: 0, P3: 0, NEEDS_HUMAN_REVIEW: 0 },
    },
    symbols: symbols.map((s) => ({
      name: s.name,
      location: `${change.repo}`,
      diffSemantic: "见原始输出",
      initialRisk: "medium" as const,
      callTree: [],
      riskTable: [],
    })),
    untrackable: [],
    globalPatternsMatched: [],
    _rawOutput: truncateRawOutput(piOutput),
  } as unknown as AnalysisResult;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

const REQUIRED_RISK_KEYS: ReadonlyArray<RiskLevel> = ["P0", "P1", "P2", "P3", "NEEDS_HUMAN_REVIEW"];

/**
 * Validate that an arbitrary parsed-JSON object conforms to AnalysisResult's
 * required shape. Tolerant of extra fields (forward-compat) but strict on
 * the fields downstream consumers will dereference.
 */
function isValidAnalysisResult(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;

  // summary.{totalSymbolsChanged, affectedRepos, unaffectedRepos, riskBreakdown}
  const summary = o.summary;
  if (typeof summary !== "object" || summary === null) return false;
  const s = summary as Record<string, unknown>;
  if (typeof s.totalSymbolsChanged !== "number") return false;
  if (typeof s.affectedRepos !== "number") return false;
  if (typeof s.unaffectedRepos !== "number") return false;
  if (typeof s.riskBreakdown !== "object" || s.riskBreakdown === null) return false;
  const rb = s.riskBreakdown as Record<string, unknown>;
  for (const key of REQUIRED_RISK_KEYS) {
    if (typeof rb[key] !== "number") return false;
  }

  // symbols must be an array (entries can be loose; downstream tolerates)
  if (!Array.isArray(o.symbols)) return false;

  // untrackable + globalPatternsMatched: arrays if present
  if (o.untrackable !== undefined && !Array.isArray(o.untrackable)) return false;
  if (o.globalPatternsMatched !== undefined && !Array.isArray(o.globalPatternsMatched)) return false;

  return true;
}

/** Produce a short reason for why validation failed (for logging only). */
function describeValidationFailure(obj: unknown): string {
  if (typeof obj !== "object" || obj === null) return "not an object";
  const o = obj as Record<string, unknown>;
  if (typeof o.summary !== "object" || o.summary === null) return "missing summary";
  const s = o.summary as Record<string, unknown>;
  if (typeof s.riskBreakdown !== "object" || s.riskBreakdown === null) return "missing summary.riskBreakdown";
  const rb = s.riskBreakdown as Record<string, unknown>;
  const missingKeys = REQUIRED_RISK_KEYS.filter((k) => typeof rb[k] !== "number");
  if (missingKeys.length > 0) return `riskBreakdown missing keys: ${missingKeys.join(",")}`;
  if (!Array.isArray(o.symbols)) return "symbols is not an array";
  return "unknown validation error";
}

/**
 * Truncate raw pi output for storage — keep only the last 4KB
 * (the final assistant message with analysis content, not the thinking process).
 */
function truncateRawOutput(output: string): string {
  const MAX_RAW_LENGTH = 4096;
  if (output.length <= MAX_RAW_LENGTH) return output;
  return "...(truncated)...\n" + output.slice(-MAX_RAW_LENGTH);
}

function getDiff(repoManager: RepoManager, change: ChangeSpec, excludeDirs?: string[]): string | null {
  if (!repoManager.repoExists(change.repo)) return null;

  const base = change.base ?? "HEAD~1";
  const head = change.commit ?? "HEAD";

  if (excludeDirs && excludeDirs.length > 0) {
    // Use git diff with pathspec exclusions: -- ':!tests/' ':!test/'
    const diff = repoManager.getDiffWithExcludes(change.repo, base, head, excludeDirs);
    return diff || null;
  }

  const diff = repoManager.getDiff(change.repo, base, head);
  return diff || null;
}

/**
 * Extract symbols from diff: function/class names from changed lines AND hunk headers.
 *
 * Hunk headers (e.g., `@@ -468,7 +468,7 @@ def update_translog(msg):`)
 * tell us which function/class contains the changed lines, even if the
 * def/class line itself wasn't modified.
 */
function extractSymbolsFromDiff(diff: string): Symbol[] {
  const symbols: Symbol[] = [];
  const seen = new Set<string>();

  const lines = diff.split("\n");
  for (const line of lines) {
    // 1. Hunk header — extract containing function/class name
    //    Format: @@ -start,count +start,count @@ def function_name(...)
    const hunkMatch = line.match(/^@@\s.*@@\s*(?:def|class)\s+(\w+)/);
    if (hunkMatch && !seen.has(hunkMatch[1])) {
      seen.add(hunkMatch[1]);
      symbols.push({ name: hunkMatch[1], pattern: `${hunkMatch[1]}($$$)` });
      continue;
    }

    // 2. Changed lines with def/class declarations
    if (!line.startsWith("+") && !line.startsWith("-")) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;

    // Python function
    const funcMatch = line.match(/^\+?\-?\s*def\s+(\w+)\s*\(/);
    if (funcMatch && !seen.has(funcMatch[1])) {
      seen.add(funcMatch[1]);
      symbols.push({ name: funcMatch[1], pattern: `${funcMatch[1]}($$$)` });
    }

    // Python class
    const classMatch = line.match(/^\+?\-?\s*class\s+(\w+)[\s(:]/);
    if (classMatch && !seen.has(classMatch[1])) {
      seen.add(classMatch[1]);
      symbols.push({ name: classMatch[1] });
    }
  }

  return symbols;
}

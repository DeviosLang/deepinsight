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
import type { AnalysisTask, AnalysisResult, ChangeSpec } from "@deepinsight/core";
import { RepoManager } from "../repo/repoManager.js";
import { coarseFilter } from "../pre-filter/index.js";
import { runPiWorker, buildAnalysisPrompt, extractJsonFromOutput } from "./piWorker.js";
import type { PiWorkerConfig } from "./piWorker.js";
import type { Symbol } from "../pre-filter/index.js";

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
  // Load project.yml for filter config
  const projectConfigPath = process.env.PROJECT_CONFIG_PATH ?? "/etc/deepinsight/project.yml";
  let excludeDirs: string[] = [];
  let entryPointRepos: string[] = [];

  try {
    const yaml = fs.readFileSync(projectConfigPath, "utf-8");
    // Simple YAML parsing for exclude_dirs list
    const filterMatch = yaml.match(/filter:\s*\n\s*exclude_dirs:\s*\n((?:\s*-\s*.+\n?)*)/);
    if (filterMatch) {
      excludeDirs = filterMatch[1]
        .split("\n")
        .map((line) => line.replace(/^\s*-\s*/, "").trim().replace(/["']/g, ""))
        .filter(Boolean);
    }

    // Parse repos.entry_points list
    const entryMatch = yaml.match(/repos:\s*\n\s*entry_points:\s*\n((?:\s*-\s*.+\n?)*)/);
    if (entryMatch) {
      entryPointRepos = entryMatch[1]
        .split("\n")
        .map((line) => line.replace(/^\s*-\s*/, "").trim().replace(/["']/g, ""))
        .filter(Boolean);
    }
  } catch {
    // No project config or parse error — use defaults
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
  const repoManager = new RepoManager({
    workspaceDir: config.workspaceDir,
    scratchDir: config.scratchDir,
  });

  const change = task.changes[0]; // Phase 1a: single change
  if (!change) return null;

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
    stepName: "AI 分析中",
    reposScanned: finalTargetRepos.size,
    reposTotal: targetRepos.length,
  };

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
    cwd: config.workspaceDir, // RPC mode: pi needs access to all repos for tool calls
    timeoutMs: 900_000, // 15 min (pi needs time for multi-turn tool calls + final report)
    thinkingLevel: "medium",
    skillPath: config.skillPath,
  };

  const piResult = await runPiWorker(prompt, piConfig);

  if (!piResult.success) {
    task.error = `pi agent 分析失败: ${piResult.error}`;
    // Still try to extract partial result below
  }

  // ─── Step 5: Parse result ─────────────────────────────────────────────────────
  task.progress = { step: 5, stepName: "解析结果", reposScanned: coarseHits.size, reposTotal: targetRepos.length };

  const jsonResult = extractJsonFromOutput(piResult.output);

  if (jsonResult) {
    // Add metadata about the analysis run
    (jsonResult as Record<string, unknown>)._meta = {
      durationMs: piResult.durationMs,
      turns: piResult.turnCount,
      toolCalls: piResult.toolCallCount,
      timedOut: !piResult.success && piResult.error?.includes("timeout"),
    };
    return jsonResult as unknown as AnalysisResult;
  }

  // No structured JSON found — return raw output as partial result
  // This happens when pi timed out before producing the final ```json block
  const isTimeout = !piResult.success || (piResult.durationMs ?? 0) >= (piConfig.timeoutMs ?? 900_000) - 5000;
  console.log(`[pipeline:${task.taskId}] Step 5: No JSON block found in output (${piResult.output.length} chars, timeout=${isTimeout}). Returning raw partial result.`);
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
    _rawOutput: piResult.output, // Include raw for debugging
  } as unknown as AnalysisResult;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

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

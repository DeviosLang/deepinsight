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
}

/**
 * Load pipeline config from environment variables and project config.
 */
export function loadPipelineConfig(): PipelineConfig {
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

  const diff = getDiff(repoManager, change);
  if (!diff) {
    task.error = `无法获取 ${change.repo} 的 diff`;
    return null;
  }
  console.log(`[pipeline:${task.taskId}] Step 1 done: diff size = ${diff.length} chars`);

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

  // Coarse filter: git grep on NFS
  console.log(`[pipeline:${task.taskId}] Step 3: Running coarse filter on ${targetRepos.length} repos...`);
  const coarseHits = coarseFilter(symbols, targetRepos, repoManager);
  console.log(`[pipeline:${task.taskId}] Step 3 done: ${coarseHits.size} repos hit: ${[...coarseHits].join(', ')}`);

  task.progress = {
    step: 3,
    stepName: "预筛完成",
    reposScanned: targetRepos.length,
    reposTotal: allRepos.length,
  };

  // ─── Step 4: Spawn pi worker ──────────────────────────────────────────────────
  task.progress = {
    step: 4,
    stepName: "AI 分析中",
    reposScanned: coarseHits.size,
    reposTotal: targetRepos.length,
  };

  const prompt = buildAnalysisPrompt({
    diff,
    repoName: change.repo,
    reposRoot: config.workspaceDir,
    targetRepos: [...coarseHits],
  });
  console.log(`[pipeline:${task.taskId}] Step 4: Spawning pi worker, prompt size = ${prompt.length} chars, target repos = ${[...coarseHits].join(', ') || '(none, will scan all)'}`);

  const piConfig: PiWorkerConfig = {
    provider: "tokenhub",
    model: config.llm.model,
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl,
    cwd: config.scratchDir, // Use local fast storage, NOT NFS — pi scans cwd on startup
    timeoutMs: 1_200_000,
    thinkingLevel: "medium",
    skillPath: config.skillPath,
  };

  const piResult = await runPiWorker(prompt, piConfig);

  if (!piResult.success) {
    task.error = `pi agent 分析失败: ${piResult.error}`;
    // Still try to extract partial result
  }

  // ─── Step 5: Parse result ─────────────────────────────────────────────────────
  task.progress = { step: 5, stepName: "解析结果", reposScanned: coarseHits.size, reposTotal: targetRepos.length };

  const jsonResult = extractJsonFromOutput(piResult.output);

  if (jsonResult) {
    return jsonResult as unknown as AnalysisResult;
  }

  // If no structured JSON, return raw output as a basic result
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

function getDiff(repoManager: RepoManager, change: ChangeSpec): string | null {
  if (!repoManager.repoExists(change.repo)) return null;

  const base = change.base ?? "HEAD~1";
  const head = change.commit ?? "HEAD";
  const diff = repoManager.getDiff(change.repo, base, head);

  return diff || null;
}

/**
 * Simple heuristic: extract function/class names from diff hunks.
 * Looks for Python def/class declarations in changed lines.
 */
function extractSymbolsFromDiff(diff: string): Symbol[] {
  const symbols: Symbol[] = [];
  const seen = new Set<string>();

  const lines = diff.split("\n");
  for (const line of lines) {
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

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
import { coarseFilter, fineFilter } from "../pre-filter/index.js";
import { runPiWorker, runPiWorkerWithRetry, buildAnalysisPrompt, extractJsonFromOutput } from "./piWorker.js";
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
    fallbackModel?: string;
  };
  /** Repos to analyze against (if empty, scans all available) */
  targetRepos?: string[];
  /** Directory patterns to exclude from diff (e.g., test directories) */
  excludeDirs?: string[];
  /** Entry point repos — always included in analysis regardless of grep hits */
  entryPointRepos?: string[];
  /** Sink repos — terminal/lowest-layer modules (DAO/DB/storage); downstream-chain convergence anchors */
  sinkRepos?: string[];
}

/**
 * Load pipeline config from environment variables and project config.
 */
export function loadPipelineConfig(): PipelineConfig {
  const projectConfigPath = process.env.PROJECT_CONFIG_PATH ?? "/etc/deepinsight/project.yml";
  let excludeDirs: string[] = [];
  let entryPointRepos: string[] = [];
  let sinkRepos: string[] = [];

  try {
    const rawYaml = fs.readFileSync(projectConfigPath, "utf-8");
    const config = YAML.parse(rawYaml) as Record<string, unknown>;

    // Parse filter.exclude_dirs
    const filter = config.filter as Record<string, unknown> | undefined;
    if (filter && Array.isArray(filter.exclude_dirs)) {
      excludeDirs = filter.exclude_dirs.map(String);
    }

    // Parse entry-point / sink repos. Two supported shapes:
    //  (A) `repos` is a LIST of repo objects, each with a `role` field
    //      (role: entry_point / sink). This is the human-friendly,
    //      single-source-of-truth form — a repo's role lives on the repo.
    //  (B) legacy: `repos` is a MAP with flat `entry_points` / `sinks` arrays.
    // Both are accepted and merged (deduped) for backward compatibility.
    const entrySet = new Set<string>();
    const sinkSet = new Set<string>();
    const rawRepos = config.repos;

    if (Array.isArray(rawRepos)) {
      // Shape (A): list of repo objects with `role`.
      for (const item of rawRepos) {
        if (typeof item !== "object" || item === null) continue;
        const r = item as Record<string, unknown>;
        if (typeof r.name !== "string") continue;
        if (r.role === "entry_point") entrySet.add(r.name);
        else if (r.role === "sink") sinkSet.add(r.name);
      }
    } else if (typeof rawRepos === "object" && rawRepos !== null) {
      // Shape (B): map with flat arrays.
      const repos = rawRepos as Record<string, unknown>;
      if (Array.isArray(repos.entry_points)) {
        for (const x of repos.entry_points) entrySet.add(String(x));
      }
      if (Array.isArray(repos.sinks)) {
        for (const x of repos.sinks) sinkSet.add(String(x));
      }
    }

    entryPointRepos = [...entrySet];
    sinkRepos = [...sinkSet];
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
    excludeDirs = ["**/tests/", "**/test/", "tests/", "test/"];
  }
  // Always exclude test files by name pattern (regardless of directory)
  const testFileExcludes = ["*_test.py", "*_test.go", "test_*.py", "run_test*", "conftest*.py", "**/conftest.py", "requirements_test*"];
  excludeDirs = [...excludeDirs, ...testFileExcludes];

  return {
    workspaceDir: process.env.WORKSPACE_DIR ?? "/data/workspace",
    scratchDir: process.env.SCRATCH_DIR ?? "/data/scratch",
    skillPath: path.resolve("/app/packages/pi-skill/SKILL.md"),
    llm: {
      provider: "openai",
      model: process.env.LLM_MODEL ?? "deepseek-v4-pro",
      apiKey: process.env.LLM_ANALYSIS_API_KEY ?? "",
      baseUrl: process.env.LLM_BASE_URL ?? "",
      fallbackModel: process.env.LLM_FALLBACK_MODEL ?? undefined,
    },
    excludeDirs,
    entryPointRepos,
    sinkRepos,
  };
}

/**
 * Execute the full analysis pipeline for a task.
 * Supports multiple changes (repos/branches) — each analyzed independently, results merged.
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

  if (!task.changes || task.changes.length === 0) return null;

  // Check degradation mode
  if (isInDegradedMode()) {
    console.log(`[pipeline:${task.taskId}] ⚠️ Degraded mode active — skipping LLM, returning grep-only result`);
  }

  // Single change — run directly
  if (task.changes.length === 1) {
    const result = await runSingleChange(task, task.changes[0], config, repoManager, traceCtx);
    flushTrace(traceCtx, task, undefined).catch(() => {});
    return result;
  }

  // Multiple changes — Joint Analysis (联合分析)
  // All diffs seen together by pi agent so it can reason about cross-repo interactions.
  // Falls back to independent mode if combined symbols > 30.
  console.log(`[pipeline:${task.taskId}] Multi-change joint mode: ${task.changes.length} repos`);

  // Step 0: Resolve all branches in parallel
  const resolvedChanges: Array<{ change: ChangeSpec; diff: string; symbols: Symbol[] }> = [];

  for (const change of task.changes) {
    // Resolve branch
    if (change.branch && !change.commit) {
      console.log(`[pipeline:${task.taskId}] Step 0: Resolving branch ${change.branch} for ${change.repo}`);
      const fetched = repoManager.fetchBranch(change.repo, change.branch);
      if (fetched) {
        const commitHash = repoManager.resolveRef(change.repo, "FETCH_HEAD");
        if (commitHash) {
          change.commit = commitHash;
          if (!change.base) {
            change.base = resolveBaseRef(repoManager, change.repo, change.branch ?? "", commitHash, task.taskId);
          }
        }
      } else {
        console.warn(`[pipeline:${task.taskId}] Failed to fetch ${change.branch} for ${change.repo}, skipping`);
        continue;
      }
    }

    // Get diff
    const diff = getDiff(repoManager, change, config.excludeDirs);
    if (!diff) {
      console.warn(`[pipeline:${task.taskId}] No diff for ${change.repo}, skipping`);
      continue;
    }

    // Extract symbols
    const symbols = extractSymbolsFromDiff(diff);
    console.log(`[pipeline:${task.taskId}] ${change.repo}: diff ${diff.length} chars, ${symbols.length} symbols: ${symbols.map(s => s.name).join(', ')}`);
    resolvedChanges.push({ change, diff, symbols });
  }

  if (resolvedChanges.length === 0) {
    task.error = "所有仓库的 diff 均为空";
    return null;
  }

  // Combine all symbols
  const allSymbols = resolvedChanges.flatMap((rc) => rc.symbols);
  const combinedDiff = resolvedChanges
    .map((rc) => `=== ${rc.change.repo} (${rc.change.branch ?? rc.change.commit ?? ''}) ===\n${rc.diff}`)
    .join("\n\n");

  console.log(`[pipeline:${task.taskId}] Combined: ${resolvedChanges.length} repos, ${allSymbols.length} symbols, ${combinedDiff.length} chars diff`);

  // Guard: if too many symbols, fall back to independent mode
  if (allSymbols.length > 30) {
    console.log(`[pipeline:${task.taskId}] Too many symbols (${allSymbols.length} > 30), falling back to independent mode`);
    const results: Array<AnalysisResult | null> = [];
    for (const rc of resolvedChanges) {
      const result = await runSingleChange(task, rc.change, config, repoManager, traceCtx);
      results.push(result);
    }
    const validResults = results.filter((r): r is AnalysisResult => r !== null);
    if (validResults.length === 0) return null;
    const merged = validResults.length === 1 ? validResults[0] : mergeMultiChangeResults(validResults);
    flushTrace(traceCtx, task, undefined).catch(() => {});
    return merged;
  }

  // Run unified pipeline with combined diff
  task.progress = { step: 3, stepName: "联合预筛", reposScanned: 0, reposTotal: 0 };

  const step3Start = Date.now();
  const allRepos = config.targetRepos ?? repoManager.listRepos();
  const changedRepos = new Set(resolvedChanges.map((rc) => rc.change.repo));
  const targetRepos = allRepos.filter((r) => !changedRepos.has(r));

  // Coarse filter with combined symbols
  console.log(`[pipeline:${task.taskId}] Step 3: Joint coarse filter, ${allSymbols.length} symbols across ${targetRepos.length} repos...`);
  const coarseHits = await coarseFilter(allSymbols, targetRepos, repoManager);
  console.log(`[pipeline:${task.taskId}] Step 3 coarse done: ${coarseHits.size} repos hit`);

  // Fine filter
  let refinedHits: Set<string>;
  if (coarseHits.size > 3) {
    console.log(`[pipeline:${task.taskId}] Step 3: Joint fine filter (ast-grep) on ${coarseHits.size} repos...`);
    try {
      refinedHits = await fineFilter(allSymbols, coarseHits, task.taskId, repoManager);
      console.log(`[pipeline:${task.taskId}] Step 3 fine done: ${refinedHits.size}/${coarseHits.size} confirmed`);
    } catch {
      refinedHits = coarseHits;
    }
  } else {
    refinedHits = coarseHits;
  }

  // Add entry points
  const entryPoints = (config.entryPointRepos ?? []).filter(
    (r) => !changedRepos.has(r) && repoManager.repoExists(r),
  );
  // Add sink repos (downstream-chain convergence anchors)
  const sinkRepos = (config.sinkRepos ?? []).filter(
    (r) => !changedRepos.has(r) && repoManager.repoExists(r),
  );
  const finalTargetRepos = new Set([...refinedHits, ...entryPoints, ...sinkRepos]);

  recordSpan(traceCtx, "step3_prefilter", step3Start, {
    reposScanned: targetRepos.length,
    reposHitCoarse: coarseHits.size,
    reposHitFine: refinedHits.size,
    entryPointsAdded: entryPoints.length,
    sinksAdded: sinkRepos.length,
    jointMode: true,
  });

  // Load AGENTS.md
  const agentsMdDir = path.join(config.workspaceDir, ".deepinsight", "agents-md");
  let agentsMd: string | undefined;
  let globalPatterns: string | undefined;
  if (fs.existsSync(agentsMdDir)) {
    const MAX_AGENTS_MD_CHARS = 40_000;
    const agentsMdParts: string[] = [];
    let totalChars = 0;
    const reposToLoad = [...changedRepos, ...entryPoints, ...sinkRepos, ...[...refinedHits].filter((r) => !changedRepos.has(r) && !entryPoints.includes(r) && !sinkRepos.includes(r))];
    for (const repo of reposToLoad) {
      if (totalChars >= MAX_AGENTS_MD_CHARS) break;
      const mdPath = path.join(agentsMdDir, `${repo}.md`);
      try {
        if (fs.existsSync(mdPath)) {
          const content = fs.readFileSync(mdPath, "utf-8");
          if (totalChars + content.length <= MAX_AGENTS_MD_CHARS) {
            agentsMdParts.push(content);
            totalChars += content.length;
          }
        }
      } catch { /* skip */ }
    }
    if (agentsMdParts.length > 0) agentsMd = agentsMdParts.join("\n---\n");
    const gpPath = path.join(agentsMdDir, "GLOBAL_PATTERNS.md");
    try { if (fs.existsSync(gpPath)) globalPatterns = fs.readFileSync(gpPath, "utf-8"); } catch { /* skip */ }
  }

  // Step 4: Spawn pi worker(s) with combined diff
  task.progress = { step: 4, stepName: "联合 AI 分析中", reposScanned: finalTargetRepos.size, reposTotal: targetRepos.length };

  if (isInDegradedMode()) {
    flushTrace(traceCtx, task, undefined).catch(() => {});
    return null;
  }

  const piConfig: PiWorkerConfig & { fallbackModel?: string } = {
    provider: "tokenhub",
    model: config.llm.model,
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl,
    cwd: config.workspaceDir,
    timeoutMs: 900_000,
    thinkingLevel: "medium",
    skillPath: config.skillPath,
    fallbackModel: config.llm.fallbackModel,
  };

  const commonPromptParams = {
    repoName: resolvedChanges.map((rc) => rc.change.repo).join(" + "),
    reposRoot: config.workspaceDir,
    targetRepos: [...finalTargetRepos],
    entryPointRepos: entryPoints,
    sinkRepos,
    agentsMd,
    globalPatterns,
  };

  const step4Start = Date.now();
  // Limit parallel workers to avoid OOM: 4 for normal, 2 for large symbol sets
  const MAX_PARALLEL_WORKERS = allSymbols.length > 30 ? 2 : 4;
  let piResult: Awaited<ReturnType<typeof runPiWorkerWithRetry>>;

  if (allSymbols.length >= 3) {
    const groups = splitSymbolsIntoGroups(allSymbols, MAX_PARALLEL_WORKERS);
    console.log(`[pipeline:${task.taskId}] Step 4: Joint parallel — ${allSymbols.length} symbols → ${groups.length} workers (all see full diff)`);
    const workerPromises = groups.map((group, i) => {
      // Each worker sees ALL diffs (for cross-repo reasoning) but focuses on its symbol subset
      const prompt = buildAnalysisPrompt({ ...commonPromptParams, diff: combinedDiff });
      console.log(`[pipeline:${task.taskId}] Step 4: Worker ${i + 1}/${groups.length} — symbols: ${group.map(s => s.name).join(', ')}`);
      return runPiWorkerWithRetry(prompt, piConfig);
    });
    const results = await Promise.allSettled(workerPromises);
    piResult = mergeParallelPiResults(results);
  } else {
    const prompt = buildAnalysisPrompt({ ...commonPromptParams, diff: combinedDiff });
    console.log(`[pipeline:${task.taskId}] Step 4: Joint single worker — ${allSymbols.length} symbols, prompt ${prompt.length} chars`);
    piResult = await runPiWorkerWithRetry(prompt, piConfig);
  }

  if (piResult.success) { recordLlmSuccess(); } else { recordLlmFailure(); }

  const cost = calculateCost(piResult);
  recordSpan(traceCtx, "step4_piWorker", step4Start, {
    success: piResult.success,
    durationMs: piResult.durationMs,
    jointMode: true,
    changesCount: resolvedChanges.length,
    ...cost,
  });
  console.log(`[pipeline:${task.taskId}] Step 4 done: $${cost.totalCostUsd.toFixed(4)}`);

  // Step 5: Parse result
  const piOutput = piResult.output ?? "";
  const jsonResult = extractJsonFromOutput(piOutput);
  if (jsonResult && isValidAnalysisResult(jsonResult)) {
    (jsonResult as Record<string, unknown>)._meta = {
      durationMs: piResult.durationMs,
      jointMode: true,
      changes: resolvedChanges.map((rc) => rc.change.repo),
    };
    flushTrace(traceCtx, task, undefined).catch(() => {});
    return jsonResult as unknown as AnalysisResult;
  }

  // Fallback
  flushTrace(traceCtx, task, undefined).catch(() => {});
  return {
    summary: {
      totalSymbolsChanged: allSymbols.length,
      affectedRepos: refinedHits.size,
      unaffectedRepos: targetRepos.length - refinedHits.size,
      riskBreakdown: { P0: 0, P1: 0, P2: 0, P3: 0, NEEDS_HUMAN_REVIEW: 0 },
    },
    symbols: allSymbols.map((s) => ({
      name: s.name, location: "", diffSemantic: "见原始输出", initialRisk: "medium" as const, callTree: [], riskTable: [],
    })),
    untrackable: [],
    globalPatternsMatched: [],
    _rawOutput: truncateRawOutput(piOutput),
  } as unknown as AnalysisResult;
}

/**
 * Analyze a single change (one repo/branch). Extracted to support multi-change mode.
 */
async function runSingleChange(
  task: AnalysisTask,
  change: ChangeSpec,
  config: PipelineConfig,
  repoManager: RepoManager,
  traceCtx: ReturnType<typeof startTrace>,
): Promise<AnalysisResult | null> {
  // ─── Step 0: Resolve branch reference ───────────────────────────────────────
  if (change.branch && !change.commit) {
    console.log(`[pipeline:${task.taskId}] Step 0: Resolving branch ${change.branch} for ${change.repo}`);
    const fetched = repoManager.fetchBranch(change.repo, change.branch);
    if (fetched) {
      const commitHash = repoManager.resolveRef(change.repo, "FETCH_HEAD");
      if (commitHash) {
        change.commit = commitHash;
        console.log(`[pipeline:${task.taskId}] Step 0: Branch resolved to commit ${commitHash.slice(0, 10)}`);

        // If no base specified, compute merge-base with master/main
        if (!change.base) {
          change.base = resolveBaseRef(repoManager, change.repo, change.branch ?? "", commitHash, task.taskId);
        }
      } else {
        console.warn(`[pipeline:${task.taskId}] Step 0: Failed to resolve FETCH_HEAD after fetch`);
      }
    } else {
      task.error = `无法 fetch 分支 ${change.branch}（仓库: ${change.repo}）`;
      return null;
    }
  }

  // ─── Step 1: Get diff ────────────────────────────────────────────────────────
  task.progress = { step: 1, stepName: "获取 diff", reposScanned: 0, reposTotal: 0 };
  console.log(`[pipeline:${task.taskId}] Step 1: Getting diff for ${change.repo} (${change.base} → ${change.commit ?? 'HEAD'})`);

  const step1Start = Date.now();
  const diff = getDiff(repoManager, change, config.excludeDirs);
  if (!diff) {
    task.error = `无法获取 ${change.repo} 的 diff`;
    return null;
  }
  recordSpan(traceCtx, "step1_getDiff", step1Start, {
    repo: change.repo,
    base: change.base,
    commit: change.commit,
    diffChars: diff.length,
    excludeDirs: config.excludeDirs,
  });
  console.log(`[pipeline:${task.taskId}] Step 1 done: diff size = ${diff.length} chars (excludeDirs: ${config.excludeDirs?.join(', ') ?? 'none'})`);

  // ─── Step 2: Extract symbols (simple heuristic for Phase 1a) ──────────────────
  task.progress = { step: 2, stepName: "提取变更符号", reposScanned: 0, reposTotal: 0 };

  const step2Start = Date.now();
  const symbols = extractSymbolsFromDiff(diff);
  if (symbols.length === 0) {
    task.error = "diff 中未发现可分析的符号变更";
    return null;
  }
  recordSpan(traceCtx, "step2_extractSymbols", step2Start, {
    symbolCount: symbols.length,
    symbols: symbols.map((s) => s.name),
  });
  console.log(`[pipeline:${task.taskId}] Step 2 done: ${symbols.length} symbols: ${symbols.map(s => s.name).join(', ')}`);

  // ─── Step 3: Pre-filter (coarse + fine) ────────────────────────────────────
  task.progress = { step: 3, stepName: "预筛目标仓库", reposScanned: 0, reposTotal: 0 };

  const step3Start = Date.now();
  const allRepos = config.targetRepos ?? repoManager.listRepos();
  const targetRepos = allRepos.filter((r) => r !== change.repo); // exclude self

  // Phase 1: Coarse filter — parallel git grep on NFS
  console.log(`[pipeline:${task.taskId}] Step 3: Running coarse filter on ${targetRepos.length} repos (parallel)...`);
  const coarseHits = await coarseFilter(symbols, targetRepos, repoManager);
  console.log(`[pipeline:${task.taskId}] Step 3 coarse done: ${coarseHits.size} repos hit: ${[...coarseHits].join(', ')}`);

  // Phase 2: Fine filter — ast-grep on worktrees (only if conditions met)
  // Skip fine filter if: coarse hits ≤ 3 (not worth it) OR symbols > 20 (too many → OOM risk)
  let refinedHits: Set<string>;
  if (coarseHits.size > 3 && symbols.length <= 20) {
    task.progress = { step: 3, stepName: "ast-grep 精筛", reposScanned: coarseHits.size, reposTotal: targetRepos.length };
    console.log(`[pipeline:${task.taskId}] Step 3: Running fine filter (ast-grep) on ${coarseHits.size} repos...`);
    try {
      refinedHits = await fineFilter(symbols, coarseHits, task.taskId, repoManager);
      console.log(`[pipeline:${task.taskId}] Step 3 fine done: ${refinedHits.size}/${coarseHits.size} repos confirmed: ${[...refinedHits].join(', ')}`);
    } catch (err) {
      // Fine filter failure is non-fatal — fall back to coarse results
      console.warn(`[pipeline:${task.taskId}] Step 3 fine filter failed, using coarse results: ${err instanceof Error ? err.message : String(err)}`);
      refinedHits = coarseHits;
    }
  } else {
    // Few hits — skip fine filter (not worth the worktree overhead)
    refinedHits = coarseHits;
    console.log(`[pipeline:${task.taskId}] Step 3: Skipping fine filter (coarseHits=${coarseHits.size}, symbols=${symbols.length}, threshold: hits>3 && symbols≤20)`);
  }

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
  // Sink repos — downstream-chain convergence anchors
  const sinkRepos = (config.sinkRepos ?? []).filter(
    (r) => r !== change.repo && repoManager.repoExists(r),
  );
  const finalTargetRepos = new Set([...refinedHits, ...entryPoints, ...sinkRepos]);
  if (entryPoints.length > 0 || sinkRepos.length > 0) {
    console.log(`[pipeline:${task.taskId}] Step 3.5: Added entry points: ${entryPoints.join(', ') || '-'}, sinks: ${sinkRepos.join(', ') || '-'} → total ${finalTargetRepos.size} repos`);
  }

  // ─── Step 3.6: Load AGENTS.md context ──────────────────────────────────────
  const agentsMdDir = path.join(config.workspaceDir, ".deepinsight", "agents-md");
  let agentsMd: string | undefined;
  let globalPatterns: string | undefined;

  if (fs.existsSync(agentsMdDir)) {
    const MAX_AGENTS_MD_CHARS = 40_000; // ~10K tokens budget
    const agentsMdParts: string[] = [];
    let totalChars = 0;

    // Priority order: changed repo → entry points → sinks → hit repos
    const reposToLoad = [
      change.repo,
      ...entryPoints,
      ...sinkRepos,
      ...[...refinedHits].filter((r) => r !== change.repo && !entryPoints.includes(r) && !sinkRepos.includes(r)),
    ];

    for (const repo of reposToLoad) {
      if (totalChars >= MAX_AGENTS_MD_CHARS) break;
      const mdPath = path.join(agentsMdDir, `${repo}.md`);
      try {
        if (fs.existsSync(mdPath)) {
          const content = fs.readFileSync(mdPath, "utf-8");
          if (totalChars + content.length <= MAX_AGENTS_MD_CHARS) {
            agentsMdParts.push(content);
            totalChars += content.length;
          }
        }
      } catch { /* skip unreadable */ }
    }

    if (agentsMdParts.length > 0) {
      agentsMd = agentsMdParts.join("\n---\n");
      console.log(`[pipeline:${task.taskId}] Step 3.6: Loaded AGENTS.md for ${agentsMdParts.length} repos (${totalChars} chars)`);
    }

    // Load GLOBAL_PATTERNS if available
    const gpPath = path.join(agentsMdDir, "GLOBAL_PATTERNS.md");
    try {
      if (fs.existsSync(gpPath)) {
        globalPatterns = fs.readFileSync(gpPath, "utf-8");
        console.log(`[pipeline:${task.taskId}] Step 3.6: Loaded GLOBAL_PATTERNS.md (${globalPatterns.length} chars)`);
      }
    } catch { /* skip */ }
  }

  // ─── Step 4: Spawn pi worker(s) ────────────────────────────────────────────
  task.progress = {
    step: 4,
    stepName: isInDegradedMode() ? "降级模式(跳过LLM)" : "AI 分析中",
    reposScanned: finalTargetRepos.size,
    reposTotal: targetRepos.length,
  };

  recordSpan(traceCtx, "step3_prefilter", step3Start, {
    reposScanned: targetRepos.length,
    reposHitCoarse: coarseHits.size,
    reposHitFine: refinedHits.size,
    entryPointsAdded: entryPoints.length,
  });

  let piResult: Awaited<ReturnType<typeof runPiWorker>> | null = null;

  if (!isInDegradedMode()) {
    const piConfig: PiWorkerConfig & { fallbackModel?: string } = {
      provider: "tokenhub",
      model: config.llm.model,
      apiKey: config.llm.apiKey,
      baseUrl: config.llm.baseUrl,
      cwd: config.workspaceDir,
      timeoutMs: 900_000,
      thinkingLevel: "medium",
      skillPath: config.skillPath,
      fallbackModel: config.llm.fallbackModel,
    };

    const commonPromptParams = {
      repoName: change.repo,
      reposRoot: config.workspaceDir,
      targetRepos: [...finalTargetRepos],
      entryPointRepos: entryPoints,
      sinkRepos,
      agentsMd,
      globalPatterns,
    };

    const step4Start = Date.now();
    // Limit parallel workers to avoid OOM: 4 for normal, 2 for large symbol sets
    const MAX_PARALLEL_WORKERS = symbols.length > 30 ? 2 : 4;

    if (symbols.length >= 3) {
      // ─── Parallel mode: split symbols into groups, run workers concurrently ──
      const groups = splitSymbolsIntoGroups(symbols, MAX_PARALLEL_WORKERS);
      console.log(`[pipeline:${task.taskId}] Step 4: Parallel mode — ${symbols.length} symbols → ${groups.length} workers`);

      const workerPromises = groups.map((group, i) => {
        const groupDiff = filterDiffForSymbols(diff, group);
        const prompt = buildAnalysisPrompt({
          ...commonPromptParams,
          diff: groupDiff || diff, // fallback to full diff if filter fails
        });
        console.log(`[pipeline:${task.taskId}] Step 4: Worker ${i + 1}/${groups.length} — symbols: ${group.map((s) => s.name).join(", ")} (prompt: ${prompt.length} chars)`);
        return runPiWorkerWithRetry(prompt, piConfig);
      });

      const results = await Promise.allSettled(workerPromises);
      piResult = mergeParallelPiResults(results);

      if (piResult.success) {
        recordLlmSuccess();
      } else {
        recordLlmFailure();
        task.error = `pi agent 并行分析部分失败: ${piResult.error}`;
      }
    } else {
      // ─── Single worker mode (≤ 2 symbols) ─────────────────────────────────
      const prompt = buildAnalysisPrompt({ ...commonPromptParams, diff });
      console.log(`[pipeline:${task.taskId}] Step 4: Single worker — ${symbols.length} symbols (prompt: ${prompt.length} chars)`);
      piResult = await runPiWorkerWithRetry(prompt, piConfig);

      if (piResult.success) {
        recordLlmSuccess();
      } else {
        recordLlmFailure();
        task.error = `pi agent 分析失败: ${piResult.error}`;
      }
    }

    const cost = calculateCost(piResult);
    recordSpan(traceCtx, "step4_piWorker", step4Start, {
      success: piResult.success,
      durationMs: piResult.durationMs,
      outputChars: piResult.output.length,
      toolCalls: piResult.toolCallCount,
      turns: piResult.turnCount,
      parallel: symbols.length >= 3,
      workerCount: symbols.length >= 3 ? Math.min(Math.ceil(symbols.length / 2), MAX_PARALLEL_WORKERS) : 1,
      ...cost,
    });
    console.log(`[pipeline:${task.taskId}] Step 4 cost: $${cost.totalCostUsd.toFixed(4)} (input: ${cost.inputTokens}, output: ${cost.outputTokens})`);
  } else {
    // Degraded mode: skip pi, return grep-only result
    console.log(`[pipeline:${task.taskId}] Step 4: SKIPPED (degraded mode)`);
    recordSpan(traceCtx, "step4_degraded", Date.now());
  }

  // ─── Step 5: Parse result ─────────────────────────────────────────────────────
  task.progress = { step: 5, stepName: "解析结果", reposScanned: refinedHits.size, reposTotal: targetRepos.length };

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
      changeRepo: change.repo,
    };
    return jsonResult as unknown as AnalysisResult;
  }

  if (jsonResult) {
    console.warn(
      `[pipeline:${task.taskId}] Step 5: Extracted JSON failed schema validation; falling back to raw partial result. Reason: ${describeValidationFailure(jsonResult)}`,
    );
  }

  // No structured JSON found — return raw output as partial result
  const isTimeout = piResult ? (!piResult.success || (piResult.durationMs ?? 0) >= 895_000) : false;
  console.log(`[pipeline:${task.taskId}] Step 5: No JSON block found in output (${piOutput.length} chars, timeout=${isTimeout}). Returning raw partial result.`);

  return {
    summary: {
      totalSymbolsChanged: symbols.length,
      affectedRepos: refinedHits.size,
      unaffectedRepos: targetRepos.length - refinedHits.size,
      riskBreakdown: { P0: 0, P1: 0, P2: 0, P3: 0, NEEDS_HUMAN_REVIEW: 0 },
    },
    symbols: symbols.map((s) => ({
      name: s.name,
      location: `${change.repo}`,
      diffSemantic: "见原始输出",
      initialRisk: "medium" as const,
      callTree: [],
      riskTable: [],
      downstreamContracts: [],
    })),
    untrackable: [],
    globalPatternsMatched: [],
    _rawOutput: truncateRawOutput(piOutput),
  } as unknown as AnalysisResult;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Merge results from multiple changes (repos) into a single report.
 */
function mergeMultiChangeResults(results: AnalysisResult[]): AnalysisResult {
  const allSymbols: unknown[] = [];
  const allScenarios: unknown[] = [];
  const allUntrackable: unknown[] = [];
  let totalP0 = 0, totalP1 = 0, totalP2 = 0, totalP3 = 0, totalHuman = 0;
  const affectedRepoSet = new Set<string>();

  for (const r of results) {
    const result = r as unknown as Record<string, unknown>;
    const summary = result.summary as Record<string, unknown> | undefined;

    if (summary) {
      const rb = summary.riskBreakdown as Record<string, number> | undefined;
      if (rb) {
        totalP0 += rb.P0 ?? 0;
        totalP1 += rb.P1 ?? 0;
        totalP2 += rb.P2 ?? 0;
        totalP3 += rb.P3 ?? 0;
        totalHuman += rb.NEEDS_HUMAN_REVIEW ?? 0;
      }
      if (typeof summary.affectedRepos === "number") {
        // Can't sum — we'll recalculate from symbols
      }
    }

    if (Array.isArray(result.symbols)) {
      for (const sym of result.symbols as Array<Record<string, unknown>>) {
        allSymbols.push(sym);
        if (Array.isArray(sym.callTree)) {
          for (const node of sym.callTree as Array<Record<string, unknown>>) {
            if (node.repo && typeof node.repo === "string") affectedRepoSet.add(node.repo);
          }
        }
        // Downstream / sink repos also count as affected
        const downstream = sanitizeDownstreamContracts(sym.downstreamContracts, `symbol=${String(sym.name ?? "")}`);
        for (const c of downstream) {
          if (typeof c.repo === "string") affectedRepoSet.add(c.repo);
        }
      }
    }

    if (Array.isArray(result.test_scenarios)) allScenarios.push(...result.test_scenarios as unknown[]);
    if (Array.isArray(result.untrackable)) allUntrackable.push(...result.untrackable as unknown[]);
  }

  return {
    summary: {
      totalSymbolsChanged: allSymbols.length,
      affectedRepos: affectedRepoSet.size,
      unaffectedRepos: 0,
      riskBreakdown: { P0: totalP0, P1: totalP1, P2: totalP2, P3: totalP3, NEEDS_HUMAN_REVIEW: totalHuman },
    },
    symbols: allSymbols,
    test_scenarios: allScenarios,
    untrackable: [...new Set(allUntrackable.map(String))],
    globalPatternsMatched: [],
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
 * Sanitize the `downstreamContracts` field of a symbol coming from LLM JSON.
 *
 * EP-005 (cross-boundary data not validated): this field originates from an
 * untrusted model output. We never dereference it raw. Non-array input or
 * malformed elements are dropped with a warning rather than crashing the
 * merge or silently producing `undefined` downstream.
 *
 * @returns a clean array of contract-shaped records (may be empty)
 */
function sanitizeDownstreamContracts(raw: unknown, ctx: string): Array<Record<string, unknown>> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    console.warn(`[merge] downstreamContracts not an array (${ctx}) — dropping`);
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      console.warn(`[merge] downstreamContracts element not an object (${ctx}) — skipping`);
      continue;
    }
    const c = item as Record<string, unknown>;
    // Require the two fields merge logic dereferences: callee (dedup key) + repo (affectedRepos).
    if (typeof c.callee !== "string" || typeof c.repo !== "string") {
      console.warn(`[merge] downstreamContracts element missing callee/repo (${ctx}) — skipping`);
      continue;
    }
    out.push(c);
  }
  return out;
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

/**
 * Resolve the base ref for diff computation when user didn't specify one.
 * Strategy:
 *  1. merge-base(master, commit) if not equal to commit → use it
 *  2. merge-base(main, commit) similarly
 *  3. If branch matches "release/vX.Y.Z" pattern, find previous release branch
 *  4. Fall back to commit~1 (single-commit branch)
 */
function resolveBaseRef(
  repoManager: RepoManager,
  repo: string,
  branch: string,
  commitHash: string,
  taskId: string,
): string {
  // Try merge-base with master/main first
  for (const baseBranch of ["master", "main"]) {
    const mergeBase = repoManager.getMergeBase(repo, baseBranch, commitHash);
    if (mergeBase && mergeBase !== commitHash) {
      console.log(`[pipeline:${taskId}] Step 0: ${repo} merge-base with ${baseBranch} = ${mergeBase.slice(0, 10)}`);
      return mergeBase;
    }
  }

  // Branch already merged into master — look for previous release branch
  // Pattern: release/v26.05.20 → look for older release/v26.* branches
  const releaseMatch = branch.match(/^release\/v(\d+)\.(\d+)\.(\d+)$/);
  if (releaseMatch) {
    const branches = repoManager.listMatchingBranches(repo, "release/v*");
    // listMatchingBranches sorted descending — find first branch older than current
    const currentVer = `${releaseMatch[1]}.${releaseMatch[2]}.${releaseMatch[3]}`;
    for (const candidate of branches) {
      const candMatch = candidate.match(/^release\/v(\d+)\.(\d+)\.(\d+)$/);
      if (!candMatch) continue;
      const candVer = `${candMatch[1]}.${candMatch[2]}.${candMatch[3]}`;
      if (compareVersions(candVer, currentVer) < 0) {
        // Found older release branch
        const prevHash = repoManager.resolveRef(repo, `origin/${candidate}`);
        if (prevHash) {
          console.log(`[pipeline:${taskId}] Step 0: ${repo} branch tip == merge-base, using previous release ${candidate} (${prevHash.slice(0, 10)})`);
          return prevHash;
        }
      }
    }
  }

  // Fallback: parent commit
  const parent = repoManager.resolveRef(repo, `${commitHash}~1`);
  console.log(`[pipeline:${taskId}] Step 0: ${repo} fallback to parent ${(parent ?? commitHash).slice(0, 10)}~1`);
  return parent ?? `${commitHash}~1`;
}

/** Compare semver-like version strings (e.g., "26.05.20" vs "26.04.30") */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
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

  // Filter out test symbols and generic names that cause false positives
  const GENERIC_NAMES = new Set([
    "main", "__init__", "init", "start", "stop", "run", "setup", "teardown",
    "get", "set", "update", "delete", "create", "handle", "process",
    "default_logger", "logger", "config", "settings",
  ]);

  return symbols.filter((s) =>
    !s.name.startsWith("test_") &&
    !s.name.startsWith("Test") &&
    !GENERIC_NAMES.has(s.name)
  );
}

// ─── Parallel Worker Helpers ──────────────────────────────────────────────────

/**
 * Split symbols into groups for parallel workers.
 * Each group gets 1-2 symbols; total groups capped at maxGroups.
 */
function splitSymbolsIntoGroups(symbols: Symbol[], maxGroups: number): Symbol[][] {
  const groupCount = Math.min(Math.ceil(symbols.length / 2), maxGroups);
  const groups: Symbol[][] = Array.from({ length: groupCount }, () => []);

  for (let i = 0; i < symbols.length; i++) {
    groups[i % groupCount].push(symbols[i]);
  }

  return groups.filter((g) => g.length > 0);
}

/**
 * Filter diff to only include hunks relevant to specific symbols.
 * Returns the subset of diff containing hunks where the symbol appears
 * in the hunk header or changed lines. Falls back to full diff if no hunks match.
 */
function filterDiffForSymbols(diff: string, symbols: Symbol[]): string {
  const symbolNames = new Set(symbols.map((s) => s.name));
  const lines = diff.split("\n");
  const filteredLines: string[] = [];
  let inRelevantHunk = false;
  let currentFileHeader: string[] = [];

  for (const line of lines) {
    // File header lines (diff --git, ---, +++)
    if (line.startsWith("diff --git") || line.startsWith("---") || line.startsWith("+++") || line.startsWith("index ")) {
      currentFileHeader.push(line);
      inRelevantHunk = false;
      continue;
    }

    // Hunk header — check if symbol is in it
    if (line.startsWith("@@")) {
      inRelevantHunk = [...symbolNames].some((name) => line.includes(name));
      if (inRelevantHunk) {
        // Include file header before first relevant hunk
        if (currentFileHeader.length > 0) {
          filteredLines.push(...currentFileHeader);
          currentFileHeader = [];
        }
        filteredLines.push(line);
      }
      continue;
    }

    // Content lines — check if relevant hunk OR if line contains a symbol
    if (inRelevantHunk) {
      filteredLines.push(line);
    } else if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---")) {
      // Check if this changed line mentions any of our symbols
      if ([...symbolNames].some((name) => line.includes(name))) {
        if (currentFileHeader.length > 0) {
          filteredLines.push(...currentFileHeader);
          currentFileHeader = [];
        }
        filteredLines.push(line);
        inRelevantHunk = true; // Include following context
      }
    }
  }

  const result = filteredLines.join("\n");
  return result.length > 100 ? result : diff; // Fallback to full diff if filter too aggressive
}

/**
 * Merge results from multiple parallel pi workers into a single PiWorkerResult.
 * Combines JSON outputs, sums token usage, concatenates text.
 */
function mergeParallelPiResults(
  results: PromiseSettledResult<Awaited<ReturnType<typeof runPiWorker>>>[]
): Awaited<ReturnType<typeof runPiWorker>> {
  const successful = results
    .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof runPiWorker>>> => r.status === "fulfilled")
    .map((r) => r.value);

  if (successful.length === 0) {
    return {
      success: false,
      output: "",
      error: "所有并行 worker 均失败",
      durationMs: 0,
    };
  }

  // Merge JSON outputs from each worker
  const mergedJsonParts: Record<string, unknown>[] = [];
  for (const wr of successful) {
    const json = extractJsonFromOutput(wr.output);
    if (json) mergedJsonParts.push(json);
  }

  let mergedOutput: string;
  if (mergedJsonParts.length > 0) {
    const merged = mergeAnalysisJsons(mergedJsonParts);
    mergedOutput = "```json\n" + JSON.stringify(merged, null, 2) + "\n```";
  } else {
    // No structured JSON from any worker — concat raw outputs
    mergedOutput = successful.map((r) => r.output).join("\n---\n");
  }

  // Sum up usage
  const totalInput = successful.reduce((sum, r) => sum + (r.usage?.inputTokens ?? 0), 0);
  const totalOutput = successful.reduce((sum, r) => sum + (r.usage?.outputTokens ?? 0), 0);
  const totalToolCalls = successful.reduce((sum, r) => sum + (r.toolCallCount ?? 0), 0);
  const totalTurns = successful.reduce((sum, r) => sum + (r.turnCount ?? 0), 0);
  const maxDuration = Math.max(...successful.map((r) => r.durationMs));

  return {
    success: successful.some((r) => r.success),
    output: mergedOutput,
    durationMs: maxDuration,
    usage: { inputTokens: totalInput, outputTokens: totalOutput },
    toolCallCount: totalToolCalls,
    turnCount: totalTurns,
    error: successful.filter((r) => !r.success).map((r) => r.error).join("; ") || undefined,
  };
}

/**
 * Compute a stable dedup key for a symbol entry produced by an LLM worker.
 *
 * History: workers occasionally label the same function differently
 * (e.g. "check_rate_limit" vs "check_rate_limit (rate_limiter.py v2.0)"),
 * so keying solely on `name` left the merge step blind to duplicates that
 * pointed at the same source location. We now key primarily on the
 * location (file basename + line), with name as a fallback when the
 * location is missing or unparseable.
 *
 * Returns a tuple [primary, fallback] where `primary` is preferred for
 * matching and `fallback` provides backwards compatibility — so a worker
 * whose first emission carries a name-only entry can still be matched up
 * with a later location-bearing emission.
 */
function symbolDedupKey(sym: Record<string, unknown>): { primary: string; fallback: string } {
  const name = String(sym.name ?? "").trim();
  const location = String(sym.location ?? "").trim();

  // Try to extract `<basename>:<line>` from location.
  // Examples handled:
  //   "cvm_api/framework/rate_limiter.py:734" → "rate_limiter.py:734"
  //   "framework/rate_limiter.py:734"          → "rate_limiter.py:734"
  //   "business/ops/CreateRateLimitPolicy.py"  → "CreateRateLimitPolicy.py"  (no line)
  //   ""                                       → fall through to name
  const m = location.match(/([^/\\]+?)(?::(\d+))?$/);
  if (m) {
    const base = m[1];
    const line = m[2];
    if (base && line) return { primary: `${base}:${line}`, fallback: name };
    if (base && base.includes(".")) return { primary: base, fallback: name };
  }

  // No usable location — degrade to name (and strip trailing "(...)" annotations
  // so "check_rate_limit (v2)" and "check_rate_limit" still collide).
  const normalizedName = name.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return { primary: normalizedName, fallback: name };
}

/** Pick the more informative of two name strings (longer = more context). */
function pickBetterName(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a.length >= b.length ? a : b;
}

/**
 * Merge multiple analysis JSON outputs into one.
 *
 * Dedup strategy (post-2026-06): primary key is normalized location
 * (basename:line). Falls back to symbol name only when location is
 * missing/unparseable. This fixes the long-standing bug where parallel
 * workers labelling the same function differently produced duplicate
 * symbol entries.
 */
function mergeAnalysisJsons(jsons: Record<string, unknown>[]): Record<string, unknown> {
  const symbolMap = new Map<string, Record<string, unknown>>();
  const keyAliases = new Map<string, string>(); // fallback-key → primary-key
  const allScenarios: unknown[] = [];
  const allUntrackable: unknown[] = [];
  let totalP0 = 0, totalP1 = 0, totalP2 = 0, totalP3 = 0, totalHuman = 0;
  const affectedRepoSet = new Set<string>();

  for (const json of jsons) {
    // Collect and dedup symbols by (location, name)
    if (Array.isArray(json.symbols)) {
      for (const sym of json.symbols as Array<Record<string, unknown>>) {
        const { primary, fallback } = symbolDedupKey(sym);
        if (!primary && !fallback) continue;

        // Resolve to canonical key:
        //  1. If primary already in map → use it directly.
        //  2. Else if this entry has no usable location (primary derived from
        //     name), look up via fallback alias to catch "same fn, different
        //     name suffix" cases. We deliberately DO NOT consult the alias map
        //     when primary is a file:line — that would over-merge two distinct
        //     locations that happen to share a name (e.g. a wrapper +
        //     wrapped fn).
        //  3. Else this entry establishes a new primary; record fallback as
        //     alias only when primary itself was name-derived.
        const primaryIsLocationBased = /[:.]/.test(primary) && primary !== fallback;
        let key: string;
        if (symbolMap.has(primary)) {
          key = primary;
        } else if (!primaryIsLocationBased && fallback && keyAliases.has(fallback)) {
          key = keyAliases.get(fallback)!;
        } else {
          key = primary || fallback;
          // Record alias only for name-derived primaries — for location-based
          // keys, the location IS the canonical identifier.
          if (!primaryIsLocationBased && fallback && fallback !== key) {
            keyAliases.set(fallback, key);
          }
        }

        const callTree = Array.isArray(sym.callTree) ? sym.callTree : [];
        const riskTable = Array.isArray(sym.riskTable) ? sym.riskTable : [];
        // EP-005: downstreamContracts is untrusted LLM output — sanitize before use.
        const downstream = sanitizeDownstreamContracts(sym.downstreamContracts, `symbol=${key}`);
        sym.downstreamContracts = downstream;

        // Skip empty shells (no callTree, no riskTable, AND no downstream contracts)
        const isEmpty =
          callTree.length === 0 && riskTable.length === 0 && downstream.length === 0 && !sym.diffSemantic;

        if (symbolMap.has(key)) {
          // Merge: keep the version with more content
          const existing = symbolMap.get(key)!;
          const existingCT = Array.isArray(existing.callTree) ? existing.callTree as unknown[] : [];
          const existingRT = Array.isArray(existing.riskTable) ? existing.riskTable as unknown[] : [];
          const existingDC = Array.isArray(existing.downstreamContracts)
            ? existing.downstreamContracts as unknown[]
            : [];

          if (
            callTree.length > existingCT.length ||
            riskTable.length > existingRT.length ||
            downstream.length > existingDC.length
          ) {
            // New version has more detail — replace, but preserve the more
            // informative name (longer = more context, e.g. "check_rate_limit
            // (rate_limiter.py v2.0)" beats bare "check_rate_limit").
            if (!isEmpty) {
              const betterName = pickBetterName(
                String(existing.name ?? ""),
                String(sym.name ?? ""),
              );
              symbolMap.set(key, { ...sym, name: betterName });
            }
          } else {
            // Existing wins on size — but still upgrade its name if the new entry has a longer one.
            const betterName = pickBetterName(
              String(existing.name ?? ""),
              String(sym.name ?? ""),
            );
            existing.name = betterName;
          }
          // Merge riskTable entries (append unique ones)
          if (riskTable.length > 0 && existingRT.length > 0) {
            const merged = symbolMap.get(key)!;
            const mergedRT = Array.isArray(merged.riskTable) ? [...merged.riskTable as unknown[]] : [];
            const existingLocations = new Set(mergedRT.map((e: unknown) => (e as Record<string, unknown>).location));
            for (const entry of riskTable) {
              if (!existingLocations.has((entry as Record<string, unknown>).location)) {
                mergedRT.push(entry);
              }
            }
            merged.riskTable = mergedRT;
          }
          // Merge downstreamContracts (append unique by callee + file:line)
          if (downstream.length > 0 && existingDC.length > 0) {
            const merged = symbolMap.get(key)!;
            const mergedDC = Array.isArray(merged.downstreamContracts)
              ? [...merged.downstreamContracts as Array<Record<string, unknown>>]
              : [];
            const dcKey = (c: Record<string, unknown>) => `${c.callee}@${c.file}:${c.line}`;
            const seenDC = new Set(mergedDC.map(dcKey));
            for (const c of downstream) {
              if (!seenDC.has(dcKey(c))) mergedDC.push(c);
            }
            merged.downstreamContracts = mergedDC;
          }
        } else {
          if (!isEmpty) symbolMap.set(key, sym);
        }

        // Extract affected repos from callTree
        for (const node of callTree as Array<Record<string, unknown>>) {
          if (node.repo && typeof node.repo === "string") affectedRepoSet.add(node.repo);
        }
        // Downstream / sink repos also count as affected
        for (const c of downstream) {
          if (typeof c.repo === "string") affectedRepoSet.add(c.repo);
        }
      }
    }

    // Sum risk breakdown
    const summary = json.summary as Record<string, unknown> | undefined;
    if (summary) {
      const rb = summary.riskBreakdown as Record<string, number> | undefined;
      if (rb) {
        totalP0 += rb.P0 ?? 0;
        totalP1 += rb.P1 ?? 0;
        totalP2 += rb.P2 ?? 0;
        totalP3 += rb.P3 ?? 0;
        totalHuman += rb.NEEDS_HUMAN_REVIEW ?? 0;
      }
    }

    // Collect test scenarios (dedup by scenario name)
    if (Array.isArray(json.test_scenarios)) {
      allScenarios.push(...json.test_scenarios);
    }

    // Collect untrackable
    if (Array.isArray(json.untrackable)) {
      allUntrackable.push(...json.untrackable);
    }
  }

  // Dedup scenarios by name
  const scenarioNames = new Set<string>();
  const dedupedScenarios = allScenarios.filter((s) => {
    const name = String((s as Record<string, unknown>).scenario ?? "");
    if (scenarioNames.has(name)) return false;
    scenarioNames.add(name);
    return true;
  });

  const dedupedSymbols = [...symbolMap.values()];

  return {
    summary: {
      totalSymbolsChanged: dedupedSymbols.length,
      affectedRepos: affectedRepoSet.size,
      unaffectedRepos: 0,
      riskBreakdown: {
        P0: totalP0,
        P1: totalP1,
        P2: totalP2,
        P3: totalP3,
        NEEDS_HUMAN_REVIEW: totalHuman,
      },
    },
    symbols: dedupedSymbols,
    test_scenarios: dedupedScenarios,
    untrackable: [...new Set(allUntrackable.map(String))],
    globalPatternsMatched: [],
  };
}


// ─── Test exports ─────────────────────────────────────────────────────────────
// These helpers are exported for unit testing. Not part of the public API.
export {
  mergeAnalysisJsons as __mergeAnalysisJsonsForTest,
  symbolDedupKey as __symbolDedupKeyForTest,
  pickBetterName as __pickBetterNameForTest,
};

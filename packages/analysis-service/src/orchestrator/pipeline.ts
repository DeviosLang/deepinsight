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
import type { AnalysisTask, AnalysisResult, ChangeSpec, RiskLevel, CrossRepoImpactArtifact } from "@deepinsight/core";
import { RepoManager } from "../repo/repoManager.js";
import { coarseFilter, fineFilter } from "../pre-filter/index.js";
import { runPiWorker, runPiWorkerWithRetry, buildAnalysisPrompt, extractJsonFromOutput } from "./piWorker.js";
import { prefetchKnowledgeBases } from "./kbPrefetch.js";
import type { PiWorkerConfig, PiWorkerResult } from "./piWorker.js";
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
import { lintCrossRepoImpact, isLintEnabled, DRIFT_HEAVY_THRESHOLD } from "./schemaLint.js";
import type { LintResult } from "./schemaLint.js";

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
  /**
   * Knowledge bases pi can query on demand via `graphify query`. Built by the
   * indexer's runGraphifyKnowledgeBases() and stored at
   *   <workspaceDir>/.deepinsight/knowledge-graphs/<name>/graphify-out/graph.json
   * for built-on-the-fly entries, or
   *   <workspaceDir>/<repo>/<paths[0]>/graphify-out/graph.json
   * for prebuilt entries that ship the graph inside the repo.
   * Only entries whose graph.json exists at request time are exposed to pi.
   */
  knowledgeBases?: Array<{
    name: string;
    description: string;
    /** Routing hints — pi matches diff content against these to pick which kb to query */
    keywords: string[];
    graphPath: string;
  }>;
}

/**
 * Load pipeline config from environment variables and project config.
 */
export function loadPipelineConfig(): PipelineConfig {
  const projectConfigPath = process.env.PROJECT_CONFIG_PATH ?? "/etc/deepinsight/project.yml";
  let excludeDirs: string[] = [];
  let entryPointRepos: string[] = [];
  let sinkRepos: string[] = [];
  let knowledgeBases: Array<{ name: string; description: string; keywords: string[]; graphPath: string }> = [];

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

    // Parse knowledge_base[] — only graphify entries with an existing
    // graph.json are exposed to pi (otherwise the prompt would advertise a
    // non-existent graph and pi would waste a tool call confirming).
    //
    // Two graph location strategies:
    //   prebuilt: false → built daily by indexer, lives at
    //     <workspace>/.deepinsight/knowledge-graphs/<name>/graphify-out/graph.json
    //   prebuilt: true  → ships inside the repo, lives at
    //     <workspace>/<repo>/<paths[0]>/graphify-out/graph.json
    const workspaceDir = process.env.WORKSPACE_DIR ?? "/data/workspace";
    const rawKbList = config.knowledge_base;
    if (Array.isArray(rawKbList)) {
      for (const item of rawKbList) {
        if (typeof item !== "object" || item === null) continue;
        const kb = item as Record<string, unknown>;
        if (kb.type !== "graphify") continue;
        if (typeof kb.name !== "string" || !kb.name) continue;

        let graphPath: string;
        if (kb.prebuilt === true) {
          if (typeof kb.repo !== "string" || !kb.repo) {
            console.log(`[config] knowledge_base '${kb.name}' prebuilt but no repo specified; skipping`);
            continue;
          }
          // Use first path under the repo, or repo root if no paths declared.
          const firstPath = Array.isArray(kb.paths) && kb.paths.length > 0 ? String(kb.paths[0]) : "";
          graphPath = path.join(workspaceDir, kb.repo, firstPath, "graphify-out", "graph.json");
        } else {
          graphPath = path.join(
            workspaceDir,
            ".deepinsight",
            "knowledge-graphs",
            kb.name,
            "graphify-out",
            "graph.json",
          );
        }

        if (!fs.existsSync(graphPath)) {
          console.log(`[config] knowledge_base '${kb.name}' has no graph yet (${graphPath}); skipping`);
          continue;
        }
        const keywords = Array.isArray(kb.keywords)
          ? kb.keywords.map(String).filter(Boolean)
          : [];
        knowledgeBases.push({
          name: kb.name,
          description: typeof kb.description === "string" ? kb.description : "",
          keywords,
          graphPath,
        });
      }
      if (knowledgeBases.length > 0) {
        console.log(`[config] Loaded ${knowledgeBases.length} knowledge base(s): ${knowledgeBases.map(k => k.name).join(", ")}`);
      }
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
    knowledgeBases,
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
    const { result, piResult } = await runSingleChange(task, task.changes[0], config, repoManager, traceCtx);
    flushTrace(traceCtx, task, piResult ?? undefined).catch(() => {});
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

    // Attach commit messages to the diff so pi knows WHY the change was made,
    // not just WHAT changed. This significantly improves risk assessment accuracy.
    const base = change.base ?? "HEAD~1";
    const head = change.commit ?? "HEAD";
    const commitMessages = repoManager.getCommitMessages(change.repo, base, head);
    const diffWithContext = commitMessages
      ? `=== Commit Log ===\n${commitMessages}\n\n=== Code Diff ===\n${diff}`
      : diff;

    // Extract symbols
    const symbols = extractSymbolsFromDiff(diff);
    console.log(`[pipeline:${task.taskId}] ${change.repo}: diff ${diff.length} chars, ${symbols.length} symbols: ${symbols.map(s => s.name).join(', ')}`);
    resolvedChanges.push({ change, diff: diffWithContext, symbols });
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

  // Guard: dual-gate fallback to independent mode (P0-B)
  //
  // Old behaviour (single gate): allSymbols.length > 30 → fallback.
  //   Treated "5 repos × 6 symbols" identical to "1 repo × 30 symbols" — way too
  //   conservative. The failure mode of joint mode is "single repo's diff blows
  //   up the prompt", NOT "many small repos combined". Total symbol count is a
  //   weak proxy for prompt size.
  //
  // New behaviour (dual gate): fallback iff
  //   maxSingleRepoSymbols > JOINT_MODE_SINGLE_REPO_LIMIT (default 30) — guards
  //                                                                    prompt-size blow-up
  //   OR allSymbols.length > JOINT_MODE_TOTAL_LIMIT (default 80) — overall cap
  //
  // Effect: 5 repos × 6 symbols = 30 total now stays in joint mode (~2× faster
  // and ~60% cheaper LLM tokens since the diff is read once, not 5 times).
  // Large single repos (cvm_api 128 symbols) still fall back, unchanged.
  //
  // Rollback: set JOINT_MODE_TOTAL_LIMIT=30 and JOINT_MODE_SINGLE_REPO_LIMIT=30
  // via env to restore old single-gate behaviour without redeploy.
  const jointSingleRepoLimit = Math.max(
    1,
    parseInt(process.env.JOINT_MODE_SINGLE_REPO_LIMIT ?? "30", 10) || 30,
  );
  const jointTotalLimit = Math.max(
    jointSingleRepoLimit,
    parseInt(process.env.JOINT_MODE_TOTAL_LIMIT ?? "80", 10) || 80,
  );
  const maxSingleRepoSymbols = resolvedChanges.reduce(
    (m, rc) => (rc.symbols.length > m ? rc.symbols.length : m),
    0,
  );
  const exceedsSingle = maxSingleRepoSymbols > jointSingleRepoLimit;
  const exceedsTotal = allSymbols.length > jointTotalLimit;

  if (exceedsSingle || exceedsTotal) {
    const reason = exceedsSingle
      ? `single repo has ${maxSingleRepoSymbols} symbols > ${jointSingleRepoLimit}`
      : `total ${allSymbols.length} symbols > ${jointTotalLimit}`;
    console.log(
      `[pipeline:${task.taskId}] Falling back to independent mode: ${reason} (limits: single=${jointSingleRepoLimit}, total=${jointTotalLimit})`,
    );
    const results: Array<AnalysisResult | null> = [];
    // Track the LAST piResult across iterations — independent-mode fallback
    // runs each change separately; we attribute the trace to the most recent
    // run (typical case: one change drives the analysis, others are tiny).
    let lastPiResult: PiWorkerResult | null = null;
    for (const rc of resolvedChanges) {
      const { result, piResult } = await runSingleChange(task, rc.change, config, repoManager, traceCtx);
      results.push(result);
      if (piResult) lastPiResult = piResult;
    }
    const validResults = results.filter((r): r is AnalysisResult => r !== null);
    if (validResults.length === 0) return null;
    const merged = validResults.length === 1 ? validResults[0] : mergeMultiChangeResults(validResults);

    // Aggregate per-repo schemaLint summaries into the merged result's _meta.
    // mergeMultiChangeResults only combines business fields; _meta is dropped.
    // Re-aggregate here so the merged result carries the full drift picture.
    const mergedMeta = (merged as unknown as Record<string, unknown>)._meta as Record<string, unknown> | undefined;
    const lintSummaries = validResults
      .map((r) => ((r as unknown as Record<string, unknown>)._meta as Record<string, unknown> | undefined)?.schemaLint)
      .filter(Boolean) as Array<{ warningCount: number; categories: Record<string, number>; driftHeavy: boolean }>;
    if (lintSummaries.length > 0) {
      const totalWarnings = lintSummaries.reduce((s, l) => s + (l.warningCount ?? 0), 0);
      const mergedCategories: Record<string, number> = {};
      for (const l of lintSummaries) {
        for (const [k, v] of Object.entries(l.categories ?? {})) {
          mergedCategories[k] = (mergedCategories[k] ?? 0) + v;
        }
      }
      (merged as unknown as Record<string, unknown>)._meta = {
        ...(mergedMeta ?? {}),
        independentMode: true,
        repoCount: validResults.length,
        schemaLint: {
          warningCount: totalWarnings,
          categories: mergedCategories,
          driftHeavy: totalWarnings >= DRIFT_HEAVY_THRESHOLD,
          perRepo: lintSummaries.length,
        },
      };
    }

    flushTrace(traceCtx, task, lastPiResult ?? undefined).catch(() => {});
    return merged;
  }

  // Run unified pipeline with combined diff
  task.progress = { step: 3, stepName: "联合预筛", reposScanned: 0, reposTotal: 0 };

  const step3Start = Date.now();
  const allRepos = config.targetRepos ?? repoManager.listRepos();
  const changedRepos = new Set(resolvedChanges.map((rc) => rc.change.repo));
  const targetRepos = allRepos.filter((r) => !changedRepos.has(r));

  const quickMode = task.options?.quickMode === true;

  // Coarse filter with combined symbols
  console.log(`[pipeline:${task.taskId}] Step 3: Joint coarse filter, ${allSymbols.length} symbols across ${targetRepos.length} repos...`);
  const coarseHits = await coarseFilter(allSymbols, targetRepos, repoManager);
  console.log(`[pipeline:${task.taskId}] Step 3 coarse done: ${coarseHits.size} repos hit`);

  // Fine filter — quickMode skips it entirely
  let refinedHits: Set<string>;
  if (quickMode) {
    refinedHits = coarseHits;
    console.log(`[pipeline:${task.taskId}] Step 3: Skipping joint fine filter (quickMode)`);
  } else if (coarseHits.size > 3) {
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

  // Add entry points — quickMode skips this expansion
  const entryPoints = quickMode
    ? []
    : (config.entryPointRepos ?? []).filter(
        (r) => !changedRepos.has(r) && repoManager.repoExists(r),
      );
  // Add sink repos (downstream-chain convergence anchors)
  const sinkRepos = quickMode
    ? []
    : (config.sinkRepos ?? []).filter(
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
    // Degraded mode skips pi entirely → no piResult to attribute. Flush the
    // pipeline-stage spans we did record so the trace still has shape.
    flushTrace(traceCtx, task, undefined).catch(() => {});
    return null;
  }

  // Step 3.7: Pre-flight knowledge base lookup.
  // Proactively query KBs whose keywords match the diff — results are injected
  // into the prompt so pi has background context from the very first turn.
  // Runs in parallel with nothing (pure I/O), never blocks pi spawn (60s cap).
  // quickMode: skip KB prefetch — saves up to 60s of wall-clock.
  const kbPrefetchResults = quickMode
    ? []
    : await prefetchKnowledgeBases(
        combinedDiff,
        config.knowledgeBases,
        task.taskId,
      );
  if (kbPrefetchResults.length > 0) {
    console.log(`[pipeline:${task.taskId}] Step 3.7: KB prefetch done — ${kbPrefetchResults.map(r => r.name).join(", ")}`);
  }

  const piConfig: PiWorkerConfig & { fallbackModel?: string } = {
    provider: "tokenhub",
    model: config.llm.model,
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl,
    cwd: config.workspaceDir,
    timeoutMs: quickMode ? 480_000 : 900_000,
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
    knowledgeBases: quickMode ? undefined : config.knowledgeBases,
    kbPrefetchResults,
  };

  const step4Start = Date.now();
  // Limit parallel workers to avoid OOM: 4 for normal, 2 for large symbol sets.
  // quickMode: force single worker — see runSingleChange for rationale.
  const MAX_PARALLEL_WORKERS = quickMode ? 1 : (allSymbols.length > 30 ? 2 : 4);
  let piResult: Awaited<ReturnType<typeof runPiWorkerWithRetry>>;

  if (!quickMode && allSymbols.length >= 3) {
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
    const lint = applySchemaLint(jsonResult as Record<string, unknown>, task.taskId, "joint");
    (jsonResult as Record<string, unknown>)._meta = {
      durationMs: piResult.durationMs,
      jointMode: true,
      changes: resolvedChanges.map((rc) => rc.change.repo),
      ...(lint ? { schemaLint: summarizeLint(lint) } : {}),
    };
    flushTrace(traceCtx, task, piResult).catch(() => {});
    return jsonResult as unknown as AnalysisResult;
  }

  // Fallback — emit a minimal cross-repo-impact/2.0 skeleton so downstream
  // consumers don't crash on missing schema_version. The renderer treats
  // _rawOutput as the partial-output banner.
  flushTrace(traceCtx, task, piResult).catch(() => {});
  return buildFallbackArtifact({
    changes: resolvedChanges.map((rc) => rc.change),
    symbols: allSymbols.map((s) => ({
      name: s.name,
      location: "",
      diff_semantic: "见原始输出",
      initial_severity: "medium" as const,
    })),
    rawOutput: piOutput,
  }) as unknown as AnalysisResult;
}

/**
 * Analyze a single change (one repo/branch). Extracted to support multi-change mode.
 *
 * Returns both the structured result AND the raw piResult so the caller can
 * attribute the trace correctly — flushTrace needs the piResult for token /
 * cost / tool-event attribution. We split the responsibilities so the trace
 * is always flushed exactly once at the top level, regardless of which
 * caller path produced the result.
 */
async function runSingleChange(
  task: AnalysisTask,
  change: ChangeSpec,
  config: PipelineConfig,
  repoManager: RepoManager,
  traceCtx: ReturnType<typeof startTrace>,
): Promise<{ result: AnalysisResult | null; piResult: PiWorkerResult | null }> {
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
      return { result: null, piResult: null };
    }
  }

  // ─── Step 1: Get diff ────────────────────────────────────────────────────────
  task.progress = { step: 1, stepName: "获取 diff", reposScanned: 0, reposTotal: 0 };
  console.log(`[pipeline:${task.taskId}] Step 1: Getting diff for ${change.repo} (${change.base} → ${change.commit ?? 'HEAD'})`);

  const step1Start = Date.now();
  const diff = getDiff(repoManager, change, config.excludeDirs);
  if (!diff) {
    task.error = `无法获取 ${change.repo} 的 diff`;
    return { result: null, piResult: null };
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
    return { result: null, piResult: null };
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

  const quickMode = task.options?.quickMode === true;

  // Phase 2: Fine filter — ast-grep on worktrees (only if conditions met)
  // Skip fine filter if: coarse hits ≤ 3 (not worth it) OR symbols > 20 (too many → OOM risk)
  // quickMode: always skip — saves 30-60s of worktree checkout + ast-grep time
  let refinedHits: Set<string>;
  if (quickMode) {
    refinedHits = coarseHits;
    console.log(`[pipeline:${task.taskId}] Step 3: Skipping fine filter (quickMode)`);
  } else if (coarseHits.size > 3 && symbols.length <= 20) {
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
  // quickMode: skip entry/sink expansion — keep only repos that grep actually
  // hit. Trades cross-cutting coverage for ~1 fewer pi-worker turn.
  const entryPoints = quickMode
    ? []
    : (config.entryPointRepos ?? []).filter(
        (r) => r !== change.repo && repoManager.repoExists(r),
      );
  // Sink repos — downstream-chain convergence anchors
  const sinkRepos = quickMode
    ? []
    : (config.sinkRepos ?? []).filter(
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
      // quickMode: tighter timeout encourages pi to wrap up sooner. Steer
      // fires at ~85% of timeout (≈ 408s for 480s), leaving the remaining
      // 72s to write out the final JSON report. Empirically, 300s was too
      // tight — pi finished tool calls but got cut off mid-report.
      timeoutMs: quickMode ? 480_000 : 900_000,
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
      // quickMode: skip KB attachment so pi doesn't spend turns querying.
      knowledgeBases: quickMode ? undefined : config.knowledgeBases,
    };

    const step4Start = Date.now();
    // Limit parallel workers to avoid OOM: 4 for normal, 2 for large symbol sets.
    // quickMode: force single worker — multi-worker mode multiplies wall-clock
    // when LLM throughput is the bottleneck (each worker waits on the same
    // upstream API). Single worker also halves token cost.
    const MAX_PARALLEL_WORKERS = quickMode ? 1 : (symbols.length > 30 ? 2 : 4);

    if (!quickMode && symbols.length >= 3) {
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
    const lint = applySchemaLint(jsonResult as Record<string, unknown>, task.taskId, "single");
    // Add metadata about the analysis run
    (jsonResult as Record<string, unknown>)._meta = {
      durationMs: piResult?.durationMs,
      turns: piResult?.turnCount,
      toolCalls: piResult?.toolCallCount,
      timedOut: piResult ? !piResult.success && piResult.error?.includes("timeout") : false,
      degraded: isInDegradedMode(),
      changeRepo: change.repo,
      ...(lint ? { schemaLint: summarizeLint(lint) } : {}),
    };
    return { result: jsonResult as unknown as AnalysisResult, piResult };
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
    result: buildFallbackArtifact({
      changes: [change],
      symbols: symbols.map((s) => ({
        name: s.name,
        location: change.repo,
        diff_semantic: "见原始输出",
        initial_severity: "medium" as const,
      })),
      rawOutput: piOutput,
    }) as unknown as AnalysisResult,
    piResult,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Merge results from multiple changes (repos) into a single report.
 *
 * Schema-aware: when any input declares cross-repo-impact/2.x, the merged
 * output uses the new schema; otherwise legacy AnalysisResult shape is
 * preserved for back-compat.
 */
function mergeMultiChangeResults(results: AnalysisResult[]): AnalysisResult {
  // Reuse mergeAnalysisJsons — it already handles the dual-schema case.
  // The cast is safe: AnalysisResult and CrossRepoImpactArtifact are both
  // structural subsets of `Record<string, unknown>` here.
  const merged = mergeAnalysisJsons(results as unknown as Record<string, unknown>[]);
  return merged as unknown as AnalysisResult;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

const REQUIRED_RISK_KEYS: ReadonlyArray<RiskLevel> = ["P0", "P1", "P2", "P3", "NEEDS_HUMAN_REVIEW"];
const NEW_SCHEMA_VERSION_PATTERN = /^cross-repo-impact\/2\.\d+$/;

/**
 * Run schemaLint over a freshly-parsed pi artifact, log a one-line summary,
 * and return the LintResult so callers can fold its summary into _meta.
 *
 * Returns null when the lint feature flag is off (DEEPINSIGHT_SCHEMA_LINT=off)
 * — caller treats that as "no lint metadata to attach". The artifact is still
 * mutated in place when lint runs, so downstream consumers always see the
 * normalized shape regardless of whether _meta records the warning count.
 */
function applySchemaLint(
  artifact: Record<string, unknown>,
  taskId: string,
  mode: "single" | "joint",
): LintResult | null {
  if (!isLintEnabled()) return null;
  const lint = lintCrossRepoImpact(artifact);
  if (lint.warnings.length === 0) {
    console.log(`[pipeline:${taskId}] schemaLint(${mode}): clean (0 warnings)`);
    return lint;
  }

  const heavy = lint.warnings.length >= DRIFT_HEAVY_THRESHOLD;
  const topCats = Object.entries(lint.categories)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  console.log(
    `[pipeline:${taskId}] schemaLint(${mode}): ${lint.warnings.length} warnings${heavy ? " [DRIFT-HEAVY]" : ""} — top: ${topCats}`,
  );
  return lint;
}

/**
 * Compress LintResult into a small object suitable for _meta / Opik metadata.
 * Keeps full warnings array for debugging but trims path strings if the artifact
 * is huge — most consumers only read counts.
 */
function summarizeLint(lint: LintResult): Record<string, unknown> {
  return {
    warningCount: lint.warnings.length,
    categories: lint.categories,
    driftHeavy: lint.warnings.length >= DRIFT_HEAVY_THRESHOLD,
    // First 30 warnings inline; the rest just by category counts (avoid blowing up _meta size)
    sampleWarnings: lint.warnings.slice(0, 30).map((w) => ({
      category: w.category,
      path: w.path,
      message: w.message,
    })),
    truncatedWarnings: Math.max(0, lint.warnings.length - 30),
  };
}

/** Read a symbol's call_tree, falling back to legacy callTree. */
function getCallTree(sym: Record<string, unknown>): unknown[] {
  if (Array.isArray(sym.call_tree)) return sym.call_tree as unknown[];
  if (Array.isArray(sym.callTree)) return sym.callTree as unknown[];
  return [];
}

/** Read a symbol's risk_table, falling back to legacy riskTable. */
function getRiskTable(sym: Record<string, unknown>): unknown[] {
  if (Array.isArray(sym.risk_table)) return sym.risk_table as unknown[];
  if (Array.isArray(sym.riskTable)) return sym.riskTable as unknown[];
  return [];
}

/** Read a symbol's downstream_contracts, falling back to legacy downstreamContracts. */
function getDownstreamContracts(sym: Record<string, unknown>): unknown[] {
  if (Array.isArray(sym.downstream_contracts)) return sym.downstream_contracts as unknown[];
  if (Array.isArray(sym.downstreamContracts)) return sym.downstreamContracts as unknown[];
  return [];
}

/** Read a symbol's diff_semantic, falling back to legacy diffSemantic. */
function getDiffSemantic(sym: Record<string, unknown>): string {
  if (typeof sym.diff_semantic === "string") return sym.diff_semantic;
  if (typeof sym.diffSemantic === "string") return sym.diffSemantic;
  return "";
}

/**
 * Extract repos a downstream contract reaches. New schema uses `sink.repo`;
 * legacy uses bare `repo` (which is also still allowed in new schema for the
 * callee location).
 */
function downstreamContractRepos(c: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof c.repo === "string") out.push(c.repo);
  const sink = c.sink as Record<string, unknown> | null | undefined;
  if (sink && typeof sink === "object" && typeof sink.repo === "string") {
    out.push(sink.repo);
  }
  // Legacy fallback
  if (typeof c.sinkRepo === "string") out.push(c.sinkRepo);
  return out;
}

/**
 * Validate that a parsed-JSON object is a usable analysis result. Accepts
 * EITHER the new cross-repo-impact/2.x shape OR the legacy AnalysisResult
 * shape (so existing fixtures and any pi worker still emitting old format
 * keep working during the migration window).
 *
 * Tolerant of extra fields (forward-compat) but strict on the fields
 * downstream consumers will dereference.
 */
function isValidAnalysisResult(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;

  // New schema path: schema_version present + symbols array
  if (typeof o.schema_version === "string" && NEW_SCHEMA_VERSION_PATTERN.test(o.schema_version)) {
    if (!Array.isArray(o.symbols)) return false;
    // unanalyzable: required array; tolerant of legacy untrackable
    const una = o.unanalyzable;
    if (una !== undefined && !Array.isArray(una)) return false;
    // test_scenarios: required array (may be empty); tolerant if missing
    if (o.test_scenarios !== undefined && !Array.isArray(o.test_scenarios)) return false;
    return true;
  }

  // Legacy schema path: full summary object required
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

  if (!Array.isArray(o.symbols)) return false;
  if (o.untrackable !== undefined && !Array.isArray(o.untrackable)) return false;
  if (o.globalPatternsMatched !== undefined && !Array.isArray(o.globalPatternsMatched)) return false;

  return true;
}

/** Produce a short reason for why validation failed (for logging only). */
function describeValidationFailure(obj: unknown): string {
  if (typeof obj !== "object" || obj === null) return "not an object";
  const o = obj as Record<string, unknown>;

  // If they tried new schema, point at version-specific issues
  if (typeof o.schema_version === "string") {
    if (!NEW_SCHEMA_VERSION_PATTERN.test(o.schema_version)) {
      return `unsupported schema_version: ${o.schema_version}`;
    }
    if (!Array.isArray(o.symbols)) return "symbols is not an array";
    return "unknown new-schema validation error";
  }

  // Legacy diagnostic
  if (typeof o.summary !== "object" || o.summary === null) return "missing summary (and no schema_version)";
  const s = o.summary as Record<string, unknown>;
  if (typeof s.riskBreakdown !== "object" || s.riskBreakdown === null) return "missing summary.riskBreakdown";
  const rb = s.riskBreakdown as Record<string, unknown>;
  const missingKeys = REQUIRED_RISK_KEYS.filter((k) => typeof rb[k] !== "number");
  if (missingKeys.length > 0) return `riskBreakdown missing keys: ${missingKeys.join(",")}`;
  if (!Array.isArray(o.symbols)) return "symbols is not an array";
  return "unknown validation error";
}

/**
 * Sanitize the `downstream_contracts` (or legacy `downstreamContracts`) field
 * of a symbol coming from LLM JSON.
 *
 * EP-005 (cross-boundary data not validated): this field originates from an
 * untrusted model output. We never dereference it raw. Non-array input or
 * malformed elements are dropped with a warning rather than crashing the
 * merge or silently producing `undefined` downstream.
 *
 * Accepts both the new schema (callee + optional repo + sink object) and the
 * legacy schema (callee + repo + reachesSink + sinkRepo). The minimum
 * requirement is `callee: string` — `repo` is optional in the new schema
 * because the callee may be a leaf without a tracked sink.
 *
 * @returns a clean array of contract-shaped records (may be empty)
 */
function sanitizeDownstreamContracts(raw: unknown, ctx: string): Array<Record<string, unknown>> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    console.warn(`[merge] downstream_contracts not an array (${ctx}) — dropping`);
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      console.warn(`[merge] downstream_contracts element not an object (${ctx}) — skipping`);
      continue;
    }
    const c = item as Record<string, unknown>;
    // Require only the field we MUST have to dedup: callee. repo is optional in
    // the new schema (sink-less leaves don't need a repo on the contract row;
    // their repo, when present, lives in sink.repo). Legacy entries that DID
    // carry a flat `repo` still pass through.
    if (typeof c.callee !== "string") {
      console.warn(`[merge] downstream_contracts element missing callee (${ctx}) — skipping`);
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
 * Build a minimal cross-repo-impact/2.0 fallback artifact when pi fails to
 * emit valid JSON. Contains stub symbols (no call_tree / risk_table) plus a
 * `_rawOutput` tail so the renderer can show the partial pi text.
 */
function buildFallbackArtifact(params: {
  changes: ChangeSpec[];
  symbols: Array<{ name: string; location: string; diff_semantic: string; initial_severity: "high" | "medium" | "low" }>;
  rawOutput: string;
}): Record<string, unknown> {
  return {
    schema_version: "cross-repo-impact/2.0",
    meta: {
      tool_name: "deepinsight-pipeline",
      tool_version: "2.0",
      generated_at: new Date().toISOString(),
      dimension_catalog_version: "tapd-requirement-analyzer/4.A-2/v1",
    },
    changes: params.changes.map((c) => ({
      repo: c.repo,
      branch: c.branch,
      head_commit: c.commit ?? "",
      base_commit: c.base,
    })),
    symbols: params.symbols.map((s, i) => ({
      id: `SYM-${String(i + 1).padStart(3, "0")}`,
      name: s.name,
      location: s.location,
      diff_semantic: s.diff_semantic,
      initial_severity: s.initial_severity,
      call_tree: [],
      risk_table: [],
      downstream_contracts: [],
    })),
    test_scenarios: [],
    unanalyzable: [],
    global_patterns_matched: [],
    _rawOutput: truncateRawOutput(params.rawOutput),
  };
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
  // Concatenate all workers' tool events for the sub-span trace. Workers ran
  // in parallel so the timeline is interleaved by startTime — sort to keep
  // Opik's left-to-right rendering monotonic.
  const mergedToolEvents = successful
    .flatMap((r) => r.toolEvents ?? [])
    .sort((a, b) => a.startTime - b.startTime);

  return {
    success: successful.some((r) => r.success),
    output: mergedOutput,
    durationMs: maxDuration,
    usage: { inputTokens: totalInput, outputTokens: totalOutput },
    toolCallCount: totalToolCalls,
    turnCount: totalTurns,
    toolEvents: mergedToolEvents,
    error: successful.filter((r) => !r.success).map((r) => r.error).join("; ") || undefined,
  };
}

/**
 * Compute a stable dedup key for a symbol entry produced by an LLM worker.
 *
 * Order of preference:
 *   1. `id` (SYM-NNN) — new schema, stable across re-runs by contract.
 *      When workers all emit ids we never need anything else.
 *   2. `<basename>:<line>` from `location` — older fallback that survived the
 *      pre-id era. Two workers labelling the same function differently
 *      (e.g. "check_rate_limit" vs "check_rate_limit (rate_limiter.py v2.0)")
 *      still collide here.
 *   3. Normalized `name` — last-resort when location is missing/unparseable.
 *
 * Returns a tuple [primary, fallback] where `primary` is preferred for
 * matching and `fallback` provides backwards compatibility — so a worker
 * whose first emission carries a name-only entry can still be matched up
 * with a later location-bearing emission.
 */
function symbolDedupKey(sym: Record<string, unknown>): { primary: string; fallback: string } {
  const name = String(sym.name ?? "").trim();
  const id = typeof sym.id === "string" ? sym.id.trim() : "";
  const location = String(sym.location ?? "").trim();

  // Highest precedence: explicit id (new schema). Note we still record `name`
  // as the fallback so a later worker that emitted name-only can resolve into
  // the same entry. The reverse — id-only resolving to a name-keyed entry —
  // does NOT happen because two id-bearing workers always agree on the id.
  if (id) {
    return { primary: id, fallback: name || location };
  }

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
 * Schema-tolerant: handles both cross-repo-impact/2.x (snake_case +
 * `id: SYM-NNN`) and the legacy AnalysisResult shape (camelCase). When the
 * inputs are mixed (one worker on new schema, another on legacy), the merge
 * picks whichever shape the first input declares for the output, falling
 * back to legacy if no `schema_version` is present anywhere.
 *
 * Dedup strategy:
 *   1. SYM-NNN id when available.
 *   2. Normalized location (basename:line) — fixes parallel workers labelling
 *      the same function differently.
 *   3. Symbol name as last resort.
 */
function mergeAnalysisJsons(jsons: Record<string, unknown>[]): Record<string, unknown> {
  const symbolMap = new Map<string, Record<string, unknown>>();
  const keyAliases = new Map<string, string>(); // fallback-key → primary-key
  const allScenarios: unknown[] = [];
  // Both new (unanalyzable: object[]) and legacy (untrackable: string[]) collected
  // separately; the chosen shape is decided at output time based on what was seen.
  const allUnanalyzable: Record<string, unknown>[] = [];
  const allUntrackable: unknown[] = [];
  const allGlobalPatterns: string[] = [];
  let totalP0 = 0, totalP1 = 0, totalP2 = 0, totalP3 = 0, totalHuman = 0;
  const affectedRepoSet = new Set<string>();

  // Detect whether we should emit new-schema output. Any input with
  // schema_version: cross-repo-impact/2.x flips the switch.
  let emitNewSchema = false;
  let firstMeta: Record<string, unknown> | undefined;
  let firstChanges: unknown[] | undefined;

  for (const json of jsons) {
    if (typeof json.schema_version === "string" && NEW_SCHEMA_VERSION_PATTERN.test(json.schema_version)) {
      emitNewSchema = true;
      if (!firstMeta && typeof json.meta === "object" && json.meta !== null) {
        firstMeta = json.meta as Record<string, unknown>;
      }
      if (!firstChanges && Array.isArray(json.changes)) {
        firstChanges = json.changes as unknown[];
      }
    }

    // Collect and dedup symbols (works for both schemas via getCallTree etc.)
    if (Array.isArray(json.symbols)) {
      for (const sym of json.symbols as Array<Record<string, unknown>>) {
        const { primary, fallback } = symbolDedupKey(sym);
        if (!primary && !fallback) continue;

        // Resolve to canonical key:
        //  1. SYM-NNN id always wins — direct match if present in map.
        //  2. If primary already in map → use it directly.
        //  3. Else if this entry has no usable location (primary derived from
        //     name), look up via fallback alias to catch "same fn, different
        //     name suffix" cases. We deliberately DO NOT consult the alias map
        //     when primary is a file:line — that would over-merge two distinct
        //     locations that happen to share a name (e.g. a wrapper +
        //     wrapped fn).
        //  4. Else this entry establishes a new primary; record fallback as
        //     alias only when primary itself was name-derived.
        const isIdKey = /^SYM-\d+$/i.test(primary);
        const primaryIsLocationBased = !isIdKey && /[:.]/.test(primary) && primary !== fallback;
        let key: string;
        if (symbolMap.has(primary)) {
          key = primary;
        } else if (isIdKey) {
          // Establish new id-keyed entry; alias by name+location too so
          // late-arriving id-less variants resolve into it.
          key = primary;
          if (fallback && fallback !== key) keyAliases.set(fallback, key);
        } else if (!primaryIsLocationBased && fallback && keyAliases.has(fallback)) {
          key = keyAliases.get(fallback)!;
        } else {
          key = primary || fallback;
          if (!primaryIsLocationBased && fallback && fallback !== key) {
            keyAliases.set(fallback, key);
          }
        }

        const callTree = getCallTree(sym);
        const riskTable = getRiskTable(sym);
        const downstreamRaw = sym.downstream_contracts ?? sym.downstreamContracts;
        const downstream = sanitizeDownstreamContracts(downstreamRaw, `symbol=${key}`);
        // Normalize: write back to the canonical (new-schema) field, leaving
        // the legacy one undefined. Renderer reads either.
        sym.downstream_contracts = downstream;
        if ("downstreamContracts" in sym) {
          delete sym.downstreamContracts;
        }

        // Skip empty shells (no callTree, no riskTable, no downstream, no diff)
        const isEmpty =
          callTree.length === 0 &&
          riskTable.length === 0 &&
          downstream.length === 0 &&
          !getDiffSemantic(sym);

        if (symbolMap.has(key)) {
          // Merge: keep the version with more content
          const existing = symbolMap.get(key)!;
          const existingCT = getCallTree(existing);
          const existingRT = getRiskTable(existing);
          const existingDC = getDownstreamContracts(existing);

          if (
            callTree.length > existingCT.length ||
            riskTable.length > existingRT.length ||
            downstream.length > existingDC.length
          ) {
            // New version has more detail — replace, but preserve the more
            // informative name (longer = more context).
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
          // Merge risk_table entries (append unique ones by location)
          if (riskTable.length > 0 && existingRT.length > 0) {
            const merged = symbolMap.get(key)!;
            const mergedRT = [...getRiskTable(merged)];
            const existingLocations = new Set(
              mergedRT.map((e: unknown) => (e as Record<string, unknown>).location),
            );
            for (const entry of riskTable) {
              if (!existingLocations.has((entry as Record<string, unknown>).location)) {
                mergedRT.push(entry);
              }
            }
            // Write back via the canonical (new) field.
            merged.risk_table = mergedRT;
            if ("riskTable" in merged) delete merged.riskTable;
          }
          // Merge downstream_contracts (append unique by callee + file:line)
          if (downstream.length > 0 && existingDC.length > 0) {
            const merged = symbolMap.get(key)!;
            const mergedDC = [...getDownstreamContracts(merged)] as Array<Record<string, unknown>>;
            const dcKey = (c: Record<string, unknown>) => `${c.callee}@${c.file ?? ""}:${c.line ?? ""}`;
            const seenDC = new Set(mergedDC.map(dcKey));
            for (const c of downstream) {
              if (!seenDC.has(dcKey(c))) mergedDC.push(c);
            }
            merged.downstream_contracts = mergedDC;
            if ("downstreamContracts" in merged) delete merged.downstreamContracts;
          }
        } else {
          if (!isEmpty) symbolMap.set(key, sym);
        }

        // Extract affected repos from call_tree
        for (const node of callTree as Array<Record<string, unknown>>) {
          if (node.repo && typeof node.repo === "string") affectedRepoSet.add(node.repo);
        }
        // Downstream / sink repos also count as affected
        for (const c of downstream) {
          for (const r of downstreamContractRepos(c)) affectedRepoSet.add(r);
        }
      }
    }

    // Sum risk breakdown — only present in legacy outputs; new-schema outputs
    // don't carry a summary. We accumulate whatever we see and recompute from
    // call_tree priorities afterwards.
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

    // Collect test scenarios (dedup by id when present, else by scenario name)
    if (Array.isArray(json.test_scenarios)) {
      allScenarios.push(...json.test_scenarios);
    }

    // Collect unanalyzable (new) and untrackable (legacy)
    if (Array.isArray(json.unanalyzable)) {
      for (const item of json.unanalyzable as unknown[]) {
        if (typeof item === "object" && item !== null) {
          allUnanalyzable.push(item as Record<string, unknown>);
        }
      }
    }
    if (Array.isArray(json.untrackable)) {
      allUntrackable.push(...json.untrackable);
    }

    // Collect global patterns (both naming conventions)
    const gp = json.global_patterns_matched ?? json.globalPatternsMatched;
    if (Array.isArray(gp)) {
      for (const p of gp) if (typeof p === "string") allGlobalPatterns.push(p);
    }
  }

  // Dedup scenarios — prefer id, fall back to scenario text.
  const scenarioKeySeen = new Set<string>();
  const dedupedScenarios = allScenarios.filter((s) => {
    const o = s as Record<string, unknown>;
    const k = typeof o.id === "string" ? `id:${o.id}` : `name:${String(o.scenario ?? "")}`;
    if (scenarioKeySeen.has(k)) return false;
    scenarioKeySeen.add(k);
    return true;
  });

  // Dedup unanalyzable by id (new) or by subject (legacy-derived).
  const unanalyzableKeySeen = new Set<string>();
  const dedupedUnanalyzable = allUnanalyzable.filter((u) => {
    const k = typeof u.id === "string" ? `id:${u.id}` : `subj:${String(u.subject ?? "")}`;
    if (unanalyzableKeySeen.has(k)) return false;
    unanalyzableKeySeen.add(k);
    return true;
  });

  const dedupedSymbols = [...symbolMap.values()];

  // If any input declared the new schema, emit new-schema output. Otherwise
  // fall back to legacy (preserves test fixtures + any callsite still on
  // pre-2.0 pipeline).
  if (emitNewSchema) {
    return {
      schema_version: "cross-repo-impact/2.0",
      meta: firstMeta ?? buildDefaultMeta(),
      changes: firstChanges ?? [],
      symbols: dedupedSymbols,
      test_scenarios: dedupedScenarios,
      unanalyzable: dedupedUnanalyzable.length > 0
        ? dedupedUnanalyzable
        // Promote legacy untrackable strings to schema_unknown items for compat.
        : [...new Set(allUntrackable.map(String))].map((subject, i) => ({
            id: `UA-${String(i + 1).padStart(3, "0")}`,
            category: "schema_unknown",
            subject,
            implication: "(legacy untrackable string promoted to unanalyzable; investigate manually)",
            suggested_handling: "manual",
          })),
      global_patterns_matched: [...new Set(allGlobalPatterns)],
    };
  }

  // Legacy output (back-compat). Preserve historical summary shape.
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
    globalPatternsMatched: [...new Set(allGlobalPatterns)],
  };
}

/** Build a default meta block when merge synthesizes new-schema output. */
function buildDefaultMeta(): Record<string, unknown> {
  return {
    tool_name: "deepinsight-pipeline",
    tool_version: "2.0",
    generated_at: new Date().toISOString(),
    dimension_catalog_version: "tapd-requirement-analyzer/4.A-2/v1",
  };
}


// ─── Test exports ─────────────────────────────────────────────────────────────
// These helpers are exported for unit testing. Not part of the public API.
export {
  mergeAnalysisJsons as __mergeAnalysisJsonsForTest,
  symbolDedupKey as __symbolDedupKeyForTest,
  pickBetterName as __pickBetterNameForTest,
};

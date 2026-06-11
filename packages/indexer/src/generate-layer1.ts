/**
 * generate-layer1.ts — Deterministic AGENTS.md auto-segment generation.
 *
 * Scans all repos in the workspace and generates a Layer 1 AGENTS.md for each:
 * - Directory structure (tree -L 2)
 * - Exported symbols (__init__.py analysis)
 * - HTTP route definitions
 * - MQ publish/consume points
 * - Test framework detection
 *
 * Zero LLM cost — all operations are deterministic (git/grep/find/fs).
 *
 * Usage:
 *   npx tsx packages/indexer/src/generate-layer1.ts [--workspace /data/workspace] [--config /etc/deepinsight/project.yml]
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";

// ─── CLI args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const WORKSPACE_DIR = getArg("--workspace", process.env.WORKSPACE_DIR ?? "/data/workspace");
const CONFIG_PATH = getArg("--config", process.env.PROJECT_CONFIG_PATH ?? "/etc/deepinsight/project.yml");
const OUTPUT_DIR = path.join(WORKSPACE_DIR, ".deepinsight", "agents-md");

// ─── Project Config loading ─────────────────────────────────────────────────

interface RepoEntry {
  name: string;
  language?: string;
  role?: string;
  tags?: string[];
}

interface KnowledgeBaseEntry {
  /** Unique id; becomes the directory name under .deepinsight/knowledge-graphs/ */
  name: string;
  /** Workspace dir under WORKSPACE_DIR (e.g. "ai_docs") */
  repo: string;
  /** Indexer type — currently only "graphify" is implemented */
  type: string;
  /** Subset paths relative to repo root; empty/missing = whole repo */
  paths?: string[];
  /** Human description shown to pi at analysis time */
  description?: string;
  /** Routing hints (Chinese + English) — pi matches diff content against these */
  keywords?: string[];
  /**
   * If true, the graph.json already lives at <repo>/<paths[0]>/graphify-out/graph.json
   * (e.g. every_thing_cvm ships pre-built graphs). Indexer skips `graphify extract`
   * and only verifies the file exists. Default: false.
   */
  prebuilt?: boolean;
}

interface ProjectConfig {
  repos: RepoEntry[];
  runtime_calls?: {
    http?: { route_patterns?: string[]; framework_patterns?: string[] };
    mq?: { producer_patterns?: string[]; consumer_patterns?: string[] };
  };
  risk_patterns?: {
    high_risk_dirs?: string[];
    api_dirs?: string[];
  };
  knowledge_base?: KnowledgeBaseEntry[];
}

function loadProjectConfig(): ProjectConfig | null {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return YAML.parse(raw) as ProjectConfig;
  } catch {
    console.warn(`[indexer] No project config at ${CONFIG_PATH}, will scan all repos with defaults`);
    return null;
  }
}

// ─── Repo scanning functions ────────────────────────────────────────────────

function getHeadCommit(repoPath: string): string {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: repoPath,
    encoding: "utf-8",
    timeout: 5_000,
  });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function getDirectoryTree(repoPath: string): string {
  // Use find instead of tree (more portable, and tree might not be installed)
  const result = spawnSync(
    "find",
    [".", "-maxdepth", "2", "-type", "d",
      "!", "-path", "./.git*",
      "!", "-path", "./__pycache__*",
      "!", "-path", "./node_modules*",
      "!", "-path", "./.venv*",
      "!", "-path", "./venv*",
      "!", "-path", "./.tox*",
      "!", "-path", "./dist*",
      "!", "-path", "./.mypy_cache*",
    ],
    { cwd: repoPath, encoding: "utf-8", timeout: 10_000 },
  );
  if (result.status !== 0) return "(scan failed)";

  const dirs = result.stdout.trim().split("\n").filter(Boolean).sort();
  // Format as indented tree
  return dirs
    .map((d) => {
      const depth = d.split("/").length - 1;
      const name = path.basename(d) || ".";
      if (depth === 0) return name + "/";
      return "  ".repeat(depth) + name + "/";
    })
    .join("\n");
}

function getExportedSymbols(repoPath: string): string[] {
  const symbols: string[] = [];

  // Find all __init__.py files and extract "from .xxx import yyy" lines
  const findResult = spawnSync(
    "find",
    [".", "-name", "__init__.py", "-not", "-path", "./.venv/*", "-not", "-path", "./venv/*"],
    { cwd: repoPath, encoding: "utf-8", timeout: 10_000 },
  );
  if (findResult.status !== 0) return symbols;

  const initFiles = findResult.stdout.trim().split("\n").filter(Boolean);
  for (const initFile of initFiles.slice(0, 20)) { // Cap to prevent massive repos
    try {
      const content = fs.readFileSync(path.join(repoPath, initFile), "utf-8");
      const lines = content.split("\n");
      for (const line of lines) {
        // Match: from .module import symbol1, symbol2
        const match = line.match(/^from\s+\.\w*\s+import\s+(.+)/);
        if (match) {
          const imports = match[1].split(",").map((s) => s.trim().split(" as ")[0].trim());
          for (const imp of imports) {
            if (imp && !imp.startsWith("_") && imp !== "*") {
              symbols.push(`${path.dirname(initFile)}:${imp}`);
            }
          }
        }
      }
    } catch {
      // File read error, skip
    }
  }

  return [...new Set(symbols)].slice(0, 50); // Dedup + cap
}

function getHttpRoutes(repoPath: string, patterns: string[]): string[] {
  const routes: string[] = [];

  for (const pattern of patterns) {
    const result = spawnSync(
      "grep",
      ["-rn", "--include=*.py", "--include=*.go", "--include=*.php", pattern, "."],
      { cwd: repoPath, encoding: "utf-8", timeout: 15_000 },
    );
    if (result.status === 0 && result.stdout) {
      const lines = result.stdout.trim().split("\n").filter(Boolean);
      for (const line of lines.slice(0, 30)) {
        // Extract just file:line: matched-content (truncated)
        const truncated = line.length > 120 ? line.slice(0, 120) + "..." : line;
        routes.push(truncated);
      }
    }
  }

  return [...new Set(routes)].slice(0, 40);
}

function getMqPoints(repoPath: string, producerPatterns: string[], consumerPatterns: string[]): { producers: string[]; consumers: string[] } {
  const producers: string[] = [];
  const consumers: string[] = [];

  for (const pattern of producerPatterns) {
    const result = spawnSync(
      "grep",
      ["-rn", "--include=*.py", pattern, "."],
      { cwd: repoPath, encoding: "utf-8", timeout: 10_000 },
    );
    if (result.status === 0 && result.stdout) {
      const lines = result.stdout.trim().split("\n").filter(Boolean);
      producers.push(...lines.slice(0, 10).map((l) => l.length > 120 ? l.slice(0, 120) + "..." : l));
    }
  }

  for (const pattern of consumerPatterns) {
    const result = spawnSync(
      "grep",
      ["-rn", "--include=*.py", pattern, "."],
      { cwd: repoPath, encoding: "utf-8", timeout: 10_000 },
    );
    if (result.status === 0 && result.stdout) {
      const lines = result.stdout.trim().split("\n").filter(Boolean);
      consumers.push(...lines.slice(0, 10).map((l) => l.length > 120 ? l.slice(0, 120) + "..." : l));
    }
  }

  return { producers: [...new Set(producers)], consumers: [...new Set(consumers)] };
}

function getTestInfo(repoPath: string): string {
  const parts: string[] = [];

  // Check for pytest
  const pytestConf = ["pytest.ini", "pyproject.toml", "setup.cfg", "conftest.py"];
  for (const f of pytestConf) {
    if (fs.existsSync(path.join(repoPath, f))) {
      parts.push(`framework: pytest (found ${f})`);
      break;
    }
  }

  // Count test files
  const countResult = spawnSync(
    "find",
    [".", "-name", "test_*.py", "-o", "-name", "*_test.py", "-o", "-name", "*_test.go"],
    { cwd: repoPath, encoding: "utf-8", timeout: 10_000 },
  );
  if (countResult.status === 0) {
    const count = countResult.stdout.trim().split("\n").filter(Boolean).length;
    parts.push(`test files: ${count}`);
  }

  // Check for coverage report
  const coveragePaths = ["coverage/", "htmlcov/", ".coverage", "coverage.xml", "coverage-summary.json"];
  for (const cp of coveragePaths) {
    if (fs.existsSync(path.join(repoPath, cp))) {
      parts.push(`coverage: found ${cp}`);
      break;
    }
  }

  return parts.length > 0 ? parts.join(", ") : "no test info detected";
}

function getHighRiskDirs(repoPath: string, patterns: string[]): string[] {
  const hits: string[] = [];
  for (const pattern of patterns) {
    // Convert glob to find pattern
    const findPattern = pattern.replace("*/", "*/");
    const result = spawnSync(
      "find",
      [".", "-type", "d", "-path", findPattern],
      { cwd: repoPath, encoding: "utf-8", timeout: 5_000 },
    );
    if (result.status === 0 && result.stdout.trim()) {
      hits.push(...result.stdout.trim().split("\n").filter(Boolean));
    }
  }
  return [...new Set(hits)];
}

// ─── AGENTS.md generation ───────────────────────────────────────────────────

function generateAgentsMd(repoPath: string, repoConfig: RepoEntry | null, projectConfig: ProjectConfig | null): string {
  const repoName = path.basename(repoPath);
  const timestamp = new Date().toISOString();
  const commit = getHeadCommit(repoPath);

  const routePatterns = projectConfig?.runtime_calls?.http?.route_patterns ?? [
    "@app.route", "@router.", "urlpatterns", "path(",
  ];
  const producerPatterns = projectConfig?.runtime_calls?.mq?.producer_patterns ?? [
    "basic_publish", "channel.publish",
  ];
  const consumerPatterns = projectConfig?.runtime_calls?.mq?.consumer_patterns ?? [
    "basic_consume", "queue_bind",
  ];
  const highRiskDirPatterns = projectConfig?.risk_patterns?.high_risk_dirs ?? [
    "*/auth/*", "*/payment/*", "*/security/*",
  ];

  const parts: string[] = [];

  // Header
  parts.push(`# ${repoName}`);
  parts.push(`<!-- auto-generated: ${timestamp}, commit: ${commit} -->`);
  parts.push("");

  // Language & Role
  if (repoConfig) {
    parts.push(`## 语言\n${repoConfig.language ?? "python"}`);
    parts.push("");
    parts.push(`## 角色\n${repoConfig.role ?? "service"}`);
    if (repoConfig.tags && repoConfig.tags.length > 0) {
      parts.push(`标签: ${repoConfig.tags.join(", ")}`);
    }
    parts.push("");
  }

  // Directory structure
  parts.push("## 目录结构");
  parts.push("```");
  parts.push(getDirectoryTree(repoPath));
  parts.push("```");
  parts.push("");

  // Exported symbols
  const exports = getExportedSymbols(repoPath);
  if (exports.length > 0) {
    parts.push("## 导出符号");
    for (const exp of exports) {
      parts.push(`- ${exp}`);
    }
    parts.push("");
  }

  // HTTP routes
  const routes = getHttpRoutes(repoPath, routePatterns);
  if (routes.length > 0) {
    parts.push("## HTTP 路由");
    parts.push("```");
    for (const route of routes) {
      parts.push(route);
    }
    parts.push("```");
    parts.push("");
  }

  // MQ
  const mq = getMqPoints(repoPath, producerPatterns, consumerPatterns);
  if (mq.producers.length > 0 || mq.consumers.length > 0) {
    parts.push("## MQ 消息");
    if (mq.producers.length > 0) {
      parts.push("### 发布");
      parts.push("```");
      for (const p of mq.producers) parts.push(p);
      parts.push("```");
    }
    if (mq.consumers.length > 0) {
      parts.push("### 消费");
      parts.push("```");
      for (const c of mq.consumers) parts.push(c);
      parts.push("```");
    }
    parts.push("");
  }

  // High risk directories
  const riskDirs = getHighRiskDirs(repoPath, highRiskDirPatterns);
  if (riskDirs.length > 0) {
    parts.push("## 高风险目录");
    for (const d of riskDirs) {
      parts.push(`- ${d}`);
    }
    parts.push("");
  }

  // Test info
  const testInfo = getTestInfo(repoPath);
  parts.push(`## 测试\n${testInfo}`);
  parts.push("");

  return parts.join("\n");
}

// ─── Main ───────────────────────────────────────────────────────────────────

/**
 * Build/refresh graphify knowledge graphs for every `knowledge_base[]` entry
 * with `type: graphify`. Output lands at:
 *   <WORKSPACE_DIR>/.deepinsight/knowledge-graphs/<entry.name>/graphify-out/graph.json
 *
 * Behaviour:
 *   - Existing graph.json → incremental `--update` (only changed files re-extracted)
 *   - No graph.json yet → full extract
 *   - Failure for one entry is logged and SKIPPED (other entries still run)
 *
 * The graph.json is what pi consumes via `graphify query` at analysis time.
 * GRAPH_REPORT.md is intentionally NOT generated here (--no-cluster):
 *   1. The full report can exceed the prompt budget for large corpora.
 *   2. Community labelling against tokenhub currently returns malformed JSON,
 *      so we skip it; pi calls `graphify query` for navigation instead.
 */
function runGraphifyKnowledgeBases(config: ProjectConfig | null): void {
  const kbList = config?.knowledge_base ?? [];
  if (kbList.length === 0) {
    console.log("[indexer] No knowledge_base entries declared; skipping graphify step");
    return;
  }

  // Auth: graphify reads TOKENHUB_API_KEY for the custom provider registered
  // in the Docker image (~/.graphify/providers.json). We map the existing
  // LLM_ANALYSIS_API_KEY through here so deployments don't need a second secret.
  const llmKey = process.env.TOKENHUB_API_KEY ?? process.env.LLM_ANALYSIS_API_KEY;
  if (!llmKey) {
    console.warn("[indexer] Neither TOKENHUB_API_KEY nor LLM_ANALYSIS_API_KEY set; skipping graphify step");
    return;
  }

  const outBase = path.join(WORKSPACE_DIR, ".deepinsight", "knowledge-graphs");
  fs.mkdirSync(outBase, { recursive: true });

  for (const kb of kbList) {
    if (kb.type !== "graphify") {
      console.log(`[indexer]   skip kb '${kb.name}': type=${kb.type} not implemented`);
      continue;
    }
    if (!kb.name || !kb.repo) {
      console.warn(`[indexer]   skip kb: missing name/repo (${JSON.stringify(kb)})`);
      continue;
    }

    const repoPath = path.join(WORKSPACE_DIR, kb.repo);
    if (!fs.existsSync(repoPath)) {
      console.warn(`[indexer]   skip kb '${kb.name}': repo dir ${repoPath} not found`);
      continue;
    }

    // Scan root: first declared path under the repo, or the repo root itself.
    // Multi-path corpora aren't supported in one graph — declare a separate
    // knowledge_base entry per logical scope (see example.template.yml).
    const scanRoot = (kb.paths && kb.paths.length > 0)
      ? path.join(repoPath, kb.paths[0])
      : repoPath;
    if (!fs.existsSync(scanRoot)) {
      console.warn(`[indexer]   skip kb '${kb.name}': scan root ${scanRoot} not found`);
      continue;
    }

    // Prebuilt graphs (e.g. every_thing_cvm ships graphify-out/ inside the
    // repo) — just verify the graph.json exists; skip extract entirely.
    if (kb.prebuilt) {
      const inRepoGraph = path.join(scanRoot, "graphify-out", "graph.json");
      if (fs.existsSync(inRepoGraph)) {
        const stat = fs.statSync(inRepoGraph);
        console.log(
          `[indexer]   ✓ ${kb.name} (prebuilt, ${(stat.size / 1024).toFixed(1)} KB) — using ${inRepoGraph}`,
        );
      } else {
        console.warn(
          `[indexer]   ✗ ${kb.name} declared prebuilt but graph.json missing at ${inRepoGraph}`,
        );
      }
      continue;
    }

    const outDir = path.join(outBase, kb.name);
    fs.mkdirSync(outDir, { recursive: true });

    const existingGraph = path.join(outDir, "graphify-out", "graph.json");
    const isUpdate = fs.existsSync(existingGraph);

    const args = [
      "extract", scanRoot,
      "--backend", "tokenhub",
      "--out", outDir,
      "--no-cluster",
      "--max-concurrency", "4",
    ];
    if (isUpdate) {
      // graphify reuses cache/ under graphify-out/ to skip unchanged files;
      // no separate flag needed for incremental — re-running on the same --out
      // dir is itself the update path.
    }

    console.log(
      `[indexer] graphify ${kb.name}: ${scanRoot} → ${outDir}${isUpdate ? " (incremental)" : " (initial)"}`,
    );
    const t0 = Date.now();
    const result = spawnSync("graphify", args, {
      stdio: "inherit",
      timeout: 4 * 60 * 60 * 1000, // 4h ceiling — large corpora (1000+ docs) can take 2-3h
      env: {
        ...process.env,
        TOKENHUB_API_KEY: llmKey,
      },
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    if (result.status !== 0) {
      console.warn(
        `[indexer]   ✗ graphify ${kb.name} exit ${result.status}${result.error ? ` (${result.error.message})` : ""} after ${dt}s`,
      );
    } else {
      console.log(`[indexer]   ✓ graphify ${kb.name} done in ${dt}s`);
    }
  }
}

function main(): void {
  console.log(`[indexer] Workspace: ${WORKSPACE_DIR}`);
  console.log(`[indexer] Config: ${CONFIG_PATH}`);
  console.log(`[indexer] Output: ${OUTPUT_DIR}`);

  // Load project config (optional)
  const projectConfig = loadProjectConfig();

  // Discover repos: use config if available, otherwise scan workspace directory
  let repos: Array<{ name: string; path: string; config: RepoEntry | null }>;

  if (projectConfig?.repos && Array.isArray(projectConfig.repos)) {
    // Config has explicit repo list (array format)
    repos = projectConfig.repos
      .map((r) => ({
        name: r.name,
        path: path.join(WORKSPACE_DIR, r.name),
        config: r,
      }))
      .filter((r) => fs.existsSync(path.join(r.path, ".git")));
  } else {
    // Fallback: scan workspace for git repos (handles both missing config and non-array repos)
    const entries = fs.readdirSync(WORKSPACE_DIR, { withFileTypes: true });
    repos = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && fs.existsSync(path.join(WORKSPACE_DIR, e.name, ".git")))
      .map((e) => ({ name: e.name, path: path.join(WORKSPACE_DIR, e.name), config: null }));
  }

  if (repos.length === 0) {
    console.warn("[indexer] No repos found in workspace. Nothing to generate.");
    return;
  }

  console.log(`[indexer] Found ${repos.length} repos: ${repos.map((r) => r.name).join(", ")}`);

  // Ensure output dir
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Generate AGENTS.md for each repo
  let generated = 0;
  for (const repo of repos) {
    try {
      console.log(`[indexer] Scanning ${repo.name}...`);
      const md = generateAgentsMd(repo.path, repo.config, projectConfig);
      const outPath = path.join(OUTPUT_DIR, `${repo.name}.md`);
      fs.writeFileSync(outPath, md, "utf-8");
      generated++;
      console.log(`[indexer]   ✓ ${repo.name} → ${outPath} (${md.length} chars)`);
    } catch (err) {
      console.error(`[indexer]   ✗ ${repo.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n[indexer] Done. Generated ${generated}/${repos.length} AGENTS.md files in ${OUTPUT_DIR}`);

  // Build/refresh knowledge-base graphs (graphify). Failures here don't fail
  // the AGENTS.md run — knowledge graphs are an optional enrichment.
  console.log(`\n[indexer] === Knowledge base graphify step ===`);
  try {
    runGraphifyKnowledgeBases(projectConfig);
  } catch (err) {
    console.error(
      `[indexer] graphify step crashed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

main();

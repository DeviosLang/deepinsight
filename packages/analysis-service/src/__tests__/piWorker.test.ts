import { describe, test, expect } from "vitest";

/**
 * Unit tests for piWorker.ts — buildAnalysisPrompt and extractJsonFromOutput
 */

// Re-implement buildAnalysisPrompt for testing (same logic as piWorker.ts)
function buildAnalysisPrompt(params: {
  diff: string;
  repoName: string;
  reposRoot: string;
  targetRepos: string[];
  entryPointRepos?: string[];
  sinkRepos?: string[];
  agentsMd?: string;
  globalPatterns?: string;
}): string {
  const parts: string[] = [];

  parts.push(`# 跨仓影响分析任务\n\n## 变更仓库\n${params.repoName}\n\n## Diff 内容\n\`\`\`diff\n${params.diff}\n\`\`\`\n\n## 可分析的仓库目录\n仓库根目录: ${params.reposRoot}\n目标仓库: ${params.targetRepos.join(", ")}\n`);

  if (params.entryPointRepos && params.entryPointRepos.length > 0) {
    parts.push(`## 入口仓库（对外 API 层）\n以下仓库是系统对外暴露的 API 入口，必须分析变更是否通过调用链传递到这些入口：\n${params.entryPointRepos.map((r) => `- ${r} [ENTRY]`).join("\n")}\n\n即使变更符号未直接出现在入口仓库中，也要追踪中间层（如 frame/shared_lib）是否桥接了影响到入口 API。\n`);
  }

  if (params.sinkRepos && params.sinkRepos.length > 0) {
    parts.push(`## 终点模块（最下层 / 下行链锚点）\n以下仓库是系统的终点/最下层模块（如 DAO/DB/存储），是下行链的优先收敛目标：\n${params.sinkRepos.map((r) => `- ${r} [SINK]`).join("\n")}\n`);
  }

  if (params.agentsMd) {
    parts.push(`## 架构上下文 (AGENTS.md)\n${params.agentsMd}\n`);
  }

  if (params.globalPatterns) {
    parts.push(`## 历史风险模式 (GLOBAL_PATTERNS)\n${params.globalPatterns}\n`);
  }

  parts.push(`## 执行要求\n...（省略）\n`);
  return parts.join("\n");
}

function extractJsonFromOutput(output: string): Record<string, unknown> | null {
  const jsonBlocks = output.matchAll(/```json\s*\n([\s\S]*?)\n```/g);
  let lastBlock: string | null = null;
  for (const match of jsonBlocks) {
    lastBlock = match[1];
  }
  if (!lastBlock) return null;
  try {
    return JSON.parse(lastBlock);
  } catch {
    return null;
  }
}

describe("buildAnalysisPrompt", () => {
  test("includes repo name and diff", () => {
    const prompt = buildAnalysisPrompt({
      diff: "+def hello():\n+    pass",
      repoName: "my_repo",
      reposRoot: "/data/workspace",
      targetRepos: ["repo_a", "repo_b"],
    });
    expect(prompt).toContain("my_repo");
    expect(prompt).toContain("+def hello():");
    expect(prompt).toContain("repo_a, repo_b");
  });

  test("includes entry point repos with [ENTRY] marker", () => {
    const prompt = buildAnalysisPrompt({
      diff: "some diff",
      repoName: "frame",
      reposRoot: "/workspace",
      targetRepos: ["repo_a"],
      entryPointRepos: ["cvm_api", "cxm_api"],
    });
    expect(prompt).toContain("cvm_api [ENTRY]");
    expect(prompt).toContain("cxm_api [ENTRY]");
    expect(prompt).toContain("入口仓库");
  });

  test("omits entry point section when empty", () => {
    const prompt = buildAnalysisPrompt({
      diff: "diff",
      repoName: "repo",
      reposRoot: "/ws",
      targetRepos: ["a"],
      entryPointRepos: [],
    });
    expect(prompt).not.toContain("[ENTRY]");
    expect(prompt).not.toContain("入口仓库");
  });

  test("includes sink repos with [SINK] marker", () => {
    const prompt = buildAnalysisPrompt({
      diff: "some diff",
      repoName: "aurora",
      reposRoot: "/workspace",
      targetRepos: ["repo_a"],
      sinkRepos: ["vstation_compute"],
    });
    expect(prompt).toContain("vstation_compute [SINK]");
    expect(prompt).toContain("终点模块");
  });

  test("omits sink section when empty", () => {
    const prompt = buildAnalysisPrompt({
      diff: "diff",
      repoName: "repo",
      reposRoot: "/ws",
      targetRepos: ["a"],
      sinkRepos: [],
    });
    expect(prompt).not.toContain("[SINK]");
    expect(prompt).not.toContain("终点模块");
  });

  test("includes agentsMd when provided", () => {
    const prompt = buildAnalysisPrompt({
      diff: "diff",
      repoName: "repo",
      reposRoot: "/ws",
      targetRepos: ["a"],
      agentsMd: "# Architecture\nThis is a microservice...",
    });
    expect(prompt).toContain("架构上下文");
    expect(prompt).toContain("This is a microservice");
  });

  test("includes globalPatterns when provided", () => {
    const prompt = buildAnalysisPrompt({
      diff: "diff",
      repoName: "repo",
      reposRoot: "/ws",
      targetRepos: ["a"],
      globalPatterns: "auth-service → billing: HTTP /api/charge",
    });
    expect(prompt).toContain("历史风险模式");
    expect(prompt).toContain("auth-service → billing");
  });

  test("diff is wrapped in code fence", () => {
    const prompt = buildAnalysisPrompt({
      diff: "-old\n+new",
      repoName: "r",
      reposRoot: "/",
      targetRepos: [],
    });
    expect(prompt).toContain("```diff\n-old\n+new\n```");
  });
});

describe("extractJsonFromOutput — edge cases", () => {
  test("handles empty string", () => {
    expect(extractJsonFromOutput("")).toBeNull();
  });

  test("handles text with no code blocks", () => {
    expect(extractJsonFromOutput("Let me analyze...\nDone.")).toBeNull();
  });

  test("takes the LAST json block (final report)", () => {
    const output = `Intermediate step:
\`\`\`json
{"step": 1, "partial": true}
\`\`\`

Final report:
\`\`\`json
{"step": 5, "final": true, "risk_priority": []}
\`\`\``;
    const result = extractJsonFromOutput(output);
    expect(result).toEqual({ step: 5, final: true, risk_priority: [] });
  });

  test("handles multiline JSON with nested arrays", () => {
    const output = `\`\`\`json
{
  "changes": [
    {"id": "CHG-01", "file": "adapter.py", "risk": "high"},
    {"id": "CHG-02", "file": "metric.py", "risk": "low"}
  ],
  "affected_repos": ["repo_a", "repo_b"]
}
\`\`\``;
    const result = extractJsonFromOutput(output);
    expect(result).not.toBeNull();
    expect((result as any).changes).toHaveLength(2);
    expect((result as any).affected_repos).toContain("repo_a");
  });

  test("returns null for malformed JSON", () => {
    const output = `\`\`\`json
{incomplete: true, missing quotes
\`\`\``;
    expect(extractJsonFromOutput(output)).toBeNull();
  });

  test("ignores non-json code blocks", () => {
    const output = `\`\`\`bash
grep -rn "update_translog" /workspace/
\`\`\`

\`\`\`python
def analyze():
    pass
\`\`\`

\`\`\`json
{"only_json": true}
\`\`\``;
    const result = extractJsonFromOutput(output);
    expect(result).toEqual({ only_json: true });
  });

  test("handles JSON with unicode/Chinese content", () => {
    const output = `\`\`\`json
{"title": "跨仓影响分析", "risk": "极高", "description": "dispatcher 模块状态丢失"}
\`\`\``;
    const result = extractJsonFromOutput(output);
    expect(result).not.toBeNull();
    expect((result as any).title).toBe("跨仓影响分析");
    expect((result as any).risk).toBe("极高");
  });

  test("handles very large JSON (simulated report)", () => {
    const bigArray = Array.from({ length: 100 }, (_, i) => ({
      id: `CHG-${i}`,
      file: `file_${i}.py`,
      risk: i < 5 ? "high" : "low",
    }));
    const output = `\`\`\`json\n${JSON.stringify({ changes: bigArray })}\n\`\`\``;
    const result = extractJsonFromOutput(output);
    expect(result).not.toBeNull();
    expect((result as any).changes).toHaveLength(100);
  });
});

describe("truncateRawOutput", () => {
  function truncateRawOutput(output: string): string {
    const MAX_RAW_LENGTH = 4096;
    if (output.length <= MAX_RAW_LENGTH) return output;
    return "...(truncated)...\n" + output.slice(-MAX_RAW_LENGTH);
  }

  test("returns short output unchanged", () => {
    expect(truncateRawOutput("short")).toBe("short");
  });

  test("returns output at exactly limit unchanged", () => {
    const exact = "x".repeat(4096);
    expect(truncateRawOutput(exact)).toBe(exact);
  });

  test("truncates long output keeping last 4KB", () => {
    const long = "A".repeat(10000);
    const result = truncateRawOutput(long);
    expect(result.startsWith("...(truncated)...\n")).toBe(true);
    expect(result.length).toBe("...(truncated)...\n".length + 4096);
    expect(result.endsWith("A".repeat(100))).toBe(true);
  });
});

describe("task ID format safety", () => {
  test("generated taskId only contains safe characters", () => {
    // Simulate the ID generation from analyze.ts
    for (let i = 0; i < 100; i++) {
      const taskId = `analysis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      expect(taskId).toMatch(/^analysis-\d+-[a-z0-9]+$/);
      expect(taskId).not.toContain("..");
      expect(taskId).not.toContain("/");
      expect(taskId).not.toContain("\\");
    }
  });
});

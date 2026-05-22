/**
 * Pi Agent Integration — spawn pi in print mode for single-shot analysis.
 *
 * Uses `pi -p` (print mode) for Phase 1a:
 *   - Send prompt with diff + context → get analysis result
 *   - Simpler than RPC mode, sufficient for synchronous single-worker
 *
 * Phase 1b will upgrade to RPC mode for streaming + multi-worker.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AnalysisResult } from "@deepinsight/core";

export interface PiWorkerConfig {
  /** LLM provider (openai-compatible) */
  provider: string;
  /** Model identifier */
  model: string;
  /** API key */
  apiKey: string;
  /** Base URL for OpenAI-compatible endpoint */
  baseUrl: string;
  /** Working directory for pi agent (repo root) */
  cwd: string;
  /** Timeout in ms (default: 600_000 = 10 min) */
  timeoutMs?: number;
  /** Thinking level */
  thinkingLevel?: "off" | "low" | "medium" | "high";
  /** Path to SKILL.md to append as system prompt */
  skillPath?: string;
}

export interface PiWorkerResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

/**
 * Run pi agent in print mode with a given prompt.
 * Returns the full text output from pi.
 */
export async function runPiWorker(prompt: string, config: PiWorkerConfig): Promise<PiWorkerResult> {
  const startTime = Date.now();
  const timeoutMs = config.timeoutMs ?? 1_200_000; // 20 min default

  // Write prompt to temp file (avoids CLI ARG_MAX issues with large prompts)
  // Include SKILL.md content directly in the prompt file
  const promptFile = path.join(config.cwd, `.deepinsight-prompt-${Date.now()}.md`);
  let fullPrompt = prompt;
  if (config.skillPath && fs.existsSync(config.skillPath)) {
    const skillContent = fs.readFileSync(config.skillPath, "utf-8");
    fullPrompt = skillContent + "\n\n---\n\n" + prompt;
  }
  fs.writeFileSync(promptFile, fullPrompt, "utf-8");
  console.log(`[pi:setup] Wrote prompt file: ${promptFile} (${fullPrompt.length} chars)`);

  const args = [
    "-p", // print mode (non-interactive)
    "--provider", config.provider,
    "--model", config.model,
    "--api-key", config.apiKey,
    "--no-session", // don't save session
  ];

  // Add thinking level if specified (skip for providers that don't support it)
  // if (config.thinkingLevel && config.thinkingLevel !== "off") {
  //   args.push("--thinking", config.thinkingLevel);
  // }

  // Reference prompt file with @ syntax
  args.push(`@${promptFile}`);

  return new Promise<PiWorkerResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let lastActivity = Date.now();

    const proc = spawn("pi", args, {
      cwd: config.cwd,
      env: {
        ...process.env,
        OPENAI_API_KEY: config.apiKey,
        OPENAI_BASE_URL: config.baseUrl,
      },
      timeout: timeoutMs,
    });

    // Real-time stdout logging
    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      lastActivity = Date.now();

      // Log each chunk to container stdout for debugging
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const preview = text.slice(0, 200).replace(/\n/g, "\\n");
      console.log(`[pi:stdout +${elapsed}s] ${preview}${text.length > 200 ? "..." : ""}`);
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      lastActivity = Date.now();

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const preview = text.slice(0, 200).replace(/\n/g, "\\n");
      console.log(`[pi:stderr +${elapsed}s] ${preview}${text.length > 200 ? "..." : ""}`);
    });

    // Activity watchdog: log if no output for 60s
    const watchdog = setInterval(() => {
      const idle = Date.now() - lastActivity;
      if (idle > 60_000) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[pi:watchdog +${elapsed}s] No output for ${(idle / 1000).toFixed(0)}s, stdout size: ${stdout.length} bytes`);
      }
    }, 30_000);

    proc.on("close", (code) => {
      clearInterval(watchdog);
      // Clean up temp prompt file
      try { fs.unlinkSync(promptFile); } catch {}
      const durationMs = Date.now() - startTime;
      console.log(`[pi:exit] code=${code}, duration=${(durationMs / 1000).toFixed(1)}s, stdout=${stdout.length} bytes, stderr=${stderr.length} bytes`);

      if (code === 0) {
        resolve({ success: true, output: stdout, durationMs });
      } else {
        resolve({
          success: false,
          output: stdout,
          error: stderr || `pi exited with code ${code}`,
          durationMs,
        });
      }
    });

    proc.on("error", (err) => {
      clearInterval(watchdog);
      // Clean up temp prompt file
      try { fs.unlinkSync(promptFile); } catch {}
      const durationMs = Date.now() - startTime;
      console.log(`[pi:error] ${err.message}, duration=${(durationMs / 1000).toFixed(1)}s`);
      resolve({
        success: false,
        output: stdout,
        error: `spawn error: ${err.message}`,
        durationMs,
      });
    });
  });
}

/**
 * Build the analysis prompt for a given diff and context.
 */
export function buildAnalysisPrompt(params: {
  diff: string;
  repoName: string;
  reposRoot: string;
  targetRepos: string[];
  agentsMd?: string;
  globalPatterns?: string;
}): string {
  const parts: string[] = [];

  parts.push(`# 跨仓影响分析任务

## 变更仓库
${params.repoName}

## Diff 内容
\`\`\`diff
${params.diff}
\`\`\`

## 可分析的仓库目录
仓库根目录: ${params.reposRoot}
目标仓库: ${params.targetRepos.join(", ")}
`);

  if (params.agentsMd) {
    parts.push(`## 架构上下文 (AGENTS.md)
${params.agentsMd}
`);
  }

  if (params.globalPatterns) {
    parts.push(`## 历史风险模式 (GLOBAL_PATTERNS)
${params.globalPatterns}
`);
  }

  parts.push(`## 执行要求

按 SKILL.md 中的 5 步协议严格执行：

1. 解读 diff 语义，提取所有变更符号，判断初始风险
2. 使用 bash 工具运行 ast-grep 和 grep 构建完整跨仓调用链
3. 在调用链上传播风险（读取调用点代码判断领域上下文）
4. 检查测试覆盖
5. 输出结构化 JSON 报告

**输出格式**：最终结果用 \`\`\`json ... \`\`\` 包裹，确保可以被程序解析。
`);

  return parts.join("\n");
}

/**
 * Extract JSON result from pi agent's text output.
 * Looks for ```json ... ``` blocks.
 */
export function extractJsonFromOutput(output: string): Record<string, unknown> | null {
  // Match the last ```json ... ``` block (final report)
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

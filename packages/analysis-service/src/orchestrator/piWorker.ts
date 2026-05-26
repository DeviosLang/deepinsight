/**
 * Pi Agent Integration — RPC mode (Phase 1b)
 *
 * Spawns `pi --mode rpc` as a child process and communicates via stdin/stdout
 * JSON protocol as defined in §13 of the design doc.
 *
 * Benefits over `-p` mode:
 * - Full tool execution loop (bash, grep, find, read)
 * - Real-time event streaming for observability
 * - Graceful abort via protocol (not SIGKILL)
 * - Working directory context allows pi to access all repos
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { AnalysisResult } from "@deepinsight/core";

export interface PiWorkerConfig {
  /** LLM provider name for pi's --provider flag */
  provider: string;
  /** Model identifier */
  model: string;
  /** API key */
  apiKey: string;
  /** Base URL for OpenAI-compatible endpoint */
  baseUrl: string;
  /** Working directory for pi agent (should be workspace root so pi can access all repos) */
  cwd: string;
  /** Timeout in ms (default: 600_000 = 10 min) */
  timeoutMs?: number;
  /** Thinking level */
  thinkingLevel?: "off" | "low" | "medium" | "high";
  /** Path to SKILL.md to prepend to prompt */
  skillPath?: string;
}

export interface PiWorkerResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
  /** Token usage from pi (if reported) */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  /** Number of tool calls executed */
  toolCallCount?: number;
  /** Number of turns */
  turnCount?: number;
}

/** Represents a single event from pi's JSON event stream */
interface PiEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Run pi agent in RPC mode with a given prompt.
 * Communicates via stdin/stdout JSON protocol.
 */
export async function runPiWorker(prompt: string, config: PiWorkerConfig): Promise<PiWorkerResult> {
  const startTime = Date.now();
  const timeoutMs = config.timeoutMs ?? 600_000; // 10 min default

  // Prepend SKILL.md content to prompt
  let fullPrompt = prompt;
  if (config.skillPath && fs.existsSync(config.skillPath)) {
    const skillContent = fs.readFileSync(config.skillPath, "utf-8");
    fullPrompt = skillContent + "\n\n---\n\n" + prompt;
  }

  console.log(`[pi:rpc] Starting pi --mode rpc, prompt size: ${fullPrompt.length} chars, cwd: ${config.cwd}`);

  const args = [
    "--mode", "rpc",
    "--provider", config.provider,
    "--model", config.model,
    "--api-key", config.apiKey,
    "--no-session",
    "--tools", "read,grep,find,bash", // restrict to read-only tools for safety
  ];

  // Add thinking level if specified
  if (config.thinkingLevel && config.thinkingLevel !== "off") {
    args.push("--thinking", config.thinkingLevel);
  }

  return new Promise<PiWorkerResult>((resolve) => {
    let textOutput = "";
    let lastAssistantText = ""; // Track each assistant message separately
    let lastEventType = "";
    let lastActivity = Date.now();
    let toolCallCount = 0;
    let turnCount = 0;
    let usage: PiWorkerResult["usage"];
    let resolved = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let promptSent = false;

    const proc: ChildProcess = spawn("pi", args, {
      cwd: config.cwd,
      env: {
        ...process.env,
        OPENAI_API_KEY: config.apiKey,
        OPENAI_BASE_URL: config.baseUrl,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Send prompt after pi is ready (triggered by "session" event in rl.on("line"))
    const sendPrompt = () => {
      if (promptSent) return;
      promptSent = true;
      const promptCommand = JSON.stringify({ type: "prompt", message: fullPrompt });
      proc.stdin?.write(promptCommand + "\n");
      console.log(`[pi:rpc] Sent prompt command via stdin (${promptCommand.length} chars)`);
    };

    // Steer timer: send "wrap up" message before timeout to ensure pi outputs final report
    const steerDelayMs = Math.max(timeoutMs - 100_000, timeoutMs * 0.85); // 100s before timeout, or 85% of timeout
    const steerTimer = setTimeout(() => {
      if (resolved) return;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[pi:steer +${elapsed}s] Sending wrap-up steer message (${Math.round((timeoutMs - steerDelayMs) / 1000)}s before timeout)`);
      try {
        const steerCmd = JSON.stringify({
          type: "steer",
          message: "时间即将用完。请立即停止搜索，基于已收集到的信息输出最终 JSON 报告。用 ```json ... ``` 包裹。",
        });
        proc.stdin?.write(steerCmd + "\n");
      } catch {}
    }, steerDelayMs);

    // Timeout handler: send abort then force kill
    const timeoutHandle = setTimeout(() => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[pi:timeout +${elapsed}s] Worker timeout (${timeoutMs / 1000}s), sending abort...`);

      // Try graceful abort first
      try {
        proc.stdin?.write(JSON.stringify({ type: "abort" }) + "\n");
      } catch {}

      // Force kill after 5s if not exited
      killTimer = setTimeout(() => {
        if (!resolved) {
          console.log(`[pi:timeout] Force killing after abort grace period`);
          proc.kill("SIGKILL");
        }
      }, 5000);
    }, timeoutMs);

    // Activity watchdog: log if no output for 60s
    const watchdog = setInterval(() => {
      const idle = Date.now() - lastActivity;
      if (idle > 60_000) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[pi:watchdog +${elapsed}s] No output for ${(idle / 1000).toFixed(0)}s, lastEvent: ${lastEventType}, textOutput: ${textOutput.length} chars, toolCalls: ${toolCallCount}`);
      }
    }, 30_000);

    // Parse stdout line by line (each line is a JSON event)
    const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });

    rl.on("line", (line: string) => {
      if (!line.trim()) return;
      lastActivity = Date.now();

      try {
        const event: PiEvent = JSON.parse(line);
        lastEventType = event.type;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        switch (event.type) {
          case "session":
            console.log(`[pi:event +${elapsed}s] session started (id: ${event.id})`);
            // Pi is ready — send the prompt now
            sendPrompt();
            break;

          case "agent_start":
            console.log(`[pi:event +${elapsed}s] agent_start`);
            break;

          case "turn_start":
            turnCount++;
            console.log(`[pi:event +${elapsed}s] turn_start (#${turnCount})`);
            break;

          case "turn_end":
            if (event.usage && typeof event.usage === "object") {
              const u = event.usage as Record<string, number>;
              usage = {
                inputTokens: (usage?.inputTokens ?? 0) + (u.inputTokens ?? 0),
                outputTokens: (usage?.outputTokens ?? 0) + (u.outputTokens ?? 0),
              };
            }
            console.log(`[pi:event +${elapsed}s] turn_end (tokens: ${JSON.stringify(usage ?? {})})`);
            break;

          case "tool_execution_start":
            toolCallCount++;
            console.log(`[pi:event +${elapsed}s] tool_start: ${event.toolName} #${toolCallCount}`);
            break;

          case "tool_execution_end":
            console.log(`[pi:event +${elapsed}s] tool_end: ${event.toolName}`);
            break;

          case "message_start":
            // Log user/assistant message starts; reset accumulator for new assistant message
            if (event.message && typeof event.message === "object") {
              const msg = event.message as Record<string, unknown>;
              console.log(`[pi:event +${elapsed}s] message_start (${msg.role})`);
              if (msg.role === "assistant") {
                lastAssistantText = ""; // Reset for new assistant message
              }
            }
            break;

          case "message_update":
            // Accumulate text deltas from assistant
            if (event.assistantMessageEvent && typeof event.assistantMessageEvent === "object") {
              const ame = event.assistantMessageEvent as Record<string, unknown>;
              if (ame.type === "text_delta" && typeof ame.delta === "string") {
                lastAssistantText += ame.delta;
              }
            }
            break;

          case "message_end":
            // Extract full text from assistant message
            if (event.message && typeof event.message === "object") {
              const msg = event.message as Record<string, unknown>;
              if (msg.role === "assistant" && Array.isArray(msg.content)) {
                const texts = (msg.content as Array<{ type: string; text?: string }>)
                  .filter((c) => c.type === "text" && c.text)
                  .map((c) => c.text!);
                if (texts.length > 0) {
                  lastAssistantText = texts.join("\n");
                }
                // Append this assistant message to total output (multi-turn accumulation)
                if (lastAssistantText.length > 0) {
                  textOutput += lastAssistantText + "\n";
                }
              }
            }
            console.log(`[pi:event +${elapsed}s] message_end (lastAssistant: ${lastAssistantText.length} chars, totalOutput: ${textOutput.length} chars)`);
            break;

          case "agent_end":
            console.log(`[pi:event +${elapsed}s] agent_end (turns: ${turnCount}, toolCalls: ${toolCallCount}, output: ${textOutput.length} chars)`);
            // Agent finished — close stdin to let pi process exit
            try { proc.stdin?.end(); } catch {}
            break;

          case "error":
            console.log(`[pi:event +${elapsed}s] error: ${event.message ?? JSON.stringify(event)}`);
            break;

          case "fatal":
            console.log(`[pi:event +${elapsed}s] FATAL: ${event.message ?? JSON.stringify(event)}`);
            break;

          default:
            // Don't log every text_delta, message_update etc to avoid noise
            break;
        }
      } catch {
        // Non-JSON line (rare in RPC mode)
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[pi:raw +${elapsed}s] ${line.slice(0, 120)}`);
      }
    });

    // Stderr logging
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      lastActivity = Date.now();
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const preview = text.slice(0, 200).replace(/\n/g, "\\n");
      console.log(`[pi:stderr +${elapsed}s] ${preview}${text.length > 200 ? "..." : ""}`);
    });

    proc.on("close", (code) => {
      resolved = true;
      clearTimeout(timeoutHandle);
      clearTimeout(steerTimer);
      if (killTimer) clearTimeout(killTimer);
      clearInterval(watchdog);
      const durationMs = Date.now() - startTime;
      console.log(`[pi:exit] code=${code}, duration=${(durationMs / 1000).toFixed(1)}s, output=${textOutput.length} chars, turns=${turnCount}, toolCalls=${toolCallCount}`);

      if (code === 0 || textOutput.length > 0) {
        resolve({ success: true, output: textOutput, durationMs, usage, toolCallCount, turnCount });
      } else {
        resolve({
          success: false,
          output: textOutput,
          error: `pi exited with code ${code}`,
          durationMs,
          usage,
          toolCallCount,
          turnCount,
        });
      }
    });

    proc.on("error", (err) => {
      resolved = true;
      clearTimeout(timeoutHandle);
      clearTimeout(steerTimer);
      if (killTimer) clearTimeout(killTimer);
      clearInterval(watchdog);
      const durationMs = Date.now() - startTime;
      console.log(`[pi:error] ${err.message}, duration=${(durationMs / 1000).toFixed(1)}s`);
      resolve({
        success: false,
        output: textOutput,
        error: `spawn error: ${err.message}`,
        durationMs,
      });
    });

    // Fallback: if pi doesn't emit "session" event within 3s, send prompt anyway
    setTimeout(() => {
      if (!promptSent) {
        console.log(`[pi:rpc] No session event after 3s, sending prompt as fallback`);
        sendPrompt();
      }
    }, 3000);
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
  entryPointRepos?: string[];
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

  // Entry point repos section
  if (params.entryPointRepos && params.entryPointRepos.length > 0) {
    parts.push(`## 入口仓库（对外 API 层）
以下仓库是系统对外暴露的 API 入口，必须分析变更是否通过调用链传递到这些入口：
${params.entryPointRepos.map((r) => `- ${r} [ENTRY]`).join("\n")}

即使变更符号未直接出现在入口仓库中，也要追踪中间层（如 frame/shared_lib）是否桥接了影响到入口 API。
`);
  }

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

按 SKILL.md 中的协议执行：

1. 解读 diff 语义，提取所有变更符号，判断初始风险
2. 使用 bash 工具运行 grep/find/ast-grep 在目标仓库中搜索调用点，构建完整跨仓调用链
3. 在调用链上传播风险（读取调用点代码判断领域上下文）
4. 检查测试覆盖
5. 输出结构化 JSON 报告（含调用链、影响范围、风险等级）
6. 对每个 P0/P1 风险项和每个受影响的入口 API，生成测试验证场景：
   - scenario: 测试场景名称
   - affected_api: 入口 API 路径（如 POST /api/v2/instance/action）
   - api_params: 该 API 的请求参数示例（从入口仓库代码中读取 handler/view 的参数定义，提取必填参数和触发该风险路径所需的参数组合）
   - preconditions: 前置依赖列表（DB 状态、MQ 配置、服务依赖、数据准备）
   - steps: 从入口 API 开始的执行步骤（含具体参数值）
   - oracle: 观察点和验证规则（具体 DB 字段变化、日志关键字、HTTP 返回码、监控指标变化）

**api_params 提取方法**：对每个 affected_api，在入口仓库中用 grep/find 找到对应的 handler 函数，读取其参数定义（如 request body schema、query params、path params），给出能触发该风险路径的参数组合示例。

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

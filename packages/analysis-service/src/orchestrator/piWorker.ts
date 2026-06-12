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
 *
 * @param signal - Optional AbortSignal. If aborted, the child process is
 *   sent SIGTERM, all timers/readline are cleaned up, and the promise
 *   resolves with success=false. Without this, callers that time out or
 *   are cancelled cannot stop the spawned pi process and timers leak.
 */
export async function runPiWorker(
  prompt: string,
  config: PiWorkerConfig,
  signal?: AbortSignal,
): Promise<PiWorkerResult> {
  const startTime = Date.now();
  const timeoutMs = config.timeoutMs ?? 600_000; // 10 min default

  // Fast-path: caller already aborted before we spawned anything.
  if (signal?.aborted) {
    return {
      success: false,
      output: "",
      error: "aborted before start",
      durationMs: 0,
    };
  }

  // Prepend SKILL.md content to prompt.
  // Hard cap on file size: a malformed/binary skill file would otherwise be
  // read fully into memory and prepended to every analysis prompt.
  const SKILL_MAX_BYTES = 512 * 1024; // 512KB — generous for any reasonable SKILL.md
  let fullPrompt = prompt;
  if (config.skillPath && fs.existsSync(config.skillPath)) {
    try {
      const stat = fs.statSync(config.skillPath);
      if (stat.size > SKILL_MAX_BYTES) {
        console.warn(
          `[pi:rpc] Skill file ${config.skillPath} exceeds ${SKILL_MAX_BYTES} bytes (${stat.size}); skipping prepend`,
        );
      } else {
        const skillContent = fs.readFileSync(config.skillPath, "utf-8");
        fullPrompt = skillContent + "\n\n---\n\n" + prompt;
      }
    } catch (err) {
      console.warn(
        `[pi:rpc] Failed to read skill file ${config.skillPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
    /**
     * Tracks the last time pi emitted assistant text (message_update text_delta
     * or message_end). Used by the timeout handler to avoid SIGKILLing pi
     * mid-stream when it's currently writing the final JSON report — the most
     * common cause of truncated reports.
     */
    let lastAssistantUpdateAt = 0;
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

    // Timeout handler: send abort then force kill.
    //
    // Race-with-steer guard: when steer fired ~85s before this timeout, pi may
    // STILL be streaming the final JSON report. SIGKILLing it mid-stream is
    // the most common cause of truncated reports. So if assistant tokens were
    // produced within the last 8s, we defer the abort sequence by an extra
    // grace window (one-shot — won't loop forever).
    let timeoutDeferred = false;
    // eslint-disable-next-line prefer-const -- reassigned by deferral path below
    let timeoutHandle: ReturnType<typeof setTimeout> = setTimeout(() => runTimeoutAbort(), timeoutMs);
    const STREAM_GRACE_MS = 15_000;
    const STREAM_LIVENESS_MS = 8_000;
    const runTimeoutAbort = () => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const idleSinceStream = lastAssistantUpdateAt > 0 ? Date.now() - lastAssistantUpdateAt : Number.POSITIVE_INFINITY;

      if (!timeoutDeferred && idleSinceStream < STREAM_LIVENESS_MS) {
        timeoutDeferred = true;
        console.log(`[pi:timeout +${elapsed}s] Deferring abort by ${STREAM_GRACE_MS / 1000}s — pi still streaming (last token ${(idleSinceStream / 1000).toFixed(1)}s ago)`);
        timeoutHandle = setTimeout(runTimeoutAbort, STREAM_GRACE_MS);
        return;
      }

      console.log(`[pi:timeout +${elapsed}s] Worker timeout (${timeoutMs / 1000}s${timeoutDeferred ? " + grace" : ""}), sending abort...`);

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
    };

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

    // Stream-level error handlers: without these, an EPIPE/ECONNRESET on the
    // child's stdio would surface as an unhandledRejection / uncaughtException
    // and partial results would be silently treated as success.
    proc.stdout?.on("error", (err: Error) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[pi:stdout-error +${elapsed}s] ${err.message}`);
    });
    proc.stderr?.on("error", (err: Error) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[pi:stderr-error +${elapsed}s] ${err.message}`);
    });
    proc.stdin?.on("error", (err: Error) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[pi:stdin-error +${elapsed}s] ${err.message}`);
    });
    rl.on("error", (err: Error) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[pi:readline-error +${elapsed}s] ${err.message}`);
    });

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
                lastAssistantUpdateAt = Date.now();
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
                  lastAssistantUpdateAt = Date.now();
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

    // Centralised cleanup so close/error/abort all release the same resources.
    // Without this, an aborted Promise would leave timers and the readline
    // interface live, holding fds and references to the child process.
    let abortListener: (() => void) | null = null;
    const cleanup = () => {
      clearTimeout(timeoutHandle);
      clearTimeout(steerTimer);
      if (killTimer) clearTimeout(killTimer);
      clearInterval(watchdog);
      try { rl.close(); } catch {}
      if (signal && abortListener) {
        try { signal.removeEventListener("abort", abortListener); } catch {}
      }
    };

    // Abort handler — triggered when caller cancels via AbortSignal.
    if (signal) {
      abortListener = () => {
        if (resolved) return;
        resolved = true;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[pi:abort +${elapsed}s] AbortSignal received, terminating pi process`);
        cleanup();
        try { proc.kill("SIGTERM"); } catch {}
        // Give the child 2s to exit cleanly, then SIGKILL.
        setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch {}
        }, 2000).unref();
        const durationMs = Date.now() - startTime;
        resolve({
          success: false,
          output: textOutput,
          error: "aborted by caller",
          durationMs,
          usage,
          toolCallCount,
          turnCount,
        });
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }

    proc.on("close", (code) => {
      if (resolved) return; // already handled (e.g. via abort)
      resolved = true;
      cleanup();
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
      if (resolved) return;
      resolved = true;
      cleanup();
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
  sinkRepos?: string[];
  agentsMd?: string;
  globalPatterns?: string;
  /**
   * Knowledge bases pi can query on demand via `graphify query`. Each entry is
   * advertised in the prompt with its name + description + graph.json path so
   * pi can decide which (if any) to consult while building the analysis.
   */
  knowledgeBases?: Array<{
    name: string;
    description: string;
    /** Routing hints — pi matches diff content against these */
    keywords: string[];
    graphPath: string;
  }>;
  /**
   * Pre-fetched knowledge base results (Phase 1.5 T0 pre-flight).
   * Service layer queried these before spawning pi; injected as background
   * context so pi has answers from the first reasoning turn.
   */
  kbPrefetchResults?: Array<{
    name: string;
    description: string;
    query: string;
    answer: string;
  }>;
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
${params.entryPointRepos.map((r) => `- ${r}`).join("\n")}

即使变更符号未直接出现在入口仓库中，也要追踪中间层（如 frame/shared_lib）是否桥接了影响到入口 API。

**输出时**：在 \`call_tree\` 中标记入口节点为 \`is_entry: true\`，并按规则填 \`entry_kind\`/\`entry_route\`（详见 SKILL.md Step 5）。**不要**在 \`domain_context\` 中写 \`[ENTRY]\` 文本。
`);
  }

  // Sink repos section (downstream-chain convergence anchors)
  if (params.sinkRepos && params.sinkRepos.length > 0) {
    parts.push(`## 终点模块（最下层 / 下行链锚点）
以下仓库是系统的终点/最下层模块（如 DAO/DB/存储），是下行链的优先收敛目标：
${params.sinkRepos.map((r) => `- ${r}`).join("\n")}

构建下行链：从变更符号向下游 callee 追踪，检查变更点对下游的调用是否仍满足契约（参数/schema/事务）。
追踪终止条件（每条路径独立判定，满足任一即停）：
1. callee 属于终点仓 → 在 \`downstream_contracts[].sink\` 写入 \`{type, repo, priority, severity}\`；
2. callee 无下游调用（叶子）→ 自然停，\`sink: null\`；
3. 深度 ≥ 2 且该路径未朝终点收敛 → 剪枝停，\`sink: null\`；
4. 深度 ≥ 4（绝对护栏）→ 无条件停。
即终点仓是优先收敛目标、可突破深度 2 追到（上限 4）；深度 2 仅是"既没到 sink、又判断不出朝 sink 走"时的兜底剪枝。
\`status\` 取值：\`satisfied\` / \`uncertain\` / \`violated\`（注意是 \`satisfied\`，不是 \`ok\`）。
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

  // Phase 1.5: inject pre-fetched KB results as background context.
  // These were queried by the service layer before spawning pi (T0 pre-flight),
  // so pi has the answers immediately without needing extra tool-call rounds.
  if (params.kbPrefetchResults && params.kbPrefetchResults.length > 0) {
    const lines: string[] = [];
    lines.push("## 背景知识（已预检索）");
    lines.push("");
    lines.push("以下内容由系统在分析开始前根据 diff 关键词自动检索，可直接使用，无需重复查询：");
    lines.push("");
    for (const r of params.kbPrefetchResults) {
      lines.push(`### ${r.name} — ${r.description}`);
      lines.push(`> 检索问题：${r.query}`);
      lines.push("");
      lines.push(r.answer);
      lines.push("");
    }
    parts.push(lines.join("\n"));
  }
  // These are background corpora (design docs, runbooks, glossaries) that pi
  // can consult on demand — NOT injected directly to keep the prompt small.
  // Each library carries `keywords` so pi can route a query to the right one
  // based on diff content (architecture concept → design_docs, API change →
  // apidocs, risk assessment → bug archives, etc.).
  if (params.knowledgeBases && params.knowledgeBases.length > 0) {
    const lines: string[] = [];
    lines.push("## 可用知识库 (graphify)");
    lines.push("");
    lines.push("以下知识库已构建语义图谱。**仅在分析需要外部背景知识时**主动调用，每个库针对不同问题：");
    lines.push("");
    lines.push("| 知识库 | 适用问题 | 触发关键词 |");
    lines.push("|---|---|---|");
    for (const kb of params.knowledgeBases) {
      const kw = kb.keywords.length > 0 ? kb.keywords.join("、") : "（无）";
      // Escape pipe in description to keep table valid.
      const desc = kb.description.replace(/\|/g, "\\|");
      lines.push(`| \`${kb.name}\` | ${desc} | ${kw} |`);
    }
    lines.push("");
    lines.push("**调用方式：**");
    lines.push("```bash");
    lines.push('graphify query "<concept-or-question>" --graph <graph-path> --budget 1500');
    lines.push("```");
    lines.push("");
    lines.push("**graph-path 取值：**");
    for (const kb of params.knowledgeBases) {
      lines.push(`- \`${kb.name}\` → \`${kb.graphPath}\``);
    }
    lines.push("");
    lines.push("**路由策略（按 diff 内容匹配）：**");
    lines.push("1. diff 涉及陌生模块/想了解架构决策 → `cvm_design_docs`");
    lines.push("2. diff 涉及业务概念（实例规格、镜像、计费、资源池）→ `cvm_domain`");
    lines.push("3. diff 修改对外 API 入参/返回/错误码 → `cvm_apidocs`");
    lines.push("4. 评估发布期风险、查历史故障 → `cvm_released_bugs`");
    lines.push("5. 查日常迭代相似 bug、同类需求 → `cvm_tapd_bugs`");
    lines.push("");
    lines.push("**调用约束：**");
    lines.push("- 每次查询消耗约 1500 token；每个分析任务建议 ≤ 3 次查询");
    lines.push("- 同一概念只查最相关的一个库，不要广撒网");
    lines.push("- 若 diff + AGENTS.md 已足够，**无需查询**");
    lines.push("");
    parts.push(lines.join("\n"));
  }

  parts.push(`## 执行要求

按 SKILL.md 中的协议执行：

1. 解读 diff 语义，提取所有变更符号（忽略 test_*/Test* 测试函数），判断初始风险
2. 使用 bash 工具运行 grep/find 在目标仓库中搜索调用点，构建完整跨仓调用链
3. **必须追踪从入口仓库到变更符号的完整调用路径**（包括通过 MQ/HTTP/框架调度的间接链路）
4. **构建下行链**：从变更符号向下游 callee 追踪，检查对下游的调用契约是否仍成立，优先收敛到终点仓（见上方终止条件），输出 \`downstream_contracts\`
5. 在调用链上传播风险（读取调用点代码判断领域上下文）
6. 检查测试覆盖
7. 输出结构化 JSON 报告（**cross-repo-impact/2.0** schema，见 SKILL.md Step 5）

**输出格式（严格遵守，否则结果会丢失）**：
- 最终结果必须用 \`\`\`json ... \`\`\` 包裹
- 顶层必须有 \`schema_version: "cross-repo-impact/2.0"\`、\`meta\`、\`changes\`、\`symbols\`、\`test_scenarios\`、\`unanalyzable\`
- 所有字段名是 **snake_case**（如 \`call_tree\`、\`risk_table\`、\`downstream_contracts\`、\`diff_semantic\`、\`initial_severity\`）
- 每个 \`symbols[]\` 必须有 \`id\`（\`SYM-001\`/\`SYM-002\`...）；\`test_scenarios[].id\` 用 \`RT-NNN\`；\`unanalyzable[].id\` 用 \`UA-NNN\`
- \`call_tree\` 入口节点用 \`is_entry: true\` + \`entry_kind\` + \`entry_route\`（**禁止** \`[ENTRY]\` 字符串标记）
- \`risk_table[]\` 同时填 \`priority\`（P0..P3）和 \`severity\`（high/medium/low）
- \`downstream_contracts[]\`：\`status\` 用 \`satisfied\`/\`uncertain\`/\`violated\`；触达 sink 时 \`sink\` 填对象，否则 \`sink: null\`
- \`test_scenarios[]\`：\`oracle\` 字典已废弃，改用 \`assertions[]\` 数组（每项一个闭合枚举 \`kind\`）；\`risk_change_ids\` 是数组、值为 \`SYM-NNN\` id；\`target_api\` 是结构化对象
- \`unanalyzable[]\` 是结构化对象数组（带 \`id\`/\`category\`/\`subject\`/\`implication\`/\`suggested_handling\`），不是字符串列表
- 严格按 SKILL.md Step 5 的 schema 示例输出
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

/**
 * Run pi worker with exponential backoff retry + model fallback.
 *
 * Retry strategy:
 * - Up to 3 attempts total
 * - Exponential backoff: 2s, 4s, 8s between attempts
 * - On 2nd failure: if fallbackModel configured, switch to it
 * - On timeout: no retry (return partial result immediately)
 */
export async function runPiWorkerWithRetry(
  prompt: string,
  config: PiWorkerConfig & { fallbackModel?: string },
  signal?: AbortSignal,
): Promise<PiWorkerResult> {
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 2000;

  let lastResult: PiWorkerResult | null = null;
  let currentConfig = { ...config };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) {
      return lastResult ?? { success: false, output: "", error: "aborted", durationMs: 0 };
    }

    lastResult = await runPiWorker(prompt, currentConfig, signal);

    // Success — return immediately
    if (lastResult.success) {
      if (attempt > 1) {
        console.log(`[pi:retry] Succeeded on attempt ${attempt}${currentConfig.model !== config.model ? ` (fallback model: ${currentConfig.model})` : ""}`);
      }
      return lastResult;
    }

    // Timeout — don't retry, return partial result
    const isTimeout = lastResult.error?.includes("timeout") || (lastResult.durationMs >= (config.timeoutMs ?? 600_000) * 0.95);
    if (isTimeout) {
      console.log(`[pi:retry] Timeout on attempt ${attempt}, returning partial result`);
      return lastResult;
    }

    // Last attempt — don't retry
    if (attempt >= MAX_RETRIES) {
      console.log(`[pi:retry] Failed after ${MAX_RETRIES} attempts: ${lastResult.error}`);
      return lastResult;
    }

    // Switch to fallback model on 2nd failure
    if (attempt >= 2 && config.fallbackModel && currentConfig.model !== config.fallbackModel) {
      console.log(`[pi:retry] Switching to fallback model: ${config.fallbackModel}`);
      currentConfig = { ...currentConfig, model: config.fallbackModel };
    }

    // Exponential backoff with jitter
    const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1) * (0.75 + Math.random() * 0.5);
    console.log(`[pi:retry] Attempt ${attempt} failed (${lastResult.error}), retrying in ${Math.round(delay)}ms...`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  return lastResult ?? { success: false, output: "", error: "all retries exhausted", durationMs: 0 };
}

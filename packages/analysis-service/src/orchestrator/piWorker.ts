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
  /**
   * Per-tool execution records — emitted under `tool_execution_start/end`.
   * Used by observability/trace.ts to publish sub-spans under the piWorker
   * span so the Opik trace tree shows what each pi turn actually did
   * (graphify queries, grep, file reads, etc.).
   *
   * `endTime` is undefined when the worker was killed mid-tool (timeout/abort);
   * the trace flusher should treat those as `endTime = Date.now()` and tag
   * them as truncated.
   */
  toolEvents?: ToolEvent[];
}

export interface ToolEvent {
  /** Tool name as reported by pi (e.g. "Bash", "Read", "graphify_query") */
  tool: string;
  /** ms since epoch */
  startTime: number;
  /** ms since epoch — undefined if process was killed before tool_execution_end */
  endTime?: number;
  /** Turn this tool ran in (1-based, matches turn_start counter) */
  turn: number;
  /** Optional short summary of the tool input (truncated) for span metadata */
  inputPreview?: string;
}

/** Represents a single event from pi's JSON event stream */
interface PiEvent {
  type: string;
  __inflightKey?: string;
  [key: string]: unknown;
}

/**
 * Build a short, span-friendly summary of a tool_execution_start payload.
 * pi reports tool inputs differently per tool (Bash → command, Read → file_path,
 * graphify_query → query); we sniff the common shapes and truncate aggressively
 * — these strings end up in Opik span metadata, which has tight size limits.
 */
function summarizeToolInput(event: PiEvent): string | undefined {
  const candidates: Array<unknown> = [
    (event as Record<string, unknown>).command,
    (event as Record<string, unknown>).query,
    (event as Record<string, unknown>).file_path,
    (event as Record<string, unknown>).path,
    (event as Record<string, unknown>).pattern,
    (event as Record<string, unknown>).input,
    (event as Record<string, unknown>).args,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) {
      return c.length > 200 ? c.slice(0, 200) + "…" : c;
    }
  }
  // Fallback: stringify the input object minus noisy fields
  const inp = (event as Record<string, unknown>).toolInput ?? (event as Record<string, unknown>).input;
  if (inp && typeof inp === "object") {
    try {
      const json = JSON.stringify(inp);
      return json.length > 200 ? json.slice(0, 200) + "…" : json;
    } catch {
      return undefined;
    }
  }
  return undefined;
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

  // Write a minimal MCP config to pass via --mcp-config.
  // NOTE: In pi ≥ 0.79, --mcp-config overrides ~/.pi/agent/mcp.json so the
  // context-mode MCP server is bypassed for RPC workers. In older versions this
  // did not fully override the agent-level config. The real fix is upgrading pi
  // in the Dockerfile. This file is still written as a belt-and-suspenders guard.
  const emptyMcpPath = "/tmp/pi-rpc-empty-mcp.json";
  try {
    fs.writeFileSync(emptyMcpPath, JSON.stringify({ mcpServers: {} }), "utf-8");
  } catch {
    // Non-fatal: if we can't write, omit the flag and let pi use its default config
  }

  const args = [
    "--mode", "rpc",
    "--provider", config.provider,
    "--model", config.model,
    "--api-key", config.apiKey,
    "--no-session",
    "--tools", "read,grep,find,bash", // restrict to read-only tools for safety
    "--no-lens",                       // skip LSP server startup (not needed for analysis)
  ];

  // Override MCP config with empty file to bypass context-mode startup delay
  if (fs.existsSync(emptyMcpPath)) {
    args.push("--mcp-config", emptyMcpPath);
  }

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
    /**
     * In-flight tool executions by tool name. pi reports start/end as separate
     * events; we pair them up here. If a tool starts but never ends (process
     * killed mid-call), the entry stays in toolEvents with endTime=undefined
     * — flushTrace can then tag the span as truncated.
     */
    const toolEvents: ToolEvent[] = [];
    const inflightTools = new Map<string, ToolEvent>();
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

    // Session watchdog: if pi doesn't emit "session" within 10s after the last
    // extension_ui_request was acked, send the prompt anyway. In pi 0.79.x,
    // bindExtensions() → emit(session_start) can block for minutes inside
    // extension handlers, but pi still reads stdin and queues commands — so
    // sending the prompt early is safe and avoids the 45s kill-and-retry cycle.
    // The watchdog is reset every time an extension_ui_request is acked.
    let sessionWatchdogHandle: ReturnType<typeof setTimeout> | null = null;
    const SESSION_PROMPT_DELAY_MS = 2_000; // 2s after last ack → send prompt
    const armSessionWatchdog = () => {
      if (sessionWatchdogHandle) clearTimeout(sessionWatchdogHandle);
      sessionWatchdogHandle = setTimeout(() => {
        sessionWatchdogHandle = null;
        if (!promptSent) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`[pi:session-watchdog +${elapsed}s] No session after ${SESSION_PROMPT_DELAY_MS / 1000}s — sending prompt early (pi 0.79.x queues cmds before session)`);
          sendPrompt();
        }
      }, SESSION_PROMPT_DELAY_MS);
    };
    // Arm immediately so a prompt is sent even if no extension_ui_request fires
    armSessionWatchdog();

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
            {
              const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
              const inputPreview = summarizeToolInput(event);
              const evt: ToolEvent = {
                tool: toolName,
                startTime: Date.now(),
                turn: Math.max(turnCount, 1),
                inputPreview,
              };
              toolEvents.push(evt);
              // Use a key per (tool,index) so concurrent tool calls (rare but
              // possible if pi parallelizes) don't clobber each other.
              inflightTools.set(`${toolName}#${toolCallCount}`, evt);
              event.__inflightKey = `${toolName}#${toolCallCount}`;
            }
            console.log(`[pi:event +${elapsed}s] tool_start: ${event.toolName} #${toolCallCount}`);
            break;

          case "tool_execution_end":
            {
              const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
              // Find the most recent in-flight entry for this tool. Without a
              // matching key on the end event we fall back to the last-started
              // matching tool — pi's RPC schema doesn't carry an id on the
              // end event today.
              let endedKey: string | undefined;
              for (const [key, evt] of [...inflightTools.entries()].reverse()) {
                if (evt.tool === toolName) { endedKey = key; break; }
              }
              if (endedKey) {
                const evt = inflightTools.get(endedKey)!;
                evt.endTime = Date.now();
                inflightTools.delete(endedKey);
              }
            }
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

          case "extension_ui_request":
            // Pi-subagents and other extensions register TUI widgets. In RPC mode pi
            // emits these as `extension_ui_request` and waits for an
            // `extension_ui_response` before proceeding (including before emitting
            // the `session` event). Without a response the session init stalls
            // indefinitely. Send an empty ack so pi can continue.
            // Also re-arm the session watchdog: after the last ack + 2s of silence,
            // the prompt will be sent automatically (pi 0.79.x queues commands).
            if (event.id) {
              try {
                proc.stdin?.write(
                  JSON.stringify({ type: "extension_ui_response", id: event.id }) + "\n",
                );
              } catch {}
              armSessionWatchdog();
            }
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
      if (sessionWatchdogHandle) { clearTimeout(sessionWatchdogHandle); sessionWatchdogHandle = null; }
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
          toolEvents,
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

      if (code === 0) {
        resolve({ success: true, output: textOutput, durationMs, usage, toolCallCount, turnCount, toolEvents });
      } else {
        // Non-zero exit is always a failure, even if partial text was produced.
        // Previously `textOutput.length > 0` was treated as success, which caused
        // the retry loop to skip retries when the agent crashed mid-turn after
        // writing a few lines (e.g. Step 0 context check) but before producing JSON.
        resolve({
          success: false,
          output: textOutput,
          error: `pi exited with code ${code}`,
          durationMs,
          usage,
          toolCallCount,
          turnCount,
          toolEvents,
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
        toolEvents,
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

**输出格式**：
- 最终结果用 \`\`\`json ... \`\`\` 包裹
- 顶层必须有 \`schema_version: "cross-repo-impact/2.0"\`、\`meta\`、\`changes\`、\`symbols\`、\`test_scenarios\`、\`unanalyzable\`
- 所有字段名是 **snake_case**

**完整字段约束（必填/可选/枚举值）见 [output-schema.md §5 必查清单](pi-skill/references/output-schema.md)**——
本提示词不重复列约束，避免与文档不同步。**输出前必读 §5；每写完 3-5 个 symbol 回查一次。**

### 🔴 实测最常踩的 7 条红线（输出 JSON 前再扫一遍）

1. **\`downstream_contracts[]\` 字段名固定为 \`call_kind\` + \`contract_kind\`**
   - ❌ \`kind\` / \`contract_type\` / \`transport\` 都是错的
   - \`call_kind\` 闭合枚举：\`direct_call\` / \`http_call\` / \`mq_event\` / \`scheduler_trigger\` / \`shared_data_flow\` / \`framework_dispatch\` / \`indirect_call\`
   - \`contract_kind\` 闭合枚举：\`param\` / \`schema\` / \`transaction\` / \`other\`
   - **不要**写 \`{param: {status, detail}, schema: {status, detail}}\` 嵌套对象——一行只表达一种契约，多种契约写多个数组元素
   - \`status\` 闭合枚举：\`satisfied\` / \`uncertain\` / \`violated\`（**不是** \`ok\`）

2. **\`target_api.transport\` 闭合 4 枚举：\`cloud_api\` / \`vstation\` / \`internal_rpc\` / \`scheduler\`**
   - ❌ \`HTTP\` / \`http\` / \`http_api\` / \`des_pipeline\` 都是非法值
   - HTTP 公网 API → \`cloud_api\`；DES 流水线步骤 → \`internal_rpc\`

3. **\`assertions[].kind\` 闭合 9 枚举**：
   \`api_response\` / \`db_check\` / \`log_check\` / \`metric_check\` / \`state_check\` / \`external_call_check\` / \`mock_check\` / \`human_observation\` / \`code_fix_directive\`
   - ❌ **禁止**生造：\`http_status\` / \`http_response\` / \`response_field\` / \`error_code\` / \`error_message\` / \`context_value\` / \`des_task\` / \`external_call\` / \`trade_goods\` / \`log_contains\`
   - 映射建议：HTTP 返回 → \`api_response\`；DB 状态 → \`db_check\`；日志 → \`log_check\`；DES/内存上下文 → \`state_check\`；内部 RPC 是否被调 → \`external_call_check\`
   - 每个 assertion 必填 \`kind\` / \`channel\` / \`expression\` / \`severity\`，每项**只有一个 kind**

4. **\`test_scenarios[]\` 必须有 \`api_params\` 字段**（即使 \`{}\`）——下游 agent 直接消费此字段执行 API 调用

5. **\`symbols[].diff_semantic\` 是字符串**（不是 \`{description, change_type, ...}\` 对象）；\`change_type\` / \`initial_severity\` 是顶层兄弟字段

6. **\`call_tree[]\` 节点字段名固定为 \`function\` / \`call_type\`**（❌ 不要用 \`caller\` / \`transport\` / \`kind\` 替代）；入口节点用 \`is_entry: true\` + \`entry_kind\` + \`entry_route\`（**禁止** \`[ENTRY]\` 文本）

7. **\`risk_table[]\` P0/P1 行 \`remediation\` 必填**（不能用 \`domain_context\` 兜底）；字段名用 \`function\` / \`location\`（不要用 \`caller_path\`）

### 分段自检（强制）

输出 \`symbols[]\` 时**采用分段产出**：

- 每写完 **3-5 个 symbol** 暂停一次，自查上面 7 条红线 + [output-schema.md §5](pi-skill/references/output-schema.md) 的 26 条必查项
- 不通过就在该批 symbol 内修，再写下一批
- **不要**等全部 18+ 个 symbol 写完才总检——长上下文 LLM 在第 5 个 symbol 之后开始字段名漂移是已观测的失败模式（实测过 18 个 symbol 跨 3 套 schema 变体）

### \`meta\` 顶层只接受 4 个 key

\`tool_name\` / \`tool_version\` / \`generated_at\` / \`dimension_catalog_version\`

❌ **禁止**自造 \`total_symbols\` / \`total_test_scenarios\` / \`entry_repos\` / \`summary\` / \`analysis_id\` / \`repo\` 等字段——这些信息从数组长度直接推得，meta 里写入会引入计数不一致问题。

### 其它常见错

- \`location\` 是 \`"file:line"\` **单字段**（不要拆成 \`file\` + \`line\` 两个字段）
- \`name\` 字段（如填）必须与 \`symbol\` 同源；**禁止错位**写成另一个变更点的名字
- \`unanalyzable[]\` 是结构化对象数组（带 \`id\` / \`category\` / \`subject\` / \`implication\` / \`suggested_handling\`），不是字符串列表
- \`risk_change_ids\` 是数组、值为 \`SYM-NNN\` id（不要写函数名）
`);

  return parts.join("\n");
}

/**
 * Extract JSON result from pi agent's text output.
 * Looks for ```json ... ``` blocks.
 *
 * Truncation recovery: when the agent is SIGKILL'd mid-stream (timeout race,
 * EP-004), the output ends inside a ```json block without a closing ```.
 * In that case we attempt a best-effort repair:
 *   1. Find the last ```json opener with no matching closer.
 *   2. Trim the fragment to the last complete top-level object boundary.
 *   3. Walk the open-bracket stack and append the missing closers.
 * This lets us salvage a partial-but-mostly-complete report instead of
 * falling back to the all-empty buildFallbackArtifact skeleton.
 */
export function extractJsonFromOutput(output: string): Record<string, unknown> | null {
  // ── Pass 1: find the last complete ```json ... ``` block ──────────────────
  const jsonBlocks = output.matchAll(/```json\s*\n([\s\S]*?)\n```/g);
  let lastBlock: string | null = null;

  for (const match of jsonBlocks) {
    lastBlock = match[1];
  }

  if (lastBlock) {
    try {
      return JSON.parse(lastBlock);
    } catch {
      return null;
    }
  }

  // ── Pass 2: truncation recovery — find an unclosed ```json block ──────────
  const openIdx = output.lastIndexOf("```json");
  if (openIdx !== -1) {
    // Extract everything after the ```json\n opener
    const afterMarker = output.slice(openIdx + 7); // len("```json") === 7
    const newlineIdx = afterMarker.indexOf("\n");
    if (newlineIdx !== -1) {
      const fragment = afterMarker.slice(newlineIdx + 1);

      // Only attempt repair when there is no closing ``` (i.e. output is truncated)
      if (!fragment.includes("\n```")) {
        const repaired = repairTruncatedJson(fragment);
        if (repaired) {
          try {
            const parsed = JSON.parse(repaired);
            if (typeof parsed === "object" && parsed !== null) {
              // Tag the result so callers know it was recovered from a truncated stream
              (parsed as Record<string, unknown>)._truncated = true;
              console.warn(`[extractJson] Recovered truncated JSON (${fragment.length} → ${repaired.length} chars)`);
              return parsed as Record<string, unknown>;
            }
          } catch {
            // fall through to Pass 3
          }
        }
      }
    }
  }

  // ── Pass 3: bare JSON object — pi may output JSON without ```json wrapper ──
  // pi 0.79.x sometimes emits the final report as a bare JSON object rather
  // than wrapping it in a ```json ... ``` markdown block.
  // Look for the last occurrence of {"schema_version" in the output and attempt
  // to parse the JSON object starting there.
  const schemaVersionMarker = '"schema_version"';
  let bareJsonIdx = output.lastIndexOf(schemaVersionMarker);
  if (bareJsonIdx !== -1) {
    // Walk backward to find the opening `{` of the top-level object
    let braceIdx = output.lastIndexOf("{", bareJsonIdx);
    if (braceIdx !== -1) {
      const candidate = output.slice(braceIdx);
      try {
        const parsed = JSON.parse(candidate);
        if (typeof parsed === "object" && parsed !== null) {
          console.warn(`[extractJson] Extracted bare JSON object at index ${braceIdx} (${candidate.length} chars)`);
          return parsed as Record<string, unknown>;
        }
      } catch {
        // JSON is incomplete — try truncation repair
        const repaired = repairTruncatedJson(candidate);
        if (repaired) {
          try {
            const parsed = JSON.parse(repaired);
            if (typeof parsed === "object" && parsed !== null) {
              (parsed as Record<string, unknown>)._truncated = true;
              console.warn(`[extractJson] Recovered bare truncated JSON (${candidate.length} → ${repaired.length} chars)`);
              return parsed as Record<string, unknown>;
            }
          } catch {
            // unrecoverable
          }
        }
      }
    }
  }

  return null;
}

/**
 * Best-effort repair of a JSON fragment that was cut off mid-stream.
 *
 * Strategy:
 *   1. Walk the fragment to find the last "safe" truncation point — the
 *      position after the last complete top-level value (depth ≤ 1 after
 *      a `}` or `]`, or before a trailing `,` at depth ≤ 2).
 *   2. Re-walk only the safe prefix to rebuild the exact open-bracket stack
 *      at that point.
 *   3. Append the missing closers in reverse order.
 *
 * Returns null when the fragment is too malformed to recover (e.g. cut
 * inside a string literal — detected via unclosed quote tracking).
 */
function repairTruncatedJson(fragment: string): string | null {
  if (!fragment.trim().startsWith("{")) return null;

  // ── Pass 1: find the deepest safe truncation index ────────────────────────
  let inString = false;
  let escape = false;
  let depth = 0;
  let lastSafeEnd = -1;

  for (let i = 0; i < fragment.length; i++) {
    const ch = fragment[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth <= 1) lastSafeEnd = i + 1; // complete element just closed
    } else if (ch === "," && depth <= 2) {
      lastSafeEnd = i; // exclude trailing comma
    }
  }

  // Truncated inside a string literal — cannot recover
  if (inString) return null;

  // ── Pass 2: re-walk the safe prefix to get the exact bracket stack ────────
  const safePrefix = lastSafeEnd > 0 ? fragment.slice(0, lastSafeEnd) : fragment.trimEnd();

  inString = false;
  escape = false;
  const stack: string[] = [];

  for (let i = 0; i < safePrefix.length; i++) {
    const ch = safePrefix[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
    } else if (ch === "}" || ch === "]") {
      stack.pop();
    }
  }

  const closers = stack.slice().reverse().join("");
  return safePrefix + closers;
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

    // Success with JSON output — return immediately
    const hasJson = lastResult.output.includes("```json");
    if (lastResult.success && hasJson) {
      if (attempt > 1) {
        console.log(`[pi:retry] Succeeded on attempt ${attempt}${currentConfig.model !== config.model ? ` (fallback model: ${currentConfig.model})` : ""}`);
      }
      return lastResult;
    }

    // Agent exited cleanly (code=0) but produced no JSON block — treat as
    // retryable failure. This happens when the agent crashes mid-turn after
    // writing prose (e.g. "Step 0 complete") but before emitting the report.
    if (lastResult.success && !hasJson) {
      console.log(`[pi:retry] Agent succeeded but no JSON block in output (${lastResult.output.length} chars), treating as retryable failure`);
      lastResult = { ...lastResult, success: false, error: "no JSON block in output" };
    }

    // Timeout — don't retry, return partial result.
    // Only treat as non-retryable timeout when the worker actually ran for
    // close to the full timeoutMs budget (≥95%). A "session init stall" that
    // resolves in 45s must NOT be treated as a timeout — it should retry.
    const isTimeout = (lastResult.durationMs >= (config.timeoutMs ?? 600_000) * 0.95);
    if (isTimeout) {
      console.log(`[pi:retry] Timeout on attempt ${attempt}, returning partial result`);
      return lastResult;
    }

    // Rate limit — longer backoff, always retry (don't count against MAX_RETRIES logic)
    const isRateLimit =
      lastResult.error?.includes("429") ||
      lastResult.error?.toLowerCase().includes("rate limit") ||
      lastResult.error?.toLowerCase().includes("too many requests");
    if (isRateLimit) {
      const rlDelay = 15_000 + Math.random() * 10_000; // 15-25s
      console.log(`[pi:retry] Rate limited on attempt ${attempt}, backing off ${Math.round(rlDelay)}ms...`);
      await new Promise((resolve) => setTimeout(resolve, rlDelay));
      continue;
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

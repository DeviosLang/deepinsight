/**
 * Pi RPC event types — matches pi's --mode rpc stdout JSON protocol.
 */

export interface PiSessionEvent {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
}

export interface PiAgentStartEvent {
  type: "agent_start";
}

export interface PiAgentEndEvent {
  type: "agent_end";
  messages?: unknown[];
}

export interface PiTurnStartEvent {
  type: "turn_start";
}

export interface PiTurnEndEvent {
  type: "turn_end";
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

export interface PiMessageStartEvent {
  type: "message_start";
  message: {
    role: "user" | "assistant" | "toolResult";
    content?: Array<{ type: string; text?: string }>;
    timestamp?: number;
  };
}

export interface PiMessageUpdateEvent {
  type: "message_update";
  assistantMessageEvent?: {
    type: "text_start" | "text_delta" | "text_end" | "thinking_start" | "thinking_delta" | "thinking_end" | "toolcall_start" | "toolcall_delta" | "toolcall_end";
    delta?: string;
  };
  message?: {
    role: "assistant";
    content?: Array<{ type: string; text?: string }>;
  };
}

export interface PiMessageEndEvent {
  type: "message_end";
  message: {
    role: "user" | "assistant" | "toolResult";
    content?: Array<{ type: string; text?: string }>;
    stopReason?: string;
  };
}

export interface PiToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
}

export interface PiToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  output?: string;
  isError?: boolean;
}

export interface PiErrorEvent {
  type: "error";
  code?: string;
  message?: string;
  retryable?: boolean;
}

export interface PiFatalEvent {
  type: "fatal";
  code?: string;
  message?: string;
  partialOutput?: string;
}

export type PiEvent =
  | PiSessionEvent
  | PiAgentStartEvent
  | PiAgentEndEvent
  | PiTurnStartEvent
  | PiTurnEndEvent
  | PiMessageStartEvent
  | PiMessageUpdateEvent
  | PiMessageEndEvent
  | PiToolExecutionStartEvent
  | PiToolExecutionEndEvent
  | PiErrorEvent
  | PiFatalEvent;

/**
 * Pi RPC input commands (stdin protocol).
 */
export interface PiPromptCommand {
  type: "prompt";
  message: string;
  images?: Array<{ type: string; data: string }>;
}

export interface PiAbortCommand {
  type: "abort";
}

export interface PiSteerCommand {
  type: "steer";
  message: string;
}

export type PiCommand = PiPromptCommand | PiAbortCommand | PiSteerCommand;

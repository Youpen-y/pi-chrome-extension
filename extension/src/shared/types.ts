/**
 * Shared types for the pi Browser Extension
 */

// ─── Bridge Protocol ────────────────────────────────────────────────────

export interface PageContext {
  url: string;
  title: string;
  content?: string;
  textContent?: string;
  excerpt?: string;
  byline?: string;
  length?: number;
  extractedAt: number;
  selection?: string;
  viewport?: { width: number; height: number };
  meta?: Record<string, string>;
}

export type BridgeToExtension =
  | { type: "auth_ok"; sessionId: string; bridgeVersion: string }
  | { type: "auth_error"; message: string }
  | { type: "response"; command: string; success: boolean; error?: string; data?: unknown }
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "message_delta"; delta: string }
  | { type: "message_update"; assistantMessageEvent: AssistantMessageEvent }
  | { type: "tool_call"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "error"; code: string; message: string };

export type AssistantMessageEvent =
  | { type: "start" }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_start"; contentIndex: number; toolCall: { id: string; name: string } }
  | { type: "toolcall_end"; contentIndex: number; toolCall: { id: string; name: string; arguments: string } }
  | { type: "done"; reason: "stop" | "length" | "toolUse" }
  | { type: "error"; reason: string };

export interface ToolResultContent {
  type: "text";
  text: string;
}

// ─── Chat State ─────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: number;
  isStreaming?: boolean;
}

export interface AppState {
  connected: boolean;
  pageContext: PageContext | null;
  messages: ChatMessage[];
  isProcessing: boolean;
  bridgeVersion?: string;
  error?: string;
}

// ─── Storage Keys ───────────────────────────────────────────────────────

export const STORAGE_KEYS = {
  BRIDGE_URL: "pi_bridge_url",
  BRIDGE_TOKEN: "pi_bridge_token",
} as const;

/**
 * pi Chrome Extension - Bridge Shared Types
 *
 * Defines the protocol between the Chrome Extension and the Bridge Service.
 * Based on pi RPC protocol but extended for browser-specific operations.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";

/** Content block of a tool result. Extension only ever sends text; image blocks
 *  are produced bridge-side (e.g. PDF page renders forwarded to the vision model). */
export type ToolResultContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

// ─── WebSocket Protocol ─────────────────────────────────────────────────────

/** Messages from Extension → Bridge */
export type ExtensionToBridge =
  | { type: "auth"; token: string }
  | { type: "prompt"; id?: string; message: string; pageContext?: PageContext; images?: ImageContent[] }
  | { type: "steer"; id?: string; message: string; pageContext?: PageContext }
  | { type: "follow_up"; id?: string; message: string }
  | { type: "abort" }
  | { type: "tool_result"; toolCallId: string; content: ToolResultContentBlock[]; isError?: boolean }
  | { type: "page_context_update"; pageContext: PageContext }
  | { type: "get_state" }
  | { type: "new_session" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking_level"; level: ThinkingLevel }
  | { type: "set_language"; language: string };

/** Messages from Bridge → Extension */
export type BridgeToExtension =
  | { type: "auth_ok"; sessionId: string; bridgeVersion: string }
  | { type: "auth_error"; message: string }
  | { type: "response"; command: string; success: boolean; error?: string; data?: unknown }
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: unknown[] }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "message_update"; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_delta"; delta: string } // Convenience: text_delta shorthand
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: unknown }
  | { type: "tool_call"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "compaction_start"; reason: string }
  | { type: "compaction_end"; result: unknown }
  | { type: "new_session_ok" }
  | { type: "error"; code: string; message: string }
  | ExtensionUiRequest;

// ─── Page Context ───────────────────────────────────────────────────────────

export interface PageContext {
  /** Current page URL */
  url: string;
  /** Page title */
  title: string;
  /** Readability-extracted article content (HTML) */
  content?: string;
  /** Readability-extracted text content */
  textContent?: string;
  /** Article excerpt / description */
  excerpt?: string;
  /** Article author (from Readability) */
  byline?: string;
  /** Content length in characters */
  length?: number;
  /** When the content was extracted (epoch ms) */
  extractedAt: number;
  /** User's text selection on the page */
  selection?: string;
  /** Viewport dimensions */
  viewport?: { width: number; height: number };
  /** OpenGraph / meta tags */
  meta?: Record<string, string>;
}

export interface ImageContent {
  type: "image";
  data: string; // base64-encoded
  mimeType: string; // image/png, image/jpeg, etc.
}

// ─── Assistant Message Events (from pi SDK) ─────────────────────────────────

export type AssistantMessageEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number; partial: unknown }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: { text: string } }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; thinking: string }
  | { type: "toolcall_start"; contentIndex: number; toolCall: { id: string; name: string } }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: { id: string; name: string; arguments: string } }
  | { type: "done"; reason: "stop" | "length" | "toolUse" | "end_turn" }
  | { type: "error"; reason: "aborted" | "error" };

// ─── Extension UI Protocol (for future interactive tools) ───────────────────

export type ExtensionUiRequest =
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" };

export type ExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: boolean };

// ─── Tool Call Protocol (Bridge → Extension → Content Script) ──────────────

export interface ToolCallRequest {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolCallResult {
  toolCallId: string;
  content: ToolResultContentBlock[];
  isError?: boolean;
}

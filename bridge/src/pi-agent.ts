/**
 * pi Agent Wrapper
 *
 * Manages the pi AgentSession lifecycle, custom tool registration,
 * and message streaming. Uses pi SDK's customTools option for
 * clean tool registration.
 */

import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent, ThinkingLevel, ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { BridgeConfig } from "./config.js";
import { buildPageSystemPrompt } from "./context.js";
import type { PageContext } from "./types.js";

/** Callback for streaming text deltas to the client */
export type TextDeltaCallback = (delta: string) => void;
/** Callback for agent lifecycle events */
export type AgentEventCallback = (event: AgentSessionEvent) => void;
/** Callback for tool call forwarding to the browser extension */
export type ToolForwardCallback = (toolCallId: string, toolName: string, args: Record<string, unknown>) => void;

export interface PiAgentOptions {
  config: BridgeConfig;
  /** Working directory for pi resource discovery */
  cwd?: string;
  onTextDelta: TextDeltaCallback;
  onAgentEvent: AgentEventCallback;
  forwardToolCall: ToolForwardCallback;
}

export class PiAgent {
  private session: AgentSession | null = null;
  private options: PiAgentOptions;
  private config: BridgeConfig;

  // Pending tool call resolvers: toolCallId -> resolve function
  private pendingTools = new Map<
    string,
    (result: { content: { type: "text"; text: string }[]; isError?: boolean }) => void
  >();

  /** Track whether we've injected page context into this session */
  private hasInjectedContext = false;
  /** Track last page URL to detect navigation */
  private lastPageUrl: string | undefined;

  constructor(options: PiAgentOptions) {
    this.options = options;
    this.config = options.config;
  }

  /**
   * Initialize the pi agent session.
   * Sets up auth, model, custom tools, and resource loader.
   */
  async initialize(): Promise<void> {
    const { config } = this;

    // ── Auth & Model Registry ────────────────────────────────────────
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);

    // ── Find model ───────────────────────────────────────────────────
    let model = undefined;
    if (config.defaultProvider && config.defaultModel) {
      model = getModel(config.defaultProvider, config.defaultModel);
      if (!model) {
        console.warn(`[bridge] Model ${config.defaultProvider}/${config.defaultModel} not found, using default`);
      }
    }

    // ── Settings ─────────────────────────────────────────────────────
    const cwd = this.options.cwd ?? process.cwd();
    const settingsManager = SettingsManager.create(cwd, config.agentDir ?? getAgentDir());

    // ── Resource Loader ──────────────────────────────────────────────
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: config.agentDir ?? getAgentDir(),
      systemPromptOverride: () => this.buildSystemPrompt(),
    });
    await resourceLoader.reload();

    // ── Create custom tools ──────────────────────────────────────────
    const customTools = this.createCustomTools();

    // ── Create Session ───────────────────────────────────────────────
    const sessionManager = config.sessionDir
      ? SessionManager.create(config.sessionDir)
      : undefined;

    const { session } = await createAgentSession({
      cwd,
      agentDir: config.agentDir ?? getAgentDir(),
      model,
      thinkingLevel: (config.defaultThinkingLevel as ThinkingLevel) ?? "low",
      authStorage,
      modelRegistry,
      resourceLoader,
      settingsManager,
      sessionManager: sessionManager ?? SessionManager.inMemory(cwd),
      customTools,
      // Security: disable built-in tools (read/bash/edit/write) but keep our custom
      // browser tools. The companion only needs browser interaction — no file/shell access.
      noTools: "builtin",
    });

    this.session = session;

    // ── Subscribe to events ──────────────────────────────────────────
    session.subscribe((event: AgentSessionEvent) => {
      this.handleSessionEvent(event);
    });

    console.log(`[bridge] pi agent initialized (model: ${session.model?.id ?? "default"})`);
  }

  /**
   * Send a prompt to the agent.
   * Page context is only injected on first message or when page URL changes.
   */
  async prompt(
    message: string,
    pageContext?: PageContext,
    images?: { type: "image"; data: string; mimeType: string }[],
  ): Promise<void> {
    if (!this.session) throw new Error("Agent not initialized");

    const shouldInjectContext = pageContext &&
      (!this.hasInjectedContext || pageContext.url !== this.lastPageUrl);

    let fullMessage: string;
    if (shouldInjectContext) {
      fullMessage = `${buildPageSystemPrompt(pageContext, this.config)}\n\n## User Question\n\n${message}`;
      this.hasInjectedContext = true;
      this.lastPageUrl = pageContext.url;
    } else {
      fullMessage = message;
    }

    const imageContents = images?.map((img) => ({
      type: "image" as const,
      source: { type: "base64" as const, mediaType: img.mimeType, data: img.data },
    }));

    await this.session.prompt(fullMessage, { images: imageContents });
  }

  /**
   * Queue a steering message.
   * Only prepends page context if not yet injected.
   */
  async steer(message: string, pageContext?: PageContext): Promise<void> {
    if (!this.session) throw new Error("Agent not initialized");
    const shouldInjectContext = pageContext &&
      (!this.hasInjectedContext || pageContext.url !== this.lastPageUrl);

    const fullMessage = shouldInjectContext
      ? `${buildPageSystemPrompt(pageContext, this.config)}\n\n${message}`
      : message;

    if (shouldInjectContext) {
      this.hasInjectedContext = true;
      this.lastPageUrl = pageContext!.url;
    }

    await this.session.steer(fullMessage);
  }

  /**
   * Queue a follow-up message (after agent finishes).
   */
  async followUp(message: string): Promise<void> {
    if (!this.session) throw new Error("Agent not initialized");
    await this.session.followUp(message);
  }

  /**
   * Abort the current agent operation.
   */
  async abort(): Promise<void> {
    if (!this.session) return;
    await this.session.abort();
  }

  /**
   * Resolve a pending tool call with the result from the extension.
   */
  resolveTool(
    toolCallId: string,
    result: { content: { type: "text"; text: string }[]; isError?: boolean },
  ): void {
    const resolve = this.pendingTools.get(toolCallId);
    if (resolve) {
      resolve(result);
      this.pendingTools.delete(toolCallId);
    } else {
      console.warn(`[bridge] No pending tool call for id: ${toolCallId}`);
    }
  }

  /**
   * Get the current agent state.
   */
  getState() {
    if (!this.session) return null;
    return {
      model: this.session.model,
      thinkingLevel: this.session.thinkingLevel,
      isStreaming: this.session.isStreaming,
      messageCount: this.session.messages.length,
    };
  }

  /**
   * Set the thinking level.
   */
  setThinkingLevel(level: ThinkingLevel): void {
    this.session?.setThinkingLevel(level);
  }

  /**
   * Reset context injection state (e.g., on new session).
   */
  resetContext(): void {
    this.hasInjectedContext = false;
    this.lastPageUrl = undefined;
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.session?.dispose();
  }

  // ── Private ───────────────────────────────────────────────────────

  /**
   * Create all custom tools for browser interaction.
   * Each tool forwards the call to the extension via WebSocket and waits for the result.
   */
  private createCustomTools(): ToolDefinition[] {
    const forward = this.options.forwardToolCall;
    const pending = this.pendingTools;

    // Helper: create a tool that forwards and waits
    const browserTool = (
      name: string,
      label: string,
      description: string,
      parameters: any,
      promptSnippet?: string,
      promptGuidelines?: string[],
    ): ToolDefinition => ({
      name,
      label,
      description,
      promptSnippet,
      promptGuidelines,
      parameters,
      async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
        forward(toolCallId, name, params);
        return new Promise((resolve) => {
          pending.set(toolCallId, resolve);
        });
      },
    });

    return [
      // ── Read Tools ────────────────────────────────────────────
      browserTool(
        "read_page_content", "Read Page Content",
        "Read the full article content from the current web page using Readability. " +
        "Returns cleaned article text, title, excerpt, and metadata.",
        Type.Object({}, { description: "Reads the current page content." }),
        "Read and analyze the current webpage's content",
        [
          "Use read_page_content when the user asks questions about page details.",
          "Use read_page_content when initial context was truncated and you need the full article.",
        ],
      ),

      browserTool(
        "read_selection", "Read Selection",
        "Read the text the user has currently selected/highlighted on the page.",
        Type.Object({}, { description: "Reads selected text." }),
        "Read the user's current text selection on the page",
        [
          "Use read_selection when the user says 'this' or references highlighted text.",
        ],
      ),

      browserTool(
        "get_page_headings", "Get Page Headings",
        "Get the heading structure (h1-h3) of the current page. Useful for understanding page outline.",
        Type.Object({}, { description: "Returns heading hierarchy." }),
        "Get the heading outline of the page",
      ),

      browserTool(
        "get_page_metadata", "Get Page Metadata",
        "Get page metadata: OpenGraph tags, meta description, keywords from <head>.",
        Type.Object({}, { description: "Returns page metadata." }),
        "Read page metadata and SEO tags",
      ),

      // ── Modify Tools ───────────────────────────────────────────
      browserTool(
        "modify_page_css", "Modify Page CSS",
        "Inject custom CSS into the web page. Use to change colors, fonts, layout, etc.",
        Type.Object({
          css: Type.String({ description: "CSS rules to inject" }),
          revertable: Type.Optional(Type.Boolean({ description: "Whether this can be reverted (default: true)" })),
        }),
        "Inject custom CSS styles to change the page appearance",
        [
          "Use modify_page_css for visual changes like colors, fonts, layout.",
          "Use valid CSS with complete selectors.",
        ],
      ),

      browserTool(
        "modify_page_style", "Modify Element Styles",
        "Modify CSS style properties of specific elements using CSS selectors.",
        Type.Object({
          selector: Type.String({ description: "CSS selector to target elements" }),
          styles: Type.Record(Type.String(), Type.String(), {
            description: "CSS property-value pairs (e.g., { color: 'red' })",
          }),
        }),
        "Change styles of specific page elements",
      ),

      browserTool(
        "toggle_dark_mode", "Toggle Dark Mode",
        "Toggle dark mode on the page. enable=true forces dark, enable=false forces light, omit toggles.",
        Type.Object({
          enable: Type.Optional(Type.Boolean({ description: "true=dark, false=light, omit=toggle" })),
        }),
        "Toggle dark mode on the page",
        ["Use toggle_dark_mode when user says 'dark mode' or 'light mode'."],
      ),

      browserTool(
        "highlight_elements", "Highlight Elements",
        "Highlight page elements with colored outlines, backgrounds, or glow.",
        Type.Object({
          selectors: Type.Array(Type.String(), { description: "CSS selectors to highlight" }),
          color: Type.Optional(Type.String({ description: "Highlight color (default: #ffeb3b)" })),
          style: Type.Optional(StringEnum(["outline", "background", "glow"] as const, {
            description: "Highlight style (default: outline)",
          })),
        }),
        "Highlight elements on the page",
      ),

      browserTool(
        "remove_elements", "Remove Elements",
        "Hide specific page elements using CSS selectors. Elements are hidden (display:none) and can be restored.",
        Type.Object({
          selectors: Type.Array(Type.String(), { description: "CSS selectors to hide" }),
        }),
        "Hide or remove distracting elements from the page",
        ["Use remove_elements when the user asks to hide ads, sidebars, popups, etc."],
      ),

      browserTool(
        "revert_page_modifications", "Revert Page Modifications",
        "Revert ALL CSS and style modifications. Restores the page to its original state.",
        Type.Object({}, { description: "Reverts all page modifications." }),
        "Revert all page modifications to original state",
        ["Use revert_page_modifications when the user asks to undo all changes or reset the page."],
      ),

      browserTool(
        "inject_script", "Inject JavaScript",
        "Execute JavaScript in the page context. For complex interactions beyond CSS.",
        Type.Object({
          code: Type.String({ description: "JavaScript code to execute" }),
        }),
        "Execute JavaScript in the page context",
        ["Use inject_script sparingly. Prefer CSS for visual changes."],
      ),

      // ── Navigation Tool ────────────────────────────────────────
      browserTool(
        "navigate_to_url", "Navigate to URL",
        "Navigate the current browser tab to a specified URL. " +
        "Use this when the user asks you to open a link or go to a different page. " +
        "After navigation, the page content updates automatically so you can read it.",
        Type.Object({
          url: Type.String({ description: "The URL to navigate to (full URL including https://)" }),
        }),
        "Navigate to a URL the user requested",
        [
          "Use navigate_to_url when the user asks you to open a link they provided.",
          "After navigating, read the new page with read_page_content.",
        ],
      ),

      // ── Tab Tools ────────────────────────────────────────────
      browserTool(
        "list_tabs", "List Tabs",
        "List all open browser tabs with their titles and URLs. " +
        "Useful when the user asks what tabs they have open or wants to find a specific page.",
        Type.Object({}, { description: "Lists all open tabs." }),
        "List all open browser tabs",
        [
          "Use list_tabs when the user asks 'what tabs do I have open' or similar.",
          "After listing, you can use navigate_to_url to switch to a specific tab by URL.",
        ],
      ),

      // ── Click Tool ───────────────────────────────────────────
      browserTool(
        "click_element", "Click Element",
        "Click an element on the page using a CSS selector. " +
        "Works with buttons, links, menu items — any visible element. " +
        "For links (<a> tags), automatically navigates to the href. " +
        "Generates a real trusted mouse event (isTrusted=true) via Chrome DevTools Protocol.",
        Type.Object({
          selector: Type.String({ description: "CSS selector for the element to click (e.g. 'button.submit', '[data-testid=compose]')" }),
          text: Type.Optional(Type.String({ description: "If set, filters to elements containing this text" })),
          button: Type.Optional(StringEnum(["left", "right", "middle"] as const, { description: "Mouse button (default: left)" })),
          doubleClick: Type.Optional(Type.Boolean({ description: "Double-click instead of single (default: false)" })),
          waitAfter: Type.Optional(Type.Number({ description: "ms to wait after click before returning (default: 1000)" })),
          preferNavigate: Type.Optional(Type.Boolean({ description: "For <a> links, navigate via chrome.tabs.update instead of click (default: true)" })),
          timeout: Type.Optional(Type.Number({ description: "ms to wait for element to appear (default: 5000)" })),
        }),
        "Click an element on the page",
        [
          "Use click_element to interact with buttons, forms, menus, etc.",
          "For <a> tags the tool automatically navigates instead of clicking.",
          "After clicking, wait for the page to update before further actions.",
        ],
      ),
    ];
  }

  private buildSystemPrompt(): string {
    return `You are a down-to-earth browser reading companion.

You live inside a Chrome Extension and work with the user's current webpage.
You can read the page, tweak its look, and chat about what's on it.

## What you can do

1. **Read the page** — grab the full article or selected text.
2. **Change the page** — inject CSS, toggle dark mode, highlight things.
3. **Navigate** — go to a URL the user gives you (use \`navigate_to_url\`).
4. **List tabs** — see all open tabs (use \`list_tabs\`).
5. **Click** — click buttons, links, menus (use \`click_element\`).
6. **Chat** — talk naturally about the content.

## How to talk

- Be natural and human. No "as an AI" or "I don't have personal opinions" nonsense.
- Get straight to the point. No fluffy intros or wrap-ups.
- Summaries should be crisp — a few paragraphs max.
- When modifying the page, just do it and briefly mention what changed.
- Match the user's language. If they speak Chinese, respond in Chinese.
- Think out loud in your \`thinking\` blocks, but keep the final response tight.
- No emoji overload. A well-placed emoji is fine, but don't sound like a cheerleader.

## Page Context

The current page info (title, URL, content) is given at the start of the conversation.
When the user navigates to a new page, the context updates automatically.
Use \`read_page_content\` if you need fresh content anytime.`;
  }

  private handleSessionEvent(event: AgentSessionEvent): void {
    this.options.onAgentEvent(event);

    if (event.type === "message_update") {
      const msgEvent = event.assistantMessageEvent;
      if (msgEvent && "delta" in msgEvent && msgEvent.type === "text_delta") {
        this.options.onTextDelta(msgEvent.delta);
      }
    }
  }
}

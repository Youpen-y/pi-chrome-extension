/**
 * Background Service Worker
 *
 * WXT requires background entry points to use defineBackground.
 * This wraps the main logic that was previously in src/background/main.ts.
 */

import { defineBackground } from "wxt/utils/define-background";
import type { BridgeToExtension, PageContext, AppState, ChatMessage, PageModsStatus } from "../../src/shared/types";
import { storage } from "wxt/utils/storage";

export default defineBackground({
  main() {
    // ═══════════════════════════════════════════════════════════════════
    //  State
    // ═══════════════════════════════════════════════════════════════════

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    let state: AppState = {
      connected: false,
      pageContext: null,
      messages: [],
      isProcessing: false,
      pageMods: null,
    };

    // Connected side panel ports. We broadcast both full-state snapshots and
    // lightweight streaming deltas so single large outputs never hit port size limits.
    const ports = new Set<chrome.runtime.Port>();

    function broadcast(msg: Record<string, unknown>) {
      for (const port of ports) {
        try { port.postMessage(msg); } catch { ports.delete(port); }
      }
    }

    // Load persisted state (survives service worker restarts)
    async function loadPersistedState() {
      try {
        const saved = await storage.getItem<{ messages: ChatMessage[]; pageContext?: PageContext | null }>("local:pi_state");
        if (saved?.messages?.length) {
          state.messages = saved.messages;
          if (saved.pageContext) state.pageContext = saved.pageContext;
          emitState();
        }
      } catch { /* ignore */ }
    }

    // Debounced persister to avoid writing on every tiny state change
    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    function persistState() {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(async () => {
        try {
          await storage.setItem("local:pi_state", {
            messages: state.messages,
            pageContext: state.pageContext,
          });
        } catch { /* ignore */ }
      }, 500);
    }

    function emitState() {
      broadcast({ type: "state", state });
    }

    /** Push a single streaming delta — tiny payload, safe regardless of output length. */
    function emitDelta(messageId: string, delta: string) {
      broadcast({ type: "delta", messageId, delta });
    }

    function patch(partial: Partial<AppState>) {
      state = { ...state, ...partial };
      if ("messages" in partial || "pageContext" in partial) {
        persistState();
      }
      emitState();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  WebSocket Connection
    // ═══════════════════════════════════════════════════════════════════

    async function getBridgeUrl(): Promise<string> {
      return (await storage.getItem<string>("local:pi_bridge_url")) ?? "ws://127.0.0.1:18731";
    }

    async function getBridgeToken(): Promise<string | undefined> {
      return (await storage.getItem<string>("local:pi_bridge_token")) ?? undefined;
    }

    let discoveredPort: number | null = null;

    /**
     * Probe the bridge HTTP health endpoint on a given port.
     * Returns the WebSocket URL if reachable, null otherwise.
     */
    async function probePort(port: number): Promise<string | null> {
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
        if (resp.ok) {
          const data = await resp.json();
          if (data.status === "ok") {
            return `ws://127.0.0.1:${data.port ?? port}`;
          }
        }
      } catch { /* port not reachable */ }
      return null;
    }

    async function discoverBridge(): Promise<string | null> {
      // 1. Check if we already have a discovered port
      if (discoveredPort !== null) {
        const url = await probePort(discoveredPort);
        if (url) return url;
        discoveredPort = null;
      }

      // 2. Try user-configured URL from storage
      const configured = await getBridgeUrl();
      const configuredUrl = new URL(configured);
      const configuredPort = parseInt(configuredUrl.port, 10);
      const url = await probePort(configuredPort);
      if (url) return url;

      // 3. Scan nearby ports (18731-18741)
      for (let port = 18731; port <= 18741; port++) {
        const found = await probePort(port);
        if (found) {
          discoveredPort = port;
          // Save discovered URL for future connections
          storage.setItem("local:pi_bridge_url", found).catch(() => {});
          return found;
        }
      }

      return null;
    }

    async function connect() {
      if (ws) { ws.close(); ws = null; }

      const url = await discoverBridge();
      if (!url) {
        console.log("[bg] Bridge not found, will retry...");
        patch({ connected: false, error: "Bridge not found. Make sure the bridge is running." });
        scheduleReconnect();
        return;
      }

      console.log(`[bg] Connecting to bridge: ${url}`);

      try {
        ws = new WebSocket(url);
      } catch (err) {
        console.error("[bg] WS creation failed:", err);
        patch({ connected: false, error: `Connection failed: ${(err as Error).message}` });
        scheduleReconnect();
        return;
      }

      ws.onopen = async () => {
        console.log("[bg] Connected");
        discoveredPort = parseInt(new URL(url).port, 10);
        patch({ connected: true, error: undefined });

        const token = await getBridgeToken();
        if (token) send({ type: "auth", token });

        const ctx = await getPageContext();
        if (ctx) {
          patch({ pageContext: ctx });
          send({ type: "page_context_update", pageContext: ctx });
        }
      };

      ws.onmessage = (e: MessageEvent) => {
        const lines = (e.data as string).split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const msg: BridgeToExtension = JSON.parse(line);
            handleMessage(msg);
          } catch { /* skip bad json */ }
        }
      };

      ws.onclose = () => {
        console.log("[bg] Disconnected");
        patch({ connected: false, isProcessing: false });
        ws = null;
        scheduleReconnect();
      };

      ws.onerror = () => { /* onclose fires after */ };
    }

    function send(data: Record<string, unknown>) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data) + "\n");
      }
    }

    function scheduleReconnect() {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 3000);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Bridge Message Handler
    // ═══════════════════════════════════════════════════════════════════

    function handleMessage(msg: BridgeToExtension) {
      switch (msg.type) {
        case "auth_ok":
          patch({ bridgeVersion: msg.bridgeVersion });
          break;

        case "auth_error":
          patch({ error: `Auth failed: ${msg.message}` });
          break;

        case "agent_start":
          patch({ isProcessing: true });
          // Don't create a streaming message here — it's created lazily in appendDelta.
          // This allows each turn (turn_start) to get its own message bubble.
          break;

        case "turn_start":
          // Finalize the current streaming message so the next turn gets a fresh bubble.
          // This prevents text from multiple turns being concatenated into one message.
          finalizeStreaming();
          break;

        case "agent_end":
          patch({ isProcessing: false });
          // If the streaming message has no content, show a network/server error
          const msgs = [...state.messages];
          const lastStreaming = msgs.find((m) => m.isStreaming);
          if (lastStreaming && !lastStreaming.content.trim()) {
            const idx = msgs.indexOf(lastStreaming);
            msgs.splice(idx, 1);
            // Add a system message instead
            msgs.push({
              id: crypto.randomUUID(),
              role: "system",
              content: "⚠️ The AI model didn't return a response — check network connection or API key.",
              timestamp: Date.now(),
            });
            patch({ messages: msgs });
          } else {
            finalizeStreaming();
          }
          break;

        case "message_delta":
          appendDelta(msg.delta);
          break;

        case "message_update": {
          const e = msg.assistantMessageEvent;
          if (e.type === "done" || e.type === "error") finalizeStreaming();
          break;
        }

        case "tool_execution_start":
          // Unified 🔧 indicator for ALL tools — including bridge-side ones
          // (safe_read / list_dir) that execute in the bridge and never trigger
          // a tool_call/forward. SDK emits this before every tool executes.
          pushToolMessage({ id: crypto.randomUUID(), role: "tool", content: `🔧 ${msg.toolName}…`, timestamp: Date.now() });
          break;

        case "tool_call":
          // Forward to content script for execution. The 🔧 indicator is shown
          // via tool_execution_start above (covers every tool uniformly), so we
          // only forward here — no duplicate pushToolMessage.
          forwardToolCall(msg.toolCallId, msg.toolName, msg.args).catch(console.error);
          break;

        case "error":
          // Show error even if there's no streaming message
          if (state.messages.some((m) => m.isStreaming)) {
            appendDelta(`\n\n**⚠️ Error:** ${msg.message}`);
          } else {
            pushMessage({
              id: crypto.randomUUID(),
              role: "assistant",
              content: `⚠️ **Error:** ${msg.message}`,
              timestamp: Date.now(),
              isStreaming: false,
            });
          }
          patch({ isProcessing: false });
          break;
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Message Helpers
    // ═══════════════════════════════════════════════════════════════════

    function pushMessage(m: ChatMessage) {
      patch({ messages: [...state.messages, m] });
    }

    /** Push a tool message before the streaming assistant message (tools run during thinking) */
    function pushToolMessage(m: ChatMessage) {
      const msgs = [...state.messages];
      const idx = msgs.findLastIndex((x) => x.isStreaming && x.role === "assistant");
      if (idx >= 0) {
        msgs.splice(idx, 0, m);
      } else {
        msgs.push(m);
      }
      patch({ messages: msgs });
    }

    /** Tracks which message id we are currently streaming deltas for. */
    let lastDeltaMessageId: string | null = null;

    function appendDelta(delta: string) {
      const msgs = [...state.messages];
      // Find the last streaming assistant message (tool messages may have been pushed after it)
      let last = msgs.findLast((m) => m.isStreaming);
      if (!last) {
        last = { id: crypto.randomUUID(), role: "assistant", content: "", timestamp: Date.now(), isStreaming: true };
        msgs.push(last);
      }
      last.content += delta;
      state = { ...state, messages: msgs };
      persistState();

      if (last.id !== lastDeltaMessageId) {
        // New streaming bubble — panel needs the full state to learn this message exists.
        lastDeltaMessageId = last.id;
        emitState();
      } else {
        // Same bubble — push only the tiny delta (never triggers port size limits).
        emitDelta(last.id, delta);
      }
    }

    function finalizeStreaming() {
      const msgs = [...state.messages];
      const last = msgs.findLast((m) => m.isStreaming);
      if (last) {
        last.isStreaming = false;
        lastDeltaMessageId = null; // next appendDelta will start a fresh bubble
        patch({ messages: msgs });
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Page Context & Tool Forwarding
    // ═══════════════════════════════════════════════════════════════════

    async function getPageContext(): Promise<PageContext | null> {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return null;

        // Try content script first (works on regular web pages)
        try {
          const resp = await Promise.race([
            chrome.tabs.sendMessage(tab.id, { type: "get_page_context" }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
          ]);
          if ((resp as any)?.pageContext) {
            const ctx = (resp as any).pageContext;
            patch({ pageContext: ctx });
            return ctx;
          }
        } catch {}

        // Fallback: content script unavailable (chrome://, about://, etc.)
        const tabInfo = await chrome.tabs.get(tab.id);
        const ctx: PageContext = {
          url: tabInfo.url ?? tab.pendingUrl ?? "",
          title: tabInfo.title ?? "",
          textContent: "",
          extractedAt: Date.now(),
        };
        patch({ pageContext: ctx });
        return ctx;
      } catch {
        return null;
      }
    }

    /** Query the active tab's content script for the current page-mods status. */
    async function queryPageMods(): Promise<void> {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return;
        const resp = await Promise.race([
          chrome.tabs.sendMessage(tab.id, { type: "get_page_mods_status" }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
        ]);
        if (resp && typeof resp === "object" && "origin" in resp) {
          patch({ pageMods: { origin: resp.origin, count: resp.count, applied: resp.applied, css: resp.css } as PageModsStatus });
        } else {
          // Content script unavailable (chrome://, etc.) — mark as unknown.
          patch({ pageMods: null });
        }
      } catch {
        patch({ pageMods: null });
      }
    }

    async function forwardToolCall(toolCallId: string, toolName: string, args: Record<string, unknown>) {
      try {
        // ── Navigation (handled directly by background, not content script) ──
        if (toolName === "navigate_to_url") {
          const url = args.url as string;
          if (!url) throw new Error("No URL provided");
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.id) throw new Error("No active tab");
          await chrome.tabs.update(tab.id, { url });
          send({
            type: "tool_result",
            toolCallId,
            content: [{ type: "text", text: `Navigated to ${url}` }],
            isError: false,
          });
          return;
        }

        // ── List Tabs (handled directly by background) ──
        if (toolName === "list_tabs") {
          const allTabs = await chrome.tabs.query({});
          const tabList = allTabs.map((t) => ({
            id: t.id,
            title: t.title || "(no title)",
            url: t.url || "(no url)",
            active: t.active,
            windowId: t.windowId,
          }));
          const text = tabList
            .map((t) => `[${t.id}] ${t.active ? "▶ " : "  "}${t.title}\n    ${t.url}`)
            .join("\n");
          send({
            type: "tool_result",
            toolCallId,
            content: [{ type: "text", text }],
            isError: false,
          });
          return;
        }

        // ── Inject Script (bypasses page CSP via chrome.scripting.executeScript) ──
        if (toolName === "inject_script") {
          const code = args.code as string;
          if (!code) throw new Error("No code provided");
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.id) throw new Error("No active tab");
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            func: (src: string) => { const s = document.createElement("script"); s.textContent = src; document.body.appendChild(s); s.remove(); },
            args: [code],
          });
          send({
            type: "tool_result",
            toolCallId,
            content: [{ type: "text", text: "✅ Script executed (via MAIN world)" }],
            isError: false,
          });
          return;
        }

        // ── Click Element (handled directly by background via CDP) ──
        if (toolName === "click_element") {
          await handleClickElement(toolCallId, args);
          return;
        }

        // ── Normal flow: forward to content script ──
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error("No active tab");
        const resp = await chrome.tabs.sendMessage(tab.id, { type: "execute_tool", toolCallId, toolName, args });
        send({
          type: "tool_result",
          toolCallId,
          content: resp?.content ?? [{ type: "text", text: "No result" }],
          isError: resp?.isError ?? false,
        });
      } catch (err) {
        send({
          type: "tool_result",
          toolCallId,
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          isError: true,
        });
      }
    }

    /**
     * Handle click_element tool: find element via content script, then use CDP to dispatch real mouse events.
     */
    async function handleClickElement(toolCallId: string, args: Record<string, unknown>) {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error("No active tab");

        const selector = args.selector as string;
        const text = args.text as string | undefined;
        const button = (args.button as string) || "left";
        const doubleClick = !!args.doubleClick;
        const waitAfter = (args.waitAfter as number) ?? 1000;
        const preferNavigate = args.preferNavigate !== false;
        const timeout = (args.timeout as number) ?? 5000;

        // Step 1: find element via content script
        const coords = await Promise.race([
          chrome.tabs.sendMessage(tab.id, { type: "get_element_coords", selector, text }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), timeout)),
        ]);
        if (!coords || (coords as any).error) {
          throw new Error((coords as any)?.error || `Element not found within ${timeout}ms`);
        }

        const { x, y, tagName, href } = coords as any;

        // Step 2: Strategy A — <a> link, use navigation
        if (tagName === "a" && href && preferNavigate) {
          await chrome.tabs.update(tab.id, { url: href });
          send({
            type: "tool_result",
            toolCallId,
            content: [{ type: "text", text: `🖱 Clicked <a> link → navigated to ${href}` }],
            isError: false,
          });
          return;
        }

        // Step 3: Strategy B — CDP real click
        const target = { tabId: tab.id };
        await chrome.debugger.attach(target, "1.3");

        try {
          // Dispatch mouse events
          const clickEvents = [
            { type: "mousePressed" as const, x, y, button, clickCount: doubleClick ? 2 : 1 },
            { type: "mouseReleased" as const, x, y, button, clickCount: doubleClick ? 2 : 1 },
          ];
          if (doubleClick) {
            clickEvents.push(
              { type: "mousePressed" as const, x, y, button, clickCount: 2 },
              { type: "mouseReleased" as const, x, y, button, clickCount: 2 },
            );
          }
          for (const evt of clickEvents) {
            await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", evt);
          }
        } finally {
          await chrome.debugger.detach(target).catch(() => {});
        }

        // Step 4: wait for page reaction
        if (waitAfter > 0) await new Promise((r) => setTimeout(r, waitAfter));

        send({
          type: "tool_result",
          toolCallId,
          content: [{ type: "text", text: `🖱 Clicked element "${tagName}" at (${Math.round(x)}, ${Math.round(y)})` }],
          isError: false,
        });
      } catch (err) {
        send({
          type: "tool_result",
          toolCallId,
          content: [{ type: "text", text: `❌ click_element error: ${(err as Error).message}` }],
          isError: true,
        });
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Chrome Messaging
    // ═══════════════════════════════════════════════════════════════════

    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== "state") return;
      ports.add(port);
      // Send a full snapshot on connect so the panel is in sync.
      try {
        port.postMessage({ type: "state", state });
      } catch {
        ports.delete(port);
        return;
      }
      port.onDisconnect.addListener(() => ports.delete(port));
    });

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      (async () => {
      switch (msg.type) {
        case "get_state":
          sendResponse(state);
          break;

        case "prompt":
          pushMessage({ id: crypto.randomUUID(), role: "user", content: msg.message, timestamp: Date.now() });
          send({ type: "prompt", message: msg.message, pageContext: msg.pageContext ?? state.pageContext ?? undefined });
          sendResponse(true);
          break;

        case "summarize":
          getPageContext().then((ctx) => {
            if (!ctx) {
              pushMessage({ id: crypto.randomUUID(), role: "system", content: "⚠️ 无法获取页面内容，请确保页面已完全加载。", timestamp: Date.now() });
              return;
            }
            pushMessage({ id: crypto.randomUUID(), role: "user", content: "请用中文总结这个页面", timestamp: Date.now() });
            send({ type: "prompt", message: "请用中文总结这个页面", pageContext: ctx });
          });
          sendResponse(true);
          return true;

        case "abort":
          send({ type: "abort" });
          patch({ isProcessing: false });
          sendResponse(true);
          break;

        case "reconnect":
          connect();
          sendResponse(true);
          break;

        case "clear_messages":
          patch({ messages: [] });
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "new_session" }) + "\n");
          }
          sendResponse(true);
          break;

        case "page_context_ready":
          patch({ pageContext: msg.pageContext });
          if (state.connected) {
            send({ type: "page_context_update", pageContext: msg.pageContext });
          }
          // Also query the new page's mod status so the 🎨 button reflects it.
          queryPageMods();
          sendResponse(true);
          break;

        case "page_mods_status":
          patch({ pageMods: { origin: msg.origin, count: msg.count, applied: msg.applied, css: msg.css } as PageModsStatus });
          sendResponse(true);
          break;

        case "toggle_page_mods": {
          // Forward to content script of active tab.
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.id) {
              await chrome.tabs.sendMessage(tab.id, { type: "toggle_page_mods", action: msg.action });
            }
          } catch { /* ignore */ }
          sendResponse(true);
          break;
        }

        case "revert_page_mods": {
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.id) {
              await chrome.tabs.sendMessage(tab.id, { type: "revert_page_mods" });
            }
          } catch { /* ignore */ }
          sendResponse(true);
          break;
        }

        default:
          sendResponse(undefined);
      }
      })();
      return true; // async response
    });

    // ═══════════════════════════════════════════════════════════════════
    //  Side Panel & Commands
    // ═══════════════════════════════════════════════════════════════════

    console.log("[bg] Setting up side panel...");

    // Set global side panel options (works for all tabs)
    chrome.sidePanel.setOptions({
      path: "sidepanel.html",
      enabled: true,
    }).catch(() => {});

    // Make action button open the side panel (official Chrome API)
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      .then(() => console.log("[bg] Side panel: openPanelOnActionClick enabled"))
      .catch((err) => console.warn("[bg] setPanelBehavior not supported:", err));

    // Update page context on tab switch (so AI knows which page we're on)
    chrome.tabs.onActivated.addListener(async ({ tabId }) => {
      chrome.sidePanel.setOptions({
        tabId,
        path: "sidepanel.html",
        enabled: true,
      }).catch(() => {});

      // Update page context for the new tab
      try {
        const tab = await chrome.tabs.get(tabId);
        const ctx: PageContext = {
          url: tab.url ?? "",
          title: tab.title ?? "",
          textContent: "",
          extractedAt: Date.now(),
        };
        patch({ pageContext: ctx });
        if (state.connected && ws?.readyState === WebSocket.OPEN) {
          send({ type: "page_context_update", pageContext: ctx });
        }
      } catch {}
      queryPageMods();
    });

    // Detect navigation to update page context (critical for chrome:// etc. where content script doesn't run)
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status === "complete" && tab.active) {
        chrome.tabs.get(tabId).then((t) => {
          const ctx: PageContext = {
            url: t.url ?? "",
            title: t.title ?? "",
            textContent: "",
            extractedAt: Date.now(),
          };
          patch({ pageContext: ctx });
          if (state.connected && ws?.readyState === WebSocket.OPEN) {
            send({ type: "page_context_update", pageContext: ctx });
          }
        }).catch(() => {});
        queryPageMods();
      }
    });

    // Keyboard shortcut as fallback
    chrome.commands.onCommand.addListener((command) => {
      if (command === "toggle_side_panel") {
        chrome.sidePanel
          .open({})
          .catch((err) => console.warn("[bg] Failed to open side panel:", err));
      }
    });

    // ═══════════════════════════════════════════════════════════════════
    //  Init
    // ═══════════════════════════════════════════════════════════════════

    loadPersistedState();
    connect();
    chrome.runtime.onStartup.addListener(connect);

    // Keep service worker alive while side panel is open (prevents ~30s kill cycle)
    chrome.alarms.create("pi-keepalive", { periodInMinutes: 0.3 }); // every 18 seconds
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === "pi-keepalive") {
        // No-op: just having the alarm handler keeps the service worker alive
      }
    });
  },
});

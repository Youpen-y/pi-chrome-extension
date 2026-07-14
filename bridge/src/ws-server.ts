/**
 * WebSocket Server
 *
 * Accepts connections from the Chrome Extension and bridges
 * messages to/from the pi Agent.
 */

import { WebSocketServer as WsServer, WebSocket } from "ws";
import { createServer, type Server } from "node:http";
import type { BridgeConfig } from "./config.js";
import { PiAgent } from "./pi-agent.js";
import type {
  ExtensionToBridge,
  BridgeToExtension,
  ToolCallRequest,
  ToolResultContentBlock,
  PageContext,
} from "./types.js";
import { v4 as uuid } from "uuid";

export class BridgeServer {
  private config: BridgeConfig;
  private wss: WsServer | null = null;
  private httpServer: Server | null = null;
  private agent: PiAgent | null = null;
  private connections = new Set<WebSocket>();
  /** Idempotency guard: stop() may be invoked twice (double SIGINT under tsx watch). */
  private stopping = false;
  private stopPromise: Promise<void> | null = null;

  constructor(config: BridgeConfig) {
    this.config = config;
  }

  /**
   * Start the bridge server.
   */
  async start(): Promise<void> {
    const { host } = this.config;
    let port = this.config.port;

    // ── Start pi Agent ───────────────────────────────────────────────
    this.agent = await this.createPiAgent();

    // ── Try to listen, auto-increment port if busy ───────────────────
    return this.tryListen(host, port, 1);
  }

  private async tryListen(host: string, port: number, attempt: number): Promise<void> {
    if (attempt > 10) {
      throw new Error(`Could not find an available port after 10 attempts (tried ${this.config.port}-${this.config.port + 10})`);
    }

    // Fresh HTTP + WS server per attempt (listen() can only be called once per server)
    const httpServer = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", version: "0.1.0", port }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const wss = new WsServer({ server: httpServer });
    wss.on("connection", (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    // If we had a previous server, close it before replacing
    if (this.httpServer) {
      try { this.httpServer.close(); } catch {}
    }
    this.httpServer = httpServer;
    this.wss = wss;

    return new Promise((resolve, reject) => {
      httpServer.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.log(`[bridge] Port ${port} in use, trying ${port + 1}...`);
          resolve(this.tryListen(host, port + 1, attempt + 1));
        } else {
          reject(err);
        }
      });

      httpServer.listen(port, host, () => {
        // Write bridge info so the extension can discover the actual port
        const info = { url: `ws://${host}:${port}`, port, host, version: "0.1.0" };
        try {
          const fs = require("node:fs");
          const path = require("node:path");
          const infoPath = path.join(process.cwd(), ".bridge-info.json");
          fs.writeFileSync(infoPath, JSON.stringify(info, null, 2) + "\n");
        } catch { /* best-effort */ }

        console.log("");
        console.log("  ┌──────────────────────────────────────────────────┐");
        console.log(`  │  🔗  Bridge URL:  ws://${host}:${port}${' '.repeat(Math.max(0, 32 - `${host}:${port}`.length))}│`);
        console.log(`  │  🏥  Health:      http://${host}:${port}/health${' '.repeat(Math.max(0, 28 - `${host}:${port}`.length))}│`);
        console.log("  └──────────────────────────────────────────────────┘");
        console.log("");
        resolve();
      });
    });
  }

  /**
   * Stop the bridge server gracefully.
   */
  async stop(): Promise<void> {
    // Idempotent: concurrent callers share the same shutdown. This prevents the
    // double-SIGINT under `tsx watch` from running close()/dispose() twice and
    // racing itself.
    if (this.stopping) return this.stopPromise ?? Promise.resolve();
    this.stopping = true;
    this.stopPromise = this.doStop();
    return this.stopPromise;
  }

  private async doStop(): Promise<void> {
    console.log("[bridge] Shutting down...");

    // Force exit after 3s no matter what
    const forceExit = setTimeout(() => {
      console.log("[bridge] Force exit after timeout");
      process.exit(0);
    }, 3000);
    forceExit.unref();

    // Close all WebSocket connections
    for (const ws of this.connections) {
      ws.close(1001, "Server shutting down");
    }
    this.connections.clear();

    // Dispose agent
    try { this.agent?.dispose(); } catch {}

    // Close server
    return new Promise((resolve) => {
      let closed = false;
      const done = () => {
        if (closed) return;
        closed = true;
        console.log("[bridge] Server stopped");
        resolve();
      };
      this.wss?.close(() => {
        this.httpServer?.close(done);
      });
      // If wss is null, close httpServer directly
      if (!this.wss) {
        this.httpServer?.close(done);
      }
    });
  }

  // ── Private ───────────────────────────────────────────────────────

  private async createPiAgent(): Promise<PiAgent> {
    const agent = new PiAgent({
      config: this.config,
      onTextDelta: (delta: string) => {
        this.broadcast({ type: "message_delta", delta });
      },
      onAgentEvent: (event) => {
        const msg = this.agentEventToBridgeEvent(event);
        if (msg) this.broadcast(msg);
      },
      forwardToolCall: (toolCallId, toolName, args) => {
        const toolCall: ToolCallRequest & { type: "tool_call" } = {
          type: "tool_call",
          toolCallId,
          toolName,
          args,
        };
        this.broadcast(toolCall);
      },
    });

    await agent.initialize();
    return agent;
  }

  private handleConnection(ws: WebSocket): void {
    this.connections.add(ws);
    // Track authentication state on the WebSocket object itself
    (ws as any).authenticated = false;

    console.log(`[bridge] Client connected (total: ${this.connections.size})`);

    ws.on("message", (raw: Buffer) => {
      try {
        const text = raw.toString("utf-8").trim();
        const lines = text.split("\n");
        for (const line of lines) {
          if (!line) continue;
          const msg: ExtensionToBridge = JSON.parse(line);
          this.handleMessage(ws, msg);
        }
      } catch (err) {
        this.sendJson(ws, {
          type: "error",
          code: "PARSE_ERROR",
          message: `Failed to parse message: ${(err as Error).message}`,
        });
      }
    });

    ws.on("close", () => {
      this.connections.delete(ws);
      console.log(`[bridge] Client disconnected (total: ${this.connections.size})`);
    });

    ws.on("error", (err) => {
      console.error(`[bridge] WebSocket error:`, err.message);
      this.connections.delete(ws);
    });

    this.sendJson(ws, {
      type: "response",
      command: "connect",
      success: true,
      data: { message: "Connected to pi bridge", version: "0.1.0", authenticated: false },
    });
  }

  private handleMessage(ws: WebSocket, msg: ExtensionToBridge): void {
    // ── Auth ────────────────────────────────────────────────────────
    if (msg.type === "auth") {
      if (this.config.authToken && msg.token !== this.config.authToken) {
        this.sendJson(ws, { type: "auth_error", message: "Invalid token" });
        return;
      }
      const sessionId = uuid();
      (ws as any).authenticated = true;
      (ws as any).sessionId = sessionId;
      this.sendJson(ws, { type: "auth_ok", sessionId, bridgeVersion: "0.1.0" });
      console.log(`[bridge] Client authenticated (session: ${sessionId})`);
      return;
    }

    // Check authentication
    if (!(ws as any).authenticated && this.config.authToken) {
      this.sendJson(ws, { type: "auth_error", message: "Authentication required. Send auth message first." });
      return;
    }

    // ── Route commands ──────────────────────────────────────────────
    switch (msg.type) {
      case "prompt":
        this.logRecv(msg);
        this.handlePrompt(msg.id, msg.message, msg.pageContext, msg.images);
        break;

      case "steer":
        this.handleSteer(msg.message, msg.pageContext);
        break;

      case "follow_up":
        this.handleFollowUp(msg.message);
        break;

      case "abort":
        this.handleAbort();
        break;

      case "tool_result":
        this.logRecv(msg);
        this.handleToolResult(msg.toolCallId, msg.content, msg.isError);
        break;

      case "page_context_update":
        // Store updated page context for next prompt
        this.logRecv(msg);
        console.log(`[bridge] Page context updated: ${msg.pageContext.title}`);
        break;

      case "get_state":
        this.sendJson(ws, {
          type: "response",
          command: "get_state",
          success: true,
          data: this.agent?.getState() ?? null,
        });
        break;

      case "new_session":
        this.handleNewSession();
        break;

      case "set_model":
        console.log(`[bridge] Model change requested: ${msg.provider}/${msg.modelId}`);
        // TODO: implement model switching
        break;

      case "set_thinking_level":
        this.agent?.setThinkingLevel(msg.level);
        break;

      default:
        this.sendJson(ws, {
          type: "error",
          code: "UNKNOWN_COMMAND",
          message: `Unknown command: ${(msg as any).type}`,
        });
    }
  }

  private async handlePrompt(
    id: string | undefined,
    message: string,
    pageContext?: PageContext,
    images?: { type: "image"; data: string; mimeType: string }[],
  ): Promise<void> {
    if (!this.agent) {
      this.broadcast({ type: "error", code: "AGENT_NOT_READY", message: "Agent is not initialized" });
      return;
    }

    try {
      await this.agent.prompt(message, pageContext, images);

      // Send response acknowledgment if id was provided
      if (id) {
        this.broadcast({ type: "response", command: "prompt", success: true, data: { id } });
      }
    } catch (err) {
      console.error(`[bridge] prompt error:`, (err as Error).message);
      this.broadcast({
        type: "error",
        code: "PROMPT_ERROR",
        message: (err as Error).message,
      });
    }
  }

  private async handleSteer(message: string, pageContext?: PageContext): Promise<void> {
    if (!this.agent) return;
    try {
      await this.agent.steer(message, pageContext);
    } catch (err) {
      console.error("[bridge] steer error:", err);
    }
  }

  private async handleFollowUp(message: string): Promise<void> {
    if (!this.agent) return;
    try {
      await this.agent.followUp(message);
    } catch (err) {
      console.error("[bridge] follow_up error:", err);
    }
  }

  private async handleAbort(): Promise<void> {
    if (!this.agent) return;
    try {
      await this.agent.abort();
    } catch (err) {
      console.error("[bridge] abort error:", err);
    }
  }

  private async handleNewSession(): Promise<void> {
    console.log("[bridge] New session — disposing old agent and creating fresh one");
    try {
      // Dispose old agent
      this.agent?.dispose();
    } catch (err) {
      console.error("[bridge] dispose error:", err);
    }
    // Create a fresh agent (new AgentSession = no history)
    this.agent = await this.createPiAgent();
    this.broadcast({ type: "new_session_ok" });
    console.log("[bridge] New session ready");
  }

  private handleToolResult(
    toolCallId: string,
    content: ToolResultContentBlock[],
    isError?: boolean,
  ): void {
    if (!this.agent) return;
    this.agent.resolveTool(toolCallId, { content, isError });
  }

  // ── Helpers ───────────────────────────────────────────────────────

  /** Log a received message (truncated for readability) */
  private logRecv(msg: ExtensionToBridge): void {
    const type = msg.type;
    const detail =
      msg.type === "prompt"
        ? `message="${msg.message.substring(0, 60)}${msg.message.length > 60 ? "…" : ""}"`
        : msg.type === "tool_result"
          ? `toolCallId=${msg.toolCallId}`
          : msg.type === "page_context_update"
            ? `title="${msg.pageContext.title.substring(0, 50)}…"`
            : "";
    console.log(`  ◀ RECV ${type}${detail ? " " + detail : ""}`);
  }

  /** Log a sent message (truncated) */
  private logSend(msg: BridgeToExtension): void {
    const type = msg.type;
    const detail =
      msg.type === "message_delta"
        ? `delta="${(msg as any).delta?.substring(0, 30)}"`
        : msg.type === "message_update"
          ? `event=${(msg as any).assistantMessageEvent?.type}`
          : msg.type === "error"
            ? `code=${(msg as any).code} message="${(msg as any).message?.substring(0, 40)}"`
            : msg.type === "turn_start"
              ? "—"
              : msg.type === "turn_end"
                ? "—"
                : "";
    console.log(`  ▶ SEND ${type}${detail ? " " + detail : ""}`);
  }

  private sendJson(ws: WebSocket, msg: BridgeToExtension): void {
    if (ws.readyState === WebSocket.OPEN) {
      this.logSend(msg);
      ws.send(JSON.stringify(msg) + "\n");
    }
  }

  private broadcast(msg: BridgeToExtension): void {
    const data = JSON.stringify(msg) + "\n";
    this.logSend(msg);
    for (const ws of this.connections) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  private agentEventToBridgeEvent(event: any): BridgeToExtension | null {
    // Map pi SDK AgentSessionEvent to our BridgeToExtension format
    switch (event.type) {
      case "agent_start":
        return { type: "agent_start" };
      case "agent_end":
        return { type: "agent_end", messages: event.messages };
      case "turn_start":
        return { type: "turn_start" };
      case "turn_end":
        return { type: "turn_end" };
      case "message_update": {
        // text_delta is handled separately via onTextDelta — skip to avoid double-append
        if (event.assistantMessageEvent.type === "text_delta") return null;
        // Forward other events (thinking_delta, text_start, done, error, etc.)
        return {
          type: "message_update",
          assistantMessageEvent: event.assistantMessageEvent,
        };
      }
      case "tool_execution_start":
        return {
          type: "tool_execution_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args ?? {},
        };
      case "tool_execution_end":
        return {
          type: "tool_execution_update",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          partialResult: event.result,
        };
      case "queue_update":
        return {
          type: "queue_update",
          steering: event.steering ?? [],
          followUp: event.followUp ?? [],
        };
      case "compaction_start":
        return { type: "compaction_start", reason: event.reason };
      case "compaction_end":
        return { type: "compaction_end", result: event.result };
      default:
        return null;
    }
  }
}

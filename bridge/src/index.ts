#!/usr/bin/env node

/**
 * pi Chrome Extension Bridge - Entry Point
 *
 * Starts the local bridge service that connects the Chrome extension
 * to the pi coding agent using pi SDK.
 *
 * Usage:
 *   npm run start          # Start with default config
 *   PI_CHROME_PORT=18731 npm run start  # Custom port
 *   PI_CHROME_TOKEN=xxx npm run start   # With auth token
 */

import { loadConfig } from "./config.js";
import { BridgeServer } from "./ws-server.js";

// ── Handle signals for graceful shutdown ────────────────────────────────

async function main() {
  const config = loadConfig();

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   pi Chrome Extension Bridge Service         ║");
  console.log("╠══════════════════════════════════════════════╣");
  console.log(`║  Port:       ${String(config.port).padEnd(34)}║`);
  console.log(`║  Host:       ${config.host.padEnd(34)}║`);
  console.log(`║  Auth:       ${config.authToken ? "Token".padEnd(34) : "None".padEnd(34)}║`);
  console.log(`║  Agent Dir:  ${(config.agentDir ?? "~/.pi/agent").padEnd(34)}║`);
  console.log("╚══════════════════════════════════════════════╝");

  const server = new BridgeServer(config);

  // Graceful shutdown — guarded against double-invocation. Under `tsx watch`, a
  // Ctrl-C delivers SIGINT both directly to the child (process-group signal) and
  // again via tsx's own forwarding. Without idempotency, stop() runs twice and
  // races itself, keeping the process alive past tsx's 5s kill window.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[bridge] Received ${signal}, shutting down...`);
    server.stop().catch(() => {});
    // Exit immediately — stop() has its own 3s force timeout
    setTimeout(() => process.exit(0), 100);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    console.error("[bridge] Uncaught exception:", err);
    server.stop().catch(() => {});
    setTimeout(() => process.exit(1), 100);
  });

  await server.start();
}

main().catch((err) => {
  console.error("[bridge] Fatal error:", err);
  process.exit(1);
});

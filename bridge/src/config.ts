/**
 * Bridge Service Configuration
 */

export interface BridgeConfig {
  /** WebSocket server port (default: 18731) */
  port: number;
  /** Host to bind (default: "127.0.0.1") */
  host: string;
  /** Authentication token (optional, set via PI_CHROME_TOKEN env) */
  authToken?: string;
  /** pi agent dir (default: ~/.pi/agent) */
  agentDir?: string;
  /** Default model provider */
  defaultProvider?: string;
  /** Default model ID */
  defaultModel?: string;
  /** Default thinking level */
  defaultThinkingLevel?: string;
  /** Session storage directory */
  sessionDir?: string;
  /** Max page context length in characters (default: 50000) */
  maxPageContextLength: number;
  /** Log level: "debug" | "info" | "warn" | "error" */
  logLevel: string;
}

import { getAgentDir } from "@earendil-works/pi-coding-agent";

const DEFAULT_CONFIG: BridgeConfig = {
  port: 18731,
  host: "127.0.0.1",
  agentDir: getAgentDir(),
  maxPageContextLength: 50_000,
  logLevel: "info",
};

export function loadConfig(overrides?: Partial<BridgeConfig>): BridgeConfig {
  return {
    ...DEFAULT_CONFIG,
    port: parseInt(process.env.PI_CHROME_PORT ?? "", 10) || DEFAULT_CONFIG.port,
    host: process.env.PI_CHROME_HOST ?? DEFAULT_CONFIG.host,
    authToken: process.env.PI_CHROME_TOKEN ?? DEFAULT_CONFIG.authToken,
    agentDir: process.env.PI_AGENT_DIR ?? DEFAULT_CONFIG.agentDir,
    defaultProvider: process.env.PI_CHROME_PROVIDER ?? DEFAULT_CONFIG.defaultProvider,
    defaultModel: process.env.PI_CHROME_MODEL ?? DEFAULT_CONFIG.defaultModel,
    defaultThinkingLevel: process.env.PI_CHROME_THINKING ?? DEFAULT_CONFIG.defaultThinkingLevel,
    sessionDir: process.env.PI_CHROME_SESSION_DIR ?? DEFAULT_CONFIG.sessionDir,
    maxPageContextLength:
      parseInt(process.env.PI_CHROME_MAX_CONTEXT ?? "", 10) || DEFAULT_CONFIG.maxPageContextLength,
    logLevel: process.env.PI_CHROME_LOG_LEVEL ?? DEFAULT_CONFIG.logLevel,
    ...overrides,
  };
}

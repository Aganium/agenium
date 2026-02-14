/**
 * @agenium/mcp-server — Types
 *
 * Shared type definitions for the MCP ↔ AGENIUM bridge.
 */

// ============================================================================
// MCP Server Configuration
// ============================================================================

/** Stdio-based MCP server (spawns a child process) */
export interface MCPStdioConfig {
  transport: 'stdio';
  /** Command to run (e.g. 'npx', 'python3', 'node') */
  command: string;
  /** Arguments to the command */
  args?: string[];
  /** Working directory */
  cwd?: string;
  /** Environment variables (merged with process.env) */
  env?: Record<string, string>;
}

/** HTTP/SSE-based MCP server (connects to running server) */
export interface MCPHttpConfig {
  transport: 'sse';
  /** URL of the running MCP server's SSE endpoint */
  url: string;
  /** Optional headers for authentication */
  headers?: Record<string, string>;
}

/** Streamable HTTP transport (MCP v2-style) */
export interface MCPStreamableHttpConfig {
  transport: 'streamable-http';
  /** URL of the MCP server endpoint */
  url: string;
  /** Optional headers for authentication */
  headers?: Record<string, string>;
}

export type MCPServerConfig = MCPStdioConfig | MCPHttpConfig | MCPStreamableHttpConfig;

// ============================================================================
// Bridge Configuration
// ============================================================================

export interface MCPBridgeConfig {
  /** Agent name on the AGENIUM network (e.g. 'weather-tools') */
  name: string;

  /** MCP server configuration */
  mcp: MCPServerConfig;

  /** AGENIUM agent options */
  agent?: {
    /** Port to listen on (default: auto) */
    port?: number;
    /** DNS server address (default: 185.204.169.26) */
    dnsServer?: string;
    /** DNS server port (default: 3000) */
    dnsPort?: number;
    /** Whether to auto-register on DNS (default: true) */
    autoRegister?: boolean;
    /** Public host/IP for DNS registration endpoint */
    publicHost?: string;
    /** Data directory for agent state */
    dataDir?: string;
  };

  /** Bridge behavior */
  bridge?: {
    /** Timeout for MCP tool calls in ms (default: 30000) */
    toolCallTimeoutMs?: number;
    /** Whether to expose resources as capabilities (default: true) */
    exposeResources?: boolean;
    /** Whether to expose prompts as capabilities (default: true) */
    exposePrompts?: boolean;
    /** Log level */
    logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  };
}

// ============================================================================
// Tool Info (normalized from MCP)
// ============================================================================

export interface MCPToolInfo {
  /** Tool name */
  name: string;
  /** Tool description */
  description?: string;
  /** JSON Schema for the tool's input */
  inputSchema: Record<string, unknown>;
}

export interface MCPResourceInfo {
  /** Resource URI */
  uri: string;
  /** Resource name */
  name: string;
  /** Description */
  description?: string;
  /** MIME type */
  mimeType?: string;
}

export interface MCPPromptInfo {
  /** Prompt name */
  name: string;
  /** Description */
  description?: string;
  /** Arguments the prompt accepts */
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

// ============================================================================
// Bridge State
// ============================================================================

export enum BridgeState {
  IDLE = 'IDLE',
  CONNECTING = 'CONNECTING',
  READY = 'READY',
  REGISTERED = 'REGISTERED',
  ERROR = 'ERROR',
  STOPPED = 'STOPPED',
}

// ============================================================================
// Bridge Events
// ============================================================================

export interface BridgeEvents {
  ready: { tools: MCPToolInfo[]; resources: MCPResourceInfo[]; prompts: MCPPromptInfo[] };
  registered: { name: string; endpoint: string };
  'tool:call': { tool: string; sessionId: string };
  'tool:result': { tool: string; sessionId: string; durationMs: number };
  'tool:error': { tool: string; sessionId: string; error: string };
  error: Error;
  stopped: void;
}

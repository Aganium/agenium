/**
 * @agenium/mcp-server — MCP Transport Manager
 *
 * Manages the connection to an MCP server (stdio, SSE, or streamable HTTP).
 * Provides a unified interface for listing tools, calling tools, etc.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  MCPServerConfig,
  MCPToolInfo,
  MCPResourceInfo,
  MCPPromptInfo,
} from './types.js';

// ============================================================================
// MCP Transport Manager
// ============================================================================

/** Wrap a promise with a timeout */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export class MCPTransportManager {
  private client: Client;
  private transport: StdioClientTransport | SSEClientTransport | null = null;
  private config: MCPServerConfig;
  private connected = false;
  private connectTimeoutMs: number;
  private callTimeoutMs: number;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private reconnectDelayMs = 1000;

  constructor(config: MCPServerConfig, opts?: { connectTimeoutMs?: number; callTimeoutMs?: number }) {
    this.config = config;
    this.connectTimeoutMs = opts?.connectTimeoutMs ?? 15_000;
    this.callTimeoutMs = opts?.callTimeoutMs ?? 30_000;
    this.client = new Client(
      { name: 'agenium-mcp-bridge', version: '0.1.0' },
      { capabilities: {} },
    );
  }

  /** Connect to the MCP server */
  async connect(): Promise<void> {
    if (this.connected) return;

    switch (this.config.transport) {
      case 'stdio': {
        this.transport = new StdioClientTransport({
          command: this.config.command,
          args: this.config.args,
          cwd: this.config.cwd,
          env: this.config.env
            ? { ...process.env, ...this.config.env } as Record<string, string>
            : undefined,
        });
        break;
      }
      case 'sse': {
        this.transport = new SSEClientTransport(
          new URL(this.config.url),
          {
            requestInit: this.config.headers
              ? { headers: this.config.headers }
              : undefined,
          } as any, // SSE transport options vary by version
        );
        break;
      }
      case 'streamable-http': {
        // Streamable HTTP uses the same SSE transport in v1 SDK
        // In v2 it would use StreamableHTTPClientTransport
        this.transport = new SSEClientTransport(
          new URL(this.config.url),
          {
            requestInit: this.config.headers
              ? { headers: this.config.headers }
              : undefined,
          } as any,
        );
        break;
      }
      default:
        throw new Error(`Unsupported MCP transport: ${(this.config as any).transport}`);
    }

    await withTimeout(
      this.client.connect(this.transport),
      this.connectTimeoutMs,
      'MCP connect',
    );
    this.connected = true;
    this.reconnectAttempts = 0;
  }

  /** Attempt to reconnect after a failure */
  async reconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      throw new Error(`MCP reconnect failed after ${this.maxReconnectAttempts} attempts`);
    }
    this.reconnectAttempts++;
    const delay = this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1);

    await new Promise((r) => setTimeout(r, delay));

    // Reset state
    this.connected = false;
    this.transport = null;
    this.client = new Client(
      { name: 'agenium-mcp-bridge', version: '0.1.0' },
      { capabilities: {} },
    );

    await this.connect();
  }

  /** Execute a call with auto-reconnect on connection failure */
  private async withReconnect<T>(fn: () => Promise<T>, label: string): Promise<T> {
    try {
      return await withTimeout(fn(), this.callTimeoutMs, label);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      // Reconnect on connection-level failures, not on tool logic errors
      if (msg.includes('closed') || msg.includes('ECONNREFUSED') || msg.includes('EPIPE') || msg.includes('not connected')) {
        this.connected = false;
        await this.reconnect();
        return await withTimeout(fn(), this.callTimeoutMs, `${label} (retry)`);
      }
      throw err;
    }
  }

  /** Disconnect from the MCP server */
  async disconnect(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.client.close();
    } catch {
      // Ignore close errors
    }
    this.transport = null;
    this.connected = false;
  }

  /** Check if connected */
  isConnected(): boolean {
    return this.connected;
  }

  // ============================================================================
  // Tool Operations
  // ============================================================================

  /** List all tools exposed by the MCP server */
  async listTools(): Promise<MCPToolInfo[]> {
    this.ensureConnected();
    const result = await this.withReconnect(
      () => this.client.listTools(),
      'listTools',
    );
    return (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  }

  /** Call a tool on the MCP server */
  async callTool(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean;
  }> {
    this.ensureConnected();
    const result = await this.withReconnect(
      () => this.client.callTool({ name, arguments: args }),
      `callTool(${name})`,
    );
    return {
      content: (result.content as any[]) ?? [],
      isError: result.isError as boolean | undefined,
    };
  }

  // ============================================================================
  // Resource Operations
  // ============================================================================

  /** List all resources */
  async listResources(): Promise<MCPResourceInfo[]> {
    this.ensureConnected();
    try {
      const result = await this.withReconnect(
        () => this.client.listResources(),
        'listResources',
      );
      return (result.resources ?? []).map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));
    } catch {
      // Server may not support resources
      return [];
    }
  }

  /** Read a resource */
  async readResource(uri: string): Promise<{
    contents: Array<{ uri: string; text?: string; blob?: string; mimeType?: string }>;
  }> {
    this.ensureConnected();
    const result = await this.withReconnect(
      () => this.client.readResource({ uri }),
      `readResource(${uri})`,
    );
    return {
      contents: (result.contents as any[]) ?? [],
    };
  }

  // ============================================================================
  // Prompt Operations
  // ============================================================================

  /** List all prompts */
  async listPrompts(): Promise<MCPPromptInfo[]> {
    this.ensureConnected();
    try {
      const result = await this.withReconnect(
        () => this.client.listPrompts(),
        'listPrompts',
      );
      return (result.prompts ?? []).map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments?.map((a) => ({
          name: a.name,
          description: a.description,
          required: a.required,
        })),
      }));
    } catch {
      // Server may not support prompts
      return [];
    }
  }

  /** Get a prompt */
  async getPrompt(
    name: string,
    args?: Record<string, string>,
  ): Promise<{
    description?: string;
    messages: Array<{ role: string; content: { type: string; text?: string } }>;
  }> {
    this.ensureConnected();
    const result = await this.withReconnect(
      () => this.client.getPrompt({ name, arguments: args }),
      `getPrompt(${name})`,
    );
    return {
      description: result.description,
      messages: (result.messages as any[]) ?? [],
    };
  }

  // ============================================================================
  // Server Info
  // ============================================================================

  /** Get MCP server info (if available after connect) */
  getServerInfo(): { name?: string; version?: string } | null {
    if (!this.connected) return null;
    const info = (this.client as any).getServerVersion?.() ?? null;
    return info;
  }

  // ============================================================================
  // Internal
  // ============================================================================

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error('MCP transport not connected. Call connect() first.');
    }
  }
}

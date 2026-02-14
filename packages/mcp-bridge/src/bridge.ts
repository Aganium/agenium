/**
 * @agenium/mcp-server — MCPBridge
 *
 * The main class that bridges an MCP server to the AGENIUM agent:// network.
 *
 * Flow:
 * 1. Spawns/connects to an MCP server
 * 2. Discovers its tools, resources, and prompts
 * 3. Creates an AGENIUM agent that exposes these as agent:// capabilities
 * 4. Optionally registers on the AGENIUM DNS
 * 5. Translates incoming agent:// requests to MCP calls
 */

import { EventEmitter } from 'node:events';
import { createAgent, Agent } from 'agenium';
import { z } from 'zod';
import { MCPTransportManager } from './mcp-transport.js';
import {
  MCPBridgeConfig,
  MCPToolInfo,
  MCPResourceInfo,
  MCPPromptInfo,
  BridgeState,
} from './types.js';

// ============================================================================
// Defaults
// ============================================================================

const DEFAULTS = {
  port: 0, // auto-assign
  dnsServer: '185.204.169.26',
  dnsPort: 3000,
  autoRegister: true,
  toolCallTimeoutMs: 30_000,
  exposeResources: true,
  exposePrompts: true,
  logLevel: 'info' as const,
};

// ============================================================================
// MCPBridge
// ============================================================================

export class MCPBridge extends EventEmitter {
  private config: MCPBridgeConfig;
  private mcpTransport: MCPTransportManager;
  private agent: Agent | null = null;
  private state: BridgeState = BridgeState.IDLE;

  // Discovered capabilities
  private tools: MCPToolInfo[] = [];
  private resources: MCPResourceInfo[] = [];
  private prompts: MCPPromptInfo[] = [];

  // Stats
  private stats = {
    toolCalls: 0,
    toolErrors: 0,
    resourceReads: 0,
    promptGets: 0,
    startedAt: 0,
  };

  // Compiled Zod validators per tool (lazy, built on first call)
  private toolValidators = new Map<string, z.ZodType>();

  constructor(config: MCPBridgeConfig) {
    super();
    this.config = config;
    this.mcpTransport = new MCPTransportManager(config.mcp, {
      connectTimeoutMs: 15_000,
      callTimeoutMs: config.bridge?.toolCallTimeoutMs ?? DEFAULTS.toolCallTimeoutMs,
    });
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /** Start the bridge: connect to MCP server, discover tools, start AGENIUM agent */
  async start(): Promise<void> {
    if (this.state === BridgeState.READY || this.state === BridgeState.REGISTERED) {
      throw new Error('Bridge already started');
    }

    this.setState(BridgeState.CONNECTING);
    this.stats.startedAt = Date.now();

    try {
      // 1. Connect to MCP server
      this.log('info', `Connecting to MCP server (${this.config.mcp.transport})...`);
      await this.mcpTransport.connect();
      this.log('info', 'MCP server connected');

      // 2. Discover capabilities
      await this.discoverCapabilities();

      // 3. Create and start AGENIUM agent
      await this.startAgent();

      this.setState(BridgeState.READY);
      this.emit('ready', {
        tools: this.tools,
        resources: this.resources,
        prompts: this.prompts,
      });

      // 4. Register on DNS (if configured)
      if (this.config.agent?.autoRegister !== false) {
        await this.register();
      }
    } catch (err) {
      this.setState(BridgeState.ERROR);
      this.emit('error', err);
      throw err;
    }
  }

  /** Stop the bridge gracefully */
  async stop(): Promise<void> {
    this.log('info', 'Stopping bridge...');

    if (this.agent) {
      await this.agent.stop();
      this.agent = null;
    }

    await this.mcpTransport.disconnect();
    this.setState(BridgeState.STOPPED);
    this.emit('stopped');
  }

  // ============================================================================
  // Discovery
  // ============================================================================

  /** Discover tools, resources, and prompts from the MCP server */
  private async discoverCapabilities(): Promise<void> {
    this.log('info', 'Discovering MCP capabilities...');

    // Tools (always)
    this.tools = await this.mcpTransport.listTools();
    this.log('info', `Found ${this.tools.length} tools: ${this.tools.map((t) => t.name).join(', ')}`);

    // Resources
    if (this.config.bridge?.exposeResources !== false) {
      this.resources = await this.mcpTransport.listResources();
      if (this.resources.length > 0) {
        this.log('info', `Found ${this.resources.length} resources`);
      }
    }

    // Prompts
    if (this.config.bridge?.exposePrompts !== false) {
      this.prompts = await this.mcpTransport.listPrompts();
      if (this.prompts.length > 0) {
        this.log('info', `Found ${this.prompts.length} prompts`);
      }
    }
  }

  // ============================================================================
  // AGENIUM Agent
  // ============================================================================

  /** Create and start the AGENIUM agent, wire up request handlers */
  private async startAgent(): Promise<void> {
    const port = this.config.agent?.port ?? DEFAULTS.port;
    const dnsServer = this.config.agent?.dnsServer ?? DEFAULTS.dnsServer;
    const dataDir = this.config.agent?.dataDir;

    this.agent = createAgent(this.config.name, {
      listenPort: port,
      dnsServer,
      persistence: true,
      ...(dataDir ? { dataDir } : {}),
    });

    // Wire up protocol handlers
    this.registerHandlers();

    await this.agent.start();
    this.log('info', `AGENIUM agent "${this.config.name}" started`);
  }

  /** Register protocol request handlers on the agent */
  private registerHandlers(): void {
    if (!this.agent) return;

    // ---- tools/list ----
    this.agent.onRequest('tools/list', async () => {
      return {
        tools: this.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      };
    });

    // ---- tools/call ----
    this.agent.onRequest('tools/call', async (_frame, data, sessionId) => {
      const params = data as { name: string; arguments?: Record<string, unknown> };

      if (!params?.name) {
        return { error: { code: 'INVALID_PARAMS', message: 'Missing tool name' } };
      }

      // Verify tool exists
      const tool = this.tools.find((t) => t.name === params.name);
      if (!tool) {
        return {
          error: {
            code: 'TOOL_NOT_FOUND',
            message: `Tool "${params.name}" not found. Available: ${this.tools.map((t) => t.name).join(', ')}`,
          },
        };
      }

      // Validate input against tool's inputSchema
      const validationError = this.validateToolArgs(tool, params.arguments);
      if (validationError) {
        return {
          error: {
            code: 'INVALID_ARGS',
            message: validationError,
          },
        };
      }

      const startTime = Date.now();
      this.stats.toolCalls++;
      this.emit('tool:call', { tool: params.name, sessionId });

      try {
        const result = await this.mcpTransport.callTool(params.name, params.arguments);
        const durationMs = Date.now() - startTime;

        this.emit('tool:result', { tool: params.name, sessionId, durationMs });
        this.log('debug', `Tool ${params.name} completed in ${durationMs}ms`);

        return {
          content: result.content,
          isError: result.isError,
        };
      } catch (err) {
        this.stats.toolErrors++;
        const errorMsg = (err as Error).message;
        this.emit('tool:error', { tool: params.name, sessionId, error: errorMsg });
        this.log('error', `Tool ${params.name} failed: ${errorMsg}`);

        return {
          error: { code: 'TOOL_CALL_FAILED', message: errorMsg },
        };
      }
    });

    // ---- resources/list ----
    this.agent.onRequest('resources/list', async () => {
      return {
        resources: this.resources.map((r) => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        })),
      };
    });

    // ---- resources/read ----
    this.agent.onRequest('resources/read', async (_frame, data) => {
      const params = data as { uri: string };
      if (!params?.uri) {
        return { error: { code: 'INVALID_PARAMS', message: 'Missing resource URI' } };
      }

      this.stats.resourceReads++;

      try {
        const result = await this.mcpTransport.readResource(params.uri);
        return result;
      } catch (err) {
        return {
          error: { code: 'RESOURCE_READ_FAILED', message: (err as Error).message },
        };
      }
    });

    // ---- prompts/list ----
    this.agent.onRequest('prompts/list', async () => {
      return {
        prompts: this.prompts.map((p) => ({
          name: p.name,
          description: p.description,
          arguments: p.arguments,
        })),
      };
    });

    // ---- prompts/get ----
    this.agent.onRequest('prompts/get', async (_frame, data) => {
      const params = data as { name: string; arguments?: Record<string, string> };
      if (!params?.name) {
        return { error: { code: 'INVALID_PARAMS', message: 'Missing prompt name' } };
      }

      this.stats.promptGets++;

      try {
        const result = await this.mcpTransport.getPrompt(params.name, params.arguments);
        return result;
      } catch (err) {
        return {
          error: { code: 'PROMPT_GET_FAILED', message: (err as Error).message },
        };
      }
    });

    // ---- capabilities ----
    this.agent.onRequest('capabilities', async () => {
      return {
        agent: this.config.name,
        protocol: 'mcp-bridge/1.0',
        tools: this.tools.map((t) => t.name),
        resources: this.resources.map((r) => r.uri),
        prompts: this.prompts.map((p) => p.name),
        uptime: Date.now() - this.stats.startedAt,
        stats: { ...this.stats },
      };
    });

    // ---- ping ----
    this.agent.onRequest('ping', async () => {
      return { pong: true, timestamp: Date.now() };
    });

    // ---- health ----
    this.agent.onRequest('health', async () => {
      const mcpConnected = this.mcpTransport.isConnected();
      return {
        status: mcpConnected ? 'healthy' : 'degraded',
        bridge: {
          state: this.state,
          name: this.config.name,
          uri: `agent://${this.config.name}`,
          uptimeMs: this.stats.startedAt > 0 ? Date.now() - this.stats.startedAt : 0,
        },
        mcp: {
          connected: mcpConnected,
          transport: this.config.mcp.transport,
          tools: this.tools.length,
          resources: this.resources.length,
          prompts: this.prompts.length,
        },
        stats: {
          toolCalls: this.stats.toolCalls,
          toolErrors: this.stats.toolErrors,
          resourceReads: this.stats.resourceReads,
          promptGets: this.stats.promptGets,
          errorRate: this.stats.toolCalls > 0
            ? (this.stats.toolErrors / this.stats.toolCalls * 100).toFixed(1) + '%'
            : '0%',
        },
        timestamp: Date.now(),
      };
    });
  }

  // ============================================================================
  // DNS Registration
  // ============================================================================

  /** Register this bridge on the AGENIUM DNS */
  private async register(): Promise<void> {
    if (!this.agent) return;

    const publicHost = this.config.agent?.publicHost;
    if (!publicHost) {
      this.log('warn', 'No publicHost configured — skipping DNS registration. Set agent.publicHost to register on the network.');
      return;
    }

    const dnsServer = this.config.agent?.dnsServer ?? DEFAULTS.dnsServer;
    const dnsPort = this.config.agent?.dnsPort ?? DEFAULTS.dnsPort;
    const registration = this.agent.getDNSRegistration(publicHost);

    // Add MCP tools as capabilities
    registration.capabilities = [
      'mcp-bridge',
      ...this.tools.map((t) => `tool:${t.name}`),
      ...(this.resources.length > 0 ? ['resources'] : []),
      ...(this.prompts.length > 0 ? ['prompts'] : []),
    ];

    try {
      const url = `http://${dnsServer}:${dnsPort}/agent/register`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(registration),
      });

      if (!response.ok) {
        const body = await response.text();
        this.log('warn', `DNS registration failed (${response.status}): ${body}`);
        return;
      }

      const endpoint = registration.endpoint;
      this.setState(BridgeState.REGISTERED);
      this.emit('registered', { name: this.config.name, endpoint });
      this.log('info', `Registered on AGENIUM DNS as agent://${this.config.name}`);
    } catch (err) {
      this.log('warn', `DNS registration failed: ${(err as Error).message}`);
      // Not fatal — bridge still works for direct connections
    }
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /** Get current bridge state */
  getState(): BridgeState {
    return this.state;
  }

  /** Get discovered tools */
  getTools(): MCPToolInfo[] {
    return [...this.tools];
  }

  /** Get discovered resources */
  getResources(): MCPResourceInfo[] {
    return [...this.resources];
  }

  /** Get discovered prompts */
  getPrompts(): MCPPromptInfo[] {
    return [...this.prompts];
  }

  /** Get bridge statistics */
  getStats() {
    return {
      state: this.state,
      tools: this.tools.length,
      resources: this.resources.length,
      prompts: this.prompts.length,
      ...this.stats,
      uptimeMs: this.stats.startedAt > 0 ? Date.now() - this.stats.startedAt : 0,
    };
  }

  /** Get the underlying AGENIUM agent (for advanced use) */
  getAgent(): Agent | null {
    return this.agent;
  }

  /** Get the agent:// URI */
  getURI(): string {
    return `agent://${this.config.name}`;
  }

  // ============================================================================
  // Input Validation
  // ============================================================================

  /**
   * Convert a JSON Schema object to a Zod schema for runtime validation.
   * Handles the common subset: object with typed properties + required.
   */
  private jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
    const type = schema['type'] as string | undefined;

    if (type === 'object') {
      const properties = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
      const required = (schema['required'] ?? []) as string[];
      const shape: Record<string, z.ZodType> = {};

      for (const [key, prop] of Object.entries(properties)) {
        let fieldSchema = this.jsonSchemaToZod(prop);
        if (!required.includes(key)) {
          fieldSchema = fieldSchema.optional();
        }
        shape[key] = fieldSchema;
      }

      // Allow additional properties by default (passthrough)
      return z.object(shape).passthrough();
    }

    if (type === 'string') {
      let s = z.string();
      if (typeof schema['minLength'] === 'number') s = s.min(schema['minLength'] as number);
      if (typeof schema['maxLength'] === 'number') s = s.max(schema['maxLength'] as number);
      if (typeof schema['pattern'] === 'string') s = s.regex(new RegExp(schema['pattern'] as string));
      if (schema['enum']) return z.enum(schema['enum'] as [string, ...string[]]);
      return s;
    }

    if (type === 'number' || type === 'integer') {
      let n = z.number();
      if (type === 'integer') n = n.int();
      if (typeof schema['minimum'] === 'number') n = n.min(schema['minimum'] as number);
      if (typeof schema['maximum'] === 'number') n = n.max(schema['maximum'] as number);
      return n;
    }

    if (type === 'boolean') return z.boolean();

    if (type === 'array') {
      const items = schema['items'] as Record<string, unknown> | undefined;
      return z.array(items ? this.jsonSchemaToZod(items) : z.unknown());
    }

    if (type === 'null') return z.null();

    // Fallback: accept anything
    return z.unknown();
  }

  /** Get or create a Zod validator for a tool */
  private getToolValidator(tool: MCPToolInfo): z.ZodType {
    let validator = this.toolValidators.get(tool.name);
    if (!validator) {
      try {
        validator = this.jsonSchemaToZod(tool.inputSchema);
      } catch {
        validator = z.unknown(); // Fallback if schema is weird
      }
      this.toolValidators.set(tool.name, validator);
    }
    return validator;
  }

  /** Validate tool arguments, returns error string or null */
  private validateToolArgs(tool: MCPToolInfo, args: unknown): string | null {
    const validator = this.getToolValidator(tool);
    const result = validator.safeParse(args ?? {});
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return `Invalid arguments: ${issues}`;
    }
    return null;
  }

  // ============================================================================
  // Internal
  // ============================================================================

  private setState(state: BridgeState): void {
    this.state = state;
  }

  private log(level: string, message: string): void {
    const configLevel = this.config.bridge?.logLevel ?? DEFAULTS.logLevel;
    const levels = ['debug', 'info', 'warn', 'error', 'silent'];
    if (levels.indexOf(level) < levels.indexOf(configLevel)) return;

    const prefix = `[@agenium/mcp-server:${this.config.name}]`;
    switch (level) {
      case 'debug': console.debug(prefix, message); break;
      case 'info':  console.log(prefix, message); break;
      case 'warn':  console.warn(prefix, message); break;
      case 'error': console.error(prefix, message); break;
    }
  }
}

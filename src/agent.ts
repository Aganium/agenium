/**
 * AGENIUM Agent
 * Integrated agent with transport, handshake, session management, messaging,
 * persistent sessions, and reliable delivery
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  AgentID,
  Session,
  SessionState,
  SessionEvent,
  AgeniumConfig,
  DEFAULT_CONFIG,
  generateId,
  now,
} from './core/types.js';

import { SessionManager, createSessionManager } from './state/session-manager.js';
import { BugReporter, getBugReporter } from './bug-report/reporter.js';
import { DNSResolver, ResolvedAgent, DNSErrorCode } from './dns/index.js';
import {
  ToolRegistry,
  ToolHandler,
  ToolDefinition,
  ToolContext,
  ToolErrorCode,
} from './tools/index.js';
import type { RemoteToolListResult, RemoteToolInvokeResult } from './tools/types.js';
import type { AgentTool } from './dns/types.js';

import { TransportServer, createServer, IncomingRequest } from './transport/server.js';
import { TransportClient, createClient } from './transport/client.js';
import {
  HandshakeInitiator,
  HandshakeResponder,
  createHandshakeHandlers,
  HandshakeInit,
  HandshakeResponse,
  HandshakeComplete,
  HandshakeError,
  HandshakeResult,
  Capability,
  DEFAULT_CAPABILITIES,
} from './transport/handshake.js';

import { initializeKeys, KeyStore } from './crypto/keys.js';
import { initializeCA, createAgentCert, CAInfo, CertificateInfo } from './crypto/certs.js';

import {
  MessageDispatcher,
  createDispatcher,
  RequestHandler,
  EventHandler,
} from './protocol/dispatcher.js';
import {
  AnyFrame,
  MessageType,
  validateFrame,
  createEventFrame,
} from './protocol/types.js';

import {
  DatabaseManager,
  createDatabase,
  PersistedSession,
} from './persistence/database.js';
import { ResumeManager, createResumeManager } from './persistence/resume.js';
import { OutboxManager, createOutboxManager } from './persistence/outbox.js';

// ============================================================================
// Types
// ============================================================================

export interface AgentConfig extends Partial<AgeniumConfig> {
  capabilities?: Capability[];
  /** Enable persistence (default: true) */
  persistence?: boolean;
  /** Pre-register tools at construction time */
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    handler: ToolHandler;
  }>;
}

/**
 * Result of register() / unregister() DNS operations.
 */
export interface DNSRegistrationResult {
  success: boolean;
  domain?: string;
  tools?: number;
  error?: string;
}

export interface ConnectResult {
  success: boolean;
  session?: Session;
  error?: string;
}

/** Session connection info for messaging */
interface SessionConnection {
  host: string;
  port: number;
  endpoint: string;
  remotePublicKey: string;
}

// ============================================================================
// Agent Class
// ============================================================================

export class Agent extends EventEmitter {
  private config: AgeniumConfig & { persistence: boolean };
  private identity: AgentID;
  private keys: KeyStore;
  private ca: CAInfo;
  private cert: CertificateInfo;
  
  private sessions: SessionManager;
  private bugReporter: BugReporter;
  private resolver: DNSResolver;
  
  private server: TransportServer | null = null;
  private client: TransportClient;
  
  private handshakeInitiator: HandshakeInitiator;
  private handshakeResponder: HandshakeResponder;
  
  private dispatcher: MessageDispatcher;
  private sessionConnections: Map<string, SessionConnection> = new Map();
  
  // Persistence
  private db: DatabaseManager | null = null;
  private resumeManager: ResumeManager | null = null;
  private outboxManager: OutboxManager | null = null;
  
  // Deduplication cache (in-memory for fast lookup)
  private dedupeCache: Map<string, number> = new Map();
  
  // Tool registry
  private toolRegistry: ToolRegistry;
  
  // DNS API key (set via register())
  private dnsApiKey: string | null = null;
  
  private isRunning: boolean = false;

  constructor(name: string, config: AgentConfig = {}) {
    super();
    
    // Merge config
    this.config = { 
      ...DEFAULT_CONFIG, 
      ...config, 
      agentName: name,
      persistence: config.persistence ?? true,
    };
    
    // Expand data dir
    this.config.dataDir = this.config.dataDir.replace('~', os.homedir());
    const agentDataDir = path.join(this.config.dataDir, name);
    fs.mkdirSync(agentDataDir, { recursive: true });
    
    // Initialize keys and certificates
    this.keys = initializeKeys(agentDataDir);
    this.ca = initializeCA(name, agentDataDir);
    this.cert = createAgentCert(name, this.keys.tlsKeys.publicKey, this.ca);
    
    // Create identity
    this.identity = {
      name,
      publicKey: this.keys.agentKeys.publicKey,
      description: `AGENIUM Agent: ${name}`,
    };
    
    // Initialize components
    this.sessions = createSessionManager(this.identity);
    this.bugReporter = getBugReporter({
      agentId: name,
      agentVersion: '0.1.0',
    });
    this.resolver = new DNSResolver({ server: this.config.dnsServer });
    
    // Initialize transport client
    this.client = createClient({
      cert: this.cert,
      ca: this.ca,
      maxConnectionsPerHost: 5,
      connectionTimeout: this.config.connectionTimeoutMs,
      requestTimeout: this.config.requestTimeoutMs,
      idleTimeout: 60000,
    });
    
    // Initialize handshake handlers
    const handlers = createHandshakeHandlers({
      localAgent: this.identity,
      privateKey: this.keys.agentKeys.privateKey,
      capabilities: config.capabilities,
    });
    this.handshakeInitiator = handlers.initiator;
    this.handshakeResponder = handlers.responder;
    
    // Initialize message dispatcher
    this.dispatcher = createDispatcher({
      maxPendingPerSession: 10,
      maxPendingTotal: 100,
      maxQueuePerSession: 50,
      defaultTimeoutMs: this.config.requestTimeoutMs,
    });
    
    // Wire up dispatcher send function (with persistence if enabled)
    this.dispatcher.setSendFunction((sessionId, frame) => this.sendFrame(sessionId, frame));
    
    // Initialize persistence if enabled
    if (this.config.persistence) {
      this.db = createDatabase(name, this.config.dataDir);
      this.db.open();
      
      this.resumeManager = createResumeManager(this.db);
      this.resumeManager.setResumeFunction((session) => this.resumeSession(session));
      
      this.outboxManager = createOutboxManager(this.db);
      this.outboxManager.setSendFunction((sessionId, frame) => this.sendFrameDirect(sessionId, frame));
      
      // Forward outbox events
      this.outboxManager.on('sent', (info) => this.emit('message_sent', info));
      this.outboxManager.on('failed', (info) => this.emit('message_failed', info));
      this.outboxManager.on('acked', (info) => this.emit('message_acked', info));
      
      // Forward resume events
      this.resumeManager.on('resumed', (info) => this.emit('session_resumed', info));
      this.resumeManager.on('resume_failed', (info) => this.emit('session_resume_failed', info));
    }
    
    // Wire up bug reporter state provider
    this.bugReporter.setStateProvider(() => ({
      sessionCount: this.sessions.getStats().total,
      queueDepth: this.outboxManager?.getStats().pending ?? 0,
      memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      activeConnections: this.sessions.getActiveCount(),
    }));
    
    // Register built-in ACK handler
    this.dispatcher.onEvent('ACK', (event, data, sessionId) => {
      const msgId = (data as any)?.msgId;
      if (msgId && this.outboxManager) {
        this.outboxManager.ack(msgId);
      }
    });
    
    // ---- Tool Registry ----
    this.toolRegistry = new ToolRegistry();
    
    // Pre-register tools from config
    if (config.tools) {
      for (const t of config.tools) {
        this.toolRegistry.register(t.name, {
          description: t.description,
          inputSchema: t.inputSchema,
          outputSchema: t.outputSchema,
        }, t.handler);
      }
    }
    
    // Built-in request handler: tool.list
    this.dispatcher.onRequest('tool.list', async () => {
      return { tools: this.toolRegistry.definitions() };
    });
    
    // Built-in request handler: tool.invoke
    this.dispatcher.onRequest('tool.invoke', async (_method, params, sessionId) => {
      const p = params as Record<string, unknown> | undefined;
      const toolName = p?.tool as string | undefined;
      if (!toolName) {
        throw new Error('Missing required parameter: tool');
      }
      const input = (p?.input as Record<string, unknown>) ?? {};
      
      const session = this.sessions.get(sessionId);
      const ctx: ToolContext = {
        sessionId,
        caller: session?.remoteAgent
          ? { name: session.remoteAgent.name, publicKey: session.remoteAgent.publicKey }
          : undefined,
        meta: p?.meta as Record<string, unknown> | undefined,
      };
      
      return this.toolRegistry.invoke(toolName, input, ctx);
    });
  }

  // ============================================================================
  // Identity
  // ============================================================================

  getIdentity(): AgentID {
    return this.identity;
  }

  getURI(): string {
    return `agent://${this.identity.name}`;
  }

  getEndpoint(host: string = 'localhost'): string {
    return `https://${host}:${this.config.listenPort}`;
  }

  getDNSRegistration(host: string = 'localhost') {
    return {
      name: this.identity.name,
      publicKey: this.identity.publicKey,
      endpoint: this.getEndpoint(host),
      description: this.identity.description,
      capabilities: ['messaging'],
      protocolVersions: ['1.0'],
    };
  }

  setDNSServer(server: string, port: number = 443, useHttps: boolean = true): void {
    this.resolver = new DNSResolver({ server, port, useHttps });
  }

  // ============================================================================
  // Tool Management
  // ============================================================================

  /**
   * Register a tool with definition + handler in one call.
   *
   * @example
   * agent.tool('greet', {
   *   description: 'Say hello',
   *   inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
   * }, async (input) => {
   *   return { message: `Hello, ${input.name}!` };
   * });
   */
  tool(name: string, opts: ToolDefinition, handler: ToolHandler): this {
    this.toolRegistry.register(name, opts, handler);
    this.emit('tool_registered', { name });
    return this; // chainable
  }

  /**
   * Remove a registered tool. Returns true if it existed.
   */
  removeTool(name: string): boolean {
    const removed = this.toolRegistry.remove(name);
    if (removed) this.emit('tool_removed', { name });
    return removed;
  }

  /**
   * Get wire-format definitions of all registered tools.
   */
  getTools(): AgentTool[] {
    return this.toolRegistry.definitions();
  }

  /**
   * Check if a tool is registered.
   */
  hasTool(name: string): boolean {
    return this.toolRegistry.has(name);
  }

  // ============================================================================
  // Remote Tool Invocation
  // ============================================================================

  /**
   * List tools exposed by a remote agent over an active session.
   *
   * Sends a `tool.list` request and returns typed results.
   *
   * @param sessionId  Active session to the remote agent
   * @param timeoutMs  Optional timeout (default: config.requestTimeoutMs)
   */
  async listRemoteTools(
    sessionId: string,
    timeoutMs?: number,
  ): Promise<RemoteToolListResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw Object.assign(
        new Error(`${ToolErrorCode.SESSION_NOT_ACTIVE}: Session not found: ${sessionId}`),
        { code: ToolErrorCode.SESSION_NOT_ACTIVE },
      );
    }
    if (session.state !== SessionState.ACTIVE) {
      throw Object.assign(
        new Error(`${ToolErrorCode.SESSION_NOT_ACTIVE}: Session not active: ${session.state}`),
        { code: ToolErrorCode.SESSION_NOT_ACTIVE },
      );
    }

    const result = await this.dispatcher.request(sessionId, 'tool.list', undefined, timeoutMs) as {
      tools?: AgentTool[];
    };

    return {
      tools: result?.tools ?? [],
      sessionId,
    };
  }

  /**
   * Invoke a tool on a remote agent over an active session.
   *
   * @param sessionId  Active session to the remote agent
   * @param toolName   Name of the tool to invoke
   * @param input      Input parameters for the tool
   * @param meta       Optional metadata forwarded to the remote handler
   * @param timeoutMs  Optional timeout (default: config.requestTimeoutMs)
   */
  async callTool(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown> = {},
    meta?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<RemoteToolInvokeResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw Object.assign(
        new Error(`${ToolErrorCode.SESSION_NOT_ACTIVE}: Session not found: ${sessionId}`),
        { code: ToolErrorCode.SESSION_NOT_ACTIVE },
      );
    }
    if (session.state !== SessionState.ACTIVE) {
      throw Object.assign(
        new Error(`${ToolErrorCode.SESSION_NOT_ACTIVE}: Session not active: ${session.state}`),
        { code: ToolErrorCode.SESSION_NOT_ACTIVE },
      );
    }

    this.bugReporter.recordAction('remote_tool_invoke', {
      sessionId,
      tool: toolName,
      inputKeys: Object.keys(input),
    });

    try {
      const result = await this.dispatcher.request(
        sessionId,
        'tool.invoke',
        { tool: toolName, input, ...(meta ? { meta } : {}) },
        timeoutMs,
      ) as { tool: string; output: unknown } | undefined;

      return {
        tool: result?.tool ?? toolName,
        output: result?.output ?? null,
        sessionId,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as any)?.code;

      // Timeouts / connection issues
      if (msg.includes('timed out') || msg.includes('TIMEOUT') || msg.includes('ECONNREFUSED')) {
        throw Object.assign(
          new Error(`${ToolErrorCode.REMOTE_UNREACHABLE}: ${msg}`),
          { code: ToolErrorCode.REMOTE_UNREACHABLE, cause: err },
        );
      }

      // Any error from remote tool invocation (HANDLER_ERROR, TOOL_NOT_FOUND, etc.)
      throw Object.assign(
        new Error(`${ToolErrorCode.REMOTE_ERROR}: Remote tool error: ${msg}`),
        { code: ToolErrorCode.REMOTE_ERROR, cause: err },
      );
    }
  }

  /**
   * One-shot convenience: resolve an agent, connect, invoke a tool.
   *
   * If a session to the target already exists and is active, it is reused.
   *
   * @param target    agent:// URI or {host, port}
   * @param toolName  Tool name to invoke
   * @param input     Input parameters
   * @param meta      Optional metadata
   * @param timeoutMs Timeout per network call
   */
  async callToolOnAgent(
    target: string | { host: string; port: number },
    toolName: string,
    input: Record<string, unknown> = {},
    meta?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<RemoteToolInvokeResult> {
    this.bugReporter.recordAction('call_tool_on_agent', { target, tool: toolName });

    // Connect (or reuse existing session)
    const connectResult = await this.connect(target);
    if (!connectResult.success || !connectResult.session) {
      throw Object.assign(
        new Error(
          `${ToolErrorCode.REMOTE_UNREACHABLE}: Cannot reach agent: ${connectResult.error ?? 'unknown'}`,
        ),
        { code: ToolErrorCode.REMOTE_UNREACHABLE },
      );
    }

    return this.callTool(connectResult.session.id, toolName, input, meta, timeoutMs);
  }

  // ============================================================================
  // DNS Registration
  // ============================================================================

  /**
   * Register this agent (endpoint + tools + capabilities) with the DNS bridge.
   *
   * @param apiKey  Marketplace API key (dom_xxx)
   * @param host    Public hostname/IP where this agent is reachable
   */
  async register(apiKey: string, host?: string): Promise<DNSRegistrationResult> {
    this.dnsApiKey = apiKey;
    const endpoint = this.getEndpoint(host);
    const tools = this.toolRegistry.definitions();

    this.bugReporter.recordAction('dns_register', {
      endpoint,
      toolCount: tools.length,
    });

    try {
      // DNS bridge is on the marketplace server
      const bridgeUrl = this.config.dnsServer.replace(/:\d+$/, '') + ':3004';
      const protocol = 'http';
      const url = `${protocol}://${bridgeUrl}/agent/endpoint`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
          'User-Agent': `AGENIUM/${this.identity.name}`,
        },
        body: JSON.stringify({
          endpoint,
          capabilities: ['messaging', 'tools'],
          tools,
          metadata: {
            version: '0.1.0',
            registeredAt: new Date().toISOString(),
            toolCount: tools.length,
          },
        }),
        signal: AbortSignal.timeout(15000),
      });

      const data = await response.json() as {
        success: boolean;
        data?: { domain: string; tools: AgentTool[] };
        error?: { code: string; message: string };
      };

      if (!data.success) {
        const errMsg = data.error?.message ?? `HTTP ${response.status}`;
        this.bugReporter.report('connection', 'DNS_REGISTER_FAILED', errMsg);
        return { success: false, error: errMsg };
      }

      this.emit('registered', {
        domain: data.data?.domain,
        tools: tools.length,
      });

      return {
        success: true,
        domain: data.data?.domain,
        tools: tools.length,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.bugReporter.report('connection', 'DNS_REGISTER_ERROR', msg);
      return { success: false, error: msg };
    }
  }

  /**
   * Remove this agent's endpoint from DNS.
   */
  async unregister(): Promise<DNSRegistrationResult> {
    if (!this.dnsApiKey) {
      return { success: false, error: 'No API key set — call register() first' };
    }

    try {
      const bridgeUrl = this.config.dnsServer.replace(/:\d+$/, '') + ':3004';
      const url = `http://${bridgeUrl}/agent/endpoint`;

      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'X-API-Key': this.dnsApiKey,
          'User-Agent': `AGENIUM/${this.identity.name}`,
        },
        signal: AbortSignal.timeout(10000),
      });

      const data = await response.json() as { success: boolean; error?: { message: string } };

      if (!data.success) {
        return { success: false, error: data.error?.message ?? `HTTP ${response.status}` };
      }

      this.dnsApiKey = null;
      this.emit('unregistered');
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  /**
   * Push updated tools to DNS without changing endpoint.
   * Requires a prior register() call.
   */
  async syncTools(): Promise<DNSRegistrationResult> {
    if (!this.dnsApiKey) {
      return { success: false, error: 'No API key set — call register() first' };
    }
    // Re-register with current tools (POST is idempotent)
    return this.register(this.dnsApiKey);
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async start(): Promise<void> {
    if (this.isRunning) return;
    
    this.bugReporter.start();
    this.client.start();
    
    // Start persistence managers
    if (this.resumeManager) {
      this.resumeManager.start();
    }
    if (this.outboxManager) {
      this.outboxManager.start();
    }
    
    // Create and start server
    this.server = createServer({
      port: this.config.listenPort,
      host: '0.0.0.0',
      cert: this.cert,
      ca: this.ca,
      requestTimeout: this.config.requestTimeoutMs,
    });
    
    this.server.onRequest(req => this.handleRequest(req));
    
    this.server.on('listening', (addr) => {
      this.emit('listening', addr);
    });
    
    this.server.on('error', (err) => {
      this.bugReporter.reportError(err, 'connection');
      this.emit('error', err);
    });
    
    await this.server.start();
    this.isRunning = true;
    
    this.emit('started', {
      name: this.identity.name,
      port: this.config.listenPort,
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    
    // Stop persistence managers
    if (this.resumeManager) {
      this.resumeManager.stop();
    }
    if (this.outboxManager) {
      this.outboxManager.stop();
    }
    
    this.dispatcher.shutdown();
    
    if (this.server) {
      await this.server.stop();
      this.server = null;
    }
    
    this.client.stop();
    this.bugReporter.stop();
    
    // Close database
    if (this.db) {
      this.db.close();
    }
    
    this.emit('stopped');
  }

  // ============================================================================
  // Connection
  // ============================================================================

  async connect(target: string | { host: string; port: number }): Promise<ConnectResult> {
    this.bugReporter.recordAction('connect', { target });
    
    let host: string;
    let port: number;
    let remoteAgentName: string;
    let resolvedAgent: ResolvedAgent | null = null;
    let endpoint: string;
    
    if (typeof target === 'string') {
      const result = await this.resolver.resolve(target);
      if (!result.ok) {
        this.bugReporter.report('connection', `DNS_${result.error.code}`, result.error.message);
        return { success: false, error: `DNS resolution failed: ${result.error.message}` };
      }
      
      resolvedAgent = result.agent;
      host = resolvedAgent.host;
      port = resolvedAgent.port;
      remoteAgentName = resolvedAgent.name;
      endpoint = resolvedAgent.endpoint;
    } else {
      host = target.host;
      port = target.port;
      remoteAgentName = `${host}:${port}`;
      endpoint = `https://${host}:${port}`;
    }
    
    // Check for existing active session by agent name OR by connection endpoint
    let session = this.sessions.findByRemote(remoteAgentName);
    if (!session) {
      // Also search by endpoint in case remoteAgent.name was updated after handshake
      for (const [sid, conn] of this.sessionConnections) {
        if (conn.host === host && conn.port === port) {
          const s = this.sessions.get(sid);
          if (s && s.state === SessionState.ACTIVE) {
            session = s;
            break;
          }
        }
      }
    }
    if (session && session.state === SessionState.ACTIVE) {
      return { success: true, session };
    }
    
    // Create new session
    if (!session) {
      session = this.sessions.create({
        name: remoteAgentName,
        publicKey: '',
      });
    }
    
    this.sessions.transition(session.id, SessionEvent.CONNECT);
    
    try {
      const init = this.handshakeInitiator.createInit();
      
      const response = await this.client.request(host, port, {
        method: 'POST',
        path: '/handshake/init',
        body: JSON.stringify(init),
      });
      
      if (response.status !== 200) {
        throw new Error(`Handshake failed with status ${response.status}`);
      }
      
      const responseData = JSON.parse(response.body.toString()) as HandshakeResponse | HandshakeError;
      
      if (responseData.type === 'handshake_error') {
        throw new Error(`Handshake error: ${responseData.message}`);
      }
      
      this.sessions.transition(session.id, SessionEvent.CONNECTED);
      
      const result = this.handshakeInitiator.processResponse(responseData);
      
      if (!this.handshakeInitiator.isComplete(result)) {
        throw new Error(`Handshake failed: ${(result as HandshakeResult).error?.message}`);
      }
      
      const completeResponse = await this.client.request(host, port, {
        method: 'POST',
        path: '/handshake/complete',
        body: JSON.stringify(result),
      });
      
      if (completeResponse.status !== 200) {
        throw new Error(`Handshake complete failed with status ${completeResponse.status}`);
      }
      
      const updatedSession = this.sessions.get(session.id)!;
      updatedSession.remoteAgent = responseData.agentId;
      
      // Verify public key if DNS resolved AND provides a key (pinning)
      // Skip check if DNS doesn't provide a key (no pinning)
      if (resolvedAgent && resolvedAgent.publicKey && responseData.agentId.publicKey !== resolvedAgent.publicKey) {
        this.bugReporter.report('protocol', 'KEY_MISMATCH', 
          `Public key mismatch for ${remoteAgentName}`);
        throw new Error(`Security error: Public key mismatch for ${remoteAgentName}`);
      }
      
      // Store connection info
      this.sessionConnections.set(session.id, { 
        host, 
        port, 
        endpoint,
        remotePublicKey: responseData.agentId.publicKey,
      });
      
      this.sessions.transition(session.id, SessionEvent.HANDSHAKE_OK);
      this.sessions.setCapabilities(session.id, result.negotiatedCapabilities);
      
      // Persist session
      if (this.db) {
        this.db.saveSession({
          sessionId: session.id,
          remoteAgentName,
          remotePublicKey: responseData.agentId.publicKey,
          endpoint,
          host,
          port,
          state: 'ACTIVE',
          capabilities: JSON.stringify(result.negotiatedCapabilities),
          createdAt: session.createdAt,
          lastSeenAt: now(),
          lastErrorCode: null,
          protocolVersion: '1.0',
        });
      }
      
      this.emit('connected', {
        sessionId: session.id,
        remoteAgent: responseData.agentId,
        capabilities: result.negotiatedCapabilities,
      });
      
      return { success: true, session: this.sessions.get(session.id)! };
      
    } catch (err) {
      this.sessions.transition(session.id, SessionEvent.ERROR);
      const errorMsg = (err as Error).message;
      
      this.bugReporter.report('connection', 'CONNECT_FAILED', errorMsg, {
        sessionId: session.id,
      });
      
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Resume a persisted session
   */
  private async resumeSession(persisted: PersistedSession): Promise<boolean> {
    this.bugReporter.recordAction('resume_session', {
      sessionId: persisted.sessionId,
      remoteAgent: persisted.remoteAgentName,
    });
    
    try {
      // DNS resolve to get current endpoint
      const dnsResult = await this.resolver.resolve(`agent://${persisted.remoteAgentName}`);
      
      if (dnsResult.ok) {
        // Verify key hasn't changed
        if (dnsResult.agent.publicKey !== persisted.remotePublicKey) {
          this.bugReporter.report('protocol', 'KEY_MISMATCH', 
            `Resumed session key mismatch for ${persisted.remoteAgentName}`);
          throw new Error('Public key mismatch during resume');
        }
      }
      
      // Use persisted endpoint if DNS fails
      const host = dnsResult.ok ? dnsResult.agent.host : persisted.host;
      const port = dnsResult.ok ? dnsResult.agent.port : persisted.port;
      
      // Attempt handshake
      const init = this.handshakeInitiator.createInit();
      
      const response = await this.client.request(host, port, {
        method: 'POST',
        path: '/handshake/init',
        body: JSON.stringify(init),
      });
      
      if (response.status !== 200) {
        throw new Error(`Resume handshake failed: ${response.status}`);
      }
      
      const responseData = JSON.parse(response.body.toString()) as HandshakeResponse | HandshakeError;
      
      if (responseData.type === 'handshake_error') {
        throw new Error(`Resume error: ${responseData.message}`);
      }
      
      // Verify key matches persisted
      if (responseData.agentId.publicKey !== persisted.remotePublicKey) {
        this.bugReporter.report('protocol', 'KEY_MISMATCH', 
          `Handshake key mismatch during resume for ${persisted.remoteAgentName}`);
        throw new Error('Key mismatch during resume handshake');
      }
      
      const result = this.handshakeInitiator.processResponse(responseData);
      
      if (!this.handshakeInitiator.isComplete(result)) {
        throw new Error(`Resume handshake failed: ${(result as HandshakeResult).error?.message}`);
      }
      
      await this.client.request(host, port, {
        method: 'POST',
        path: '/handshake/complete',
        body: JSON.stringify(result),
      });
      
      // Recreate in-memory session
      const session = this.sessions.create({
        name: persisted.remoteAgentName,
        publicKey: persisted.remotePublicKey,
      });
      
      // Override with persisted ID
      (session as any).id = persisted.sessionId;
      
      this.sessions.transition(session.id, SessionEvent.CONNECT);
      this.sessions.transition(session.id, SessionEvent.CONNECTED);
      this.sessions.transition(session.id, SessionEvent.HANDSHAKE_OK);
      this.sessions.setCapabilities(session.id, JSON.parse(persisted.capabilities));
      
      this.sessionConnections.set(session.id, {
        host,
        port,
        endpoint: persisted.endpoint,
        remotePublicKey: persisted.remotePublicKey,
      });
      
      return true;
      
    } catch (err) {
      this.bugReporter.report('connection', 'RESUME_FAILED', (err as Error).message, {
        sessionId: persisted.sessionId,
      });
      return false;
    }
  }

  // ============================================================================
  // Messaging
  // ============================================================================

  onRequest(method: string, handler: RequestHandler): void {
    this.dispatcher.onRequest(method, handler);
  }

  onEvent(event: string, handler: EventHandler): void {
    this.dispatcher.onEvent(event, handler);
  }

  async request(
    sessionId: string,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<unknown> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.state !== SessionState.ACTIVE) {
      throw new Error(`Session not active: ${session.state}`);
    }

    return this.dispatcher.request(sessionId, method, params, timeoutMs);
  }

  async event(sessionId: string, event: string, data?: unknown): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.state !== SessionState.ACTIVE) {
      throw new Error(`Session not active: ${session.state}`);
    }

    return this.dispatcher.event(sessionId, event, data);
  }

  /**
   * Send frame with persistence (reliable delivery)
   */
  private async sendFrame(sessionId: string, frame: AnyFrame): Promise<boolean> {
    // Use outbox for reliable delivery
    if (this.outboxManager && (frame.type === MessageType.REQUEST || frame.type === MessageType.EVENT)) {
      const result = this.outboxManager.enqueue(sessionId, frame);
      return result.success;
    }
    
    // Direct send for RESPONSE/ERROR
    const result = await this.sendFrameDirect(sessionId, frame);
    return result.success;
  }

  /**
   * Direct send without persistence
   */
  private async sendFrameDirect(sessionId: string, frame: AnyFrame): Promise<{
    success: boolean;
    error?: string;
    isRetryable?: boolean;
  }> {
    const conn = this.sessionConnections.get(sessionId);
    if (!conn) {
      return { success: false, error: 'No connection for session', isRetryable: false };
    }

    try {
      const response = await this.client.request(conn.host, conn.port, {
        method: 'POST',
        path: '/message',
        body: JSON.stringify(frame),
      });

      if (response.status === 200 && response.body.length > 0) {
        try {
          const responseFrame = JSON.parse(response.body.toString());
          if (responseFrame && responseFrame.type) {
            await this.dispatcher.handleIncoming(responseFrame);
          }
        } catch {
          // Not a frame response
        }
      }

      if (response.status >= 500) {
        return { success: false, error: `Server error: ${response.status}`, isRetryable: true };
      }
      if (response.status >= 400) {
        return { success: false, error: `Client error: ${response.status}`, isRetryable: false };
      }

      return { success: true };
    } catch (err) {
      const error = (err as Error).message;
      const isRetryable = error.includes('TIMEOUT') || 
                          error.includes('ECONNREFUSED') || 
                          error.includes('NETWORK');
      return { success: false, error, isRetryable };
    }
  }

  // ============================================================================
  // Session Management
  // ============================================================================

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  getAllSessions(): Session[] {
    return this.sessions.getAll();
  }

  getStats() {
    return {
      identity: this.identity,
      isRunning: this.isRunning,
      sessions: this.sessions.getStats(),
      connections: this.client.getStats(),
      dispatcher: this.dispatcher.getStats(),
      bugReporter: this.bugReporter.getStats(),
      persistence: this.db ? this.db.getStats() : null,
      outbox: this.outboxManager?.getStats() ?? null,
      resume: this.resumeManager?.getStats() ?? null,
      tools: {
        count: this.toolRegistry.size,
        names: this.toolRegistry.definitions().map((t) => t.name),
      },
    };
  }

  // ============================================================================
  // Request Handler
  // ============================================================================

  private async handleRequest(req: IncomingRequest): Promise<{
    status: number;
    headers?: Record<string, string>;
    body?: string | Buffer;
  }> {
    this.bugReporter.recordAction('handle_request', {
      method: req.method,
      path: req.path,
    });
    
    try {
      if (req.path === '/handshake/init' && req.method === 'POST') {
        const init = JSON.parse(req.body.toString()) as HandshakeInit;
        const response = this.handshakeResponder.processInit(init);
        
        if (this.handshakeResponder.isError(response)) {
          return { status: 400, body: JSON.stringify(response) };
        }
        
        return { status: 200, body: JSON.stringify(response) };
      }
      
      if (req.path === '/handshake/complete' && req.method === 'POST') {
        const complete = JSON.parse(req.body.toString()) as HandshakeComplete;
        const result = this.handshakeResponder.processComplete(complete, complete.peerNonce);
        
        if (!result.success) {
          return { status: 400, body: JSON.stringify({ error: result.error }) };
        }
        
        const session = this.sessions.create(result.remoteAgent!);
        this.sessions.transition(session.id, SessionEvent.CONNECT);
        this.sessions.transition(session.id, SessionEvent.CONNECTED);
        this.sessions.transition(session.id, SessionEvent.HANDSHAKE_OK);
        this.sessions.setCapabilities(session.id, result.negotiatedCapabilities!);
        
        this.emit('connection', {
          sessionId: session.id,
          remoteAgent: result.remoteAgent,
          capabilities: result.negotiatedCapabilities,
        });
        
        return { status: 200, body: JSON.stringify({ sessionId: session.id }) };
      }
      
      if (req.path === '/message' && req.method === 'POST') {
        const frame = JSON.parse(req.body.toString()) as AnyFrame;
        const validation = validateFrame(frame);
        
        if (!validation.valid) {
          return { status: 400, body: JSON.stringify({ error: validation.error }) };
        }
        
        // Check for duplicate
        if (this.db && this.db.isDuplicate(frame.messageId, frame.sessionId)) {
          this.bugReporter.recordAction('dedupe_hit', { msgId: frame.messageId });
          // Return success but don't process
          return { status: 200, body: JSON.stringify({ ok: true, duplicate: true }) };
        }
        
        // Mark as processed
        if (this.db) {
          this.db.markProcessed(frame.messageId, frame.sessionId);
        }
        
        // Process the message
        const responseFrame = await this.dispatcher.handleIncoming(frame);
        
        // Send ACK for EVENTs
        if (frame.type === MessageType.EVENT) {
          const ackFrame = createEventFrame(frame.sessionId, 'ACK', { msgId: frame.messageId });
          // Send ACK async (don't wait)
          setImmediate(() => {
            this.sendFrameDirect(frame.sessionId, ackFrame).catch(() => {});
          });
        }
        
        if (responseFrame) {
          return { status: 200, body: JSON.stringify(responseFrame) };
        }
        
        return { status: 200, body: JSON.stringify({ ok: true }) };
      }
      
      if (req.path === '/health') {
        return {
          status: 200,
          body: JSON.stringify({
            agent: this.identity.name,
            status: 'ok',
            uptime: process.uptime(),
          }),
        };
      }
      
      return { status: 404, body: 'Not Found' };
      
    } catch (err) {
      this.bugReporter.reportError(err as Error, 'protocol');
      return { status: 500, body: 'Internal Server Error' };
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createAgent(name: string, config?: AgentConfig): Agent {
  return new Agent(name, config);
}

/**
 * AGENIUM Agent
 * Integrated agent with transport, handshake, session management, and messaging
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
} from './protocol/types.js';

// ============================================================================
// Types
// ============================================================================

export interface AgentConfig extends Partial<AgeniumConfig> {
  capabilities?: Capability[];
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
}

// ============================================================================
// Agent Class
// ============================================================================

export class Agent extends EventEmitter {
  private config: AgeniumConfig;
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
  
  private isRunning: boolean = false;

  constructor(name: string, config: AgentConfig = {}) {
    super();
    
    // Merge config
    this.config = { ...DEFAULT_CONFIG, ...config, agentName: name };
    
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
    
    // Wire up dispatcher send function
    this.dispatcher.setSendFunction((sessionId, frame) => this.sendFrame(sessionId, frame));
    
    // Wire up bug reporter state provider
    this.bugReporter.setStateProvider(() => ({
      sessionCount: this.sessions.getStats().total,
      queueDepth: this.dispatcher.getStats().queuedMessages,
      memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      activeConnections: this.sessions.getActiveCount(),
    }));
  }

  // ============================================================================
  // Identity
  // ============================================================================

  /**
   * Get agent identity
   */
  getIdentity(): AgentID {
    return this.identity;
  }

  /**
   * Get agent URI
   */
  getURI(): string {
    return `agent://${this.identity.name}`;
  }

  /**
   * Get endpoint URL for DNS registration
   */
  getEndpoint(host: string = 'localhost'): string {
    return `https://${host}:${this.config.listenPort}`;
  }

  /**
   * Get DNS registration info
   */
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

  /**
   * Configure DNS resolver
   */
  setDNSServer(server: string, port: number = 443, useHttps: boolean = true): void {
    this.resolver = new DNSResolver({
      server,
      port,
      useHttps,
    });
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Start the agent (server + background tasks)
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    
    this.bugReporter.start();
    this.client.start();
    
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

  /**
   * Stop the agent
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    this.dispatcher.shutdown();
    
    if (this.server) {
      await this.server.stop();
      this.server = null;
    }
    
    this.client.stop();
    this.bugReporter.stop();
    
    this.emit('stopped');
  }

  // ============================================================================
  // Connection
  // ============================================================================

  /**
   * Connect to a remote agent by URI or direct address
   */
  async connect(target: string | { host: string; port: number }): Promise<ConnectResult> {
    this.bugReporter.recordAction('connect', { target });
    
    let host: string;
    let port: number;
    let remoteAgentName: string;
    let resolvedAgent: ResolvedAgent | null = null;
    
    if (typeof target === 'string') {
      // agent:// URI - resolve via DNS
      const result = await this.resolver.resolve(target);
      if (!result.ok) {
        this.bugReporter.report('connection', `DNS_${result.error.code}`, result.error.message);
        return { success: false, error: `DNS resolution failed: ${result.error.message}` };
      }
      
      resolvedAgent = result.agent;
      host = resolvedAgent.host;
      port = resolvedAgent.port;
      remoteAgentName = resolvedAgent.name;
      
      this.bugReporter.recordAction('dns_resolved', {
        name: resolvedAgent.name,
        endpoint: resolvedAgent.endpoint,
      });
    } else {
      // Direct connection
      host = target.host;
      port = target.port;
      remoteAgentName = `${host}:${port}`;
    }
    
    // Check for existing session
    let session = this.sessions.findByRemote(remoteAgentName);
    if (session && session.state === SessionState.ACTIVE) {
      return { success: true, session };
    }
    
    // Create new session
    if (!session) {
      session = this.sessions.create({
        name: remoteAgentName,
        publicKey: '', // Will be filled during handshake
      });
    }
    
    // Transition to CONNECTING
    this.sessions.transition(session.id, SessionEvent.CONNECT);
    
    try {
      // Create handshake init
      const init = this.handshakeInitiator.createInit();
      
      // Send handshake init
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
      
      // Transition to HANDSHAKING
      this.sessions.transition(session.id, SessionEvent.CONNECTED);
      
      // Process response
      const result = this.handshakeInitiator.processResponse(responseData);
      
      if (!this.handshakeInitiator.isComplete(result)) {
        throw new Error(`Handshake failed: ${(result as HandshakeResult).error?.message}`);
      }
      
      // Send completion
      const completeResponse = await this.client.request(host, port, {
        method: 'POST',
        path: '/handshake/complete',
        body: JSON.stringify(result),
      });
      
      if (completeResponse.status !== 200) {
        throw new Error(`Handshake complete failed with status ${completeResponse.status}`);
      }
      
      // Update session with remote identity
      const updatedSession = this.sessions.get(session.id)!;
      updatedSession.remoteAgent = responseData.agentId;
      
      // Verify public key if we resolved via DNS
      if (resolvedAgent) {
        if (responseData.agentId.publicKey !== resolvedAgent.publicKey) {
          this.bugReporter.report('protocol', 'KEY_MISMATCH', 
            `Public key mismatch for ${remoteAgentName}. DNS: ${resolvedAgent.publicKey.slice(0, 20)}..., handshake: ${responseData.agentId.publicKey.slice(0, 20)}...`);
          throw new Error(`Security error: Public key mismatch for ${remoteAgentName}. Connection rejected.`);
        }
        this.bugReporter.recordAction('key_verified', { agent: remoteAgentName });
      }
      
      // Store connection info for messaging
      this.sessionConnections.set(session.id, { host, port });
      
      // Transition to ACTIVE
      this.sessions.transition(session.id, SessionEvent.HANDSHAKE_OK);
      this.sessions.setCapabilities(session.id, result.negotiatedCapabilities);
      
      this.emit('connected', {
        sessionId: session.id,
        remoteAgent: responseData.agentId,
        capabilities: result.negotiatedCapabilities,
      });
      
      return { success: true, session: this.sessions.get(session.id)! };
      
    } catch (err) {
      this.sessions.transition(session.id, SessionEvent.ERROR);
      const session_updated = this.sessions.get(session.id)!;
      session_updated.errorMessage = (err as Error).message;
      
      this.bugReporter.report('connection', 'CONNECT_FAILED', (err as Error).message, {
        sessionId: session.id,
      });
      
      return { success: false, error: (err as Error).message };
    }
  }

  // ============================================================================
  // Messaging
  // ============================================================================

  /**
   * Register a request handler
   */
  onRequest(method: string, handler: RequestHandler): void {
    this.dispatcher.onRequest(method, handler);
  }

  /**
   * Register an event handler
   */
  onEvent(event: string, handler: EventHandler): void {
    this.dispatcher.onEvent(event, handler);
  }

  /**
   * Send a request to a remote agent
   */
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

  /**
   * Send an event to a remote agent (fire-and-forget)
   */
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
   * Send a frame over the network
   */
  private async sendFrame(sessionId: string, frame: AnyFrame): Promise<boolean> {
    const conn = this.sessionConnections.get(sessionId);
    if (!conn) {
      // This might be an inbound session - we need to respond differently
      // For now, emit an event that the response handler will catch
      this.emit('outbound_frame', { sessionId, frame });
      return true;
    }

    try {
      const response = await this.client.request(conn.host, conn.port, {
        method: 'POST',
        path: '/message',
        body: JSON.stringify(frame),
      });

      if (response.status === 200 && response.body.length > 0) {
        // If we got a response body, it might be a RESPONSE frame
        try {
          const responseFrame = JSON.parse(response.body.toString());
          if (responseFrame && responseFrame.type) {
            // Process the response through the dispatcher
            await this.dispatcher.handleIncoming(responseFrame);
          }
        } catch {
          // Not JSON or not a frame - that's OK
        }
      }

      return response.status === 200;
    } catch (err) {
      this.bugReporter.reportError(err as Error, 'connection');
      return false;
    }
  }

  // ============================================================================
  // Session Management
  // ============================================================================

  /**
   * Get session by ID
   */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all sessions
   */
  getAllSessions(): Session[] {
    return this.sessions.getAll();
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      identity: this.identity,
      isRunning: this.isRunning,
      sessions: this.sessions.getStats(),
      connections: this.client.getStats(),
      dispatcher: this.dispatcher.getStats(),
      bugReporter: this.bugReporter.getStats(),
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
      peer: req.peerFingerprint.slice(0, 16),
    });
    
    try {
      // Handshake init
      if (req.path === '/handshake/init' && req.method === 'POST') {
        const init = JSON.parse(req.body.toString()) as HandshakeInit;
        const response = this.handshakeResponder.processInit(init);
        
        if (this.handshakeResponder.isError(response)) {
          return { status: 400, body: JSON.stringify(response) };
        }
        
        return { status: 200, body: JSON.stringify(response) };
      }
      
      // Handshake complete
      if (req.path === '/handshake/complete' && req.method === 'POST') {
        const complete = JSON.parse(req.body.toString()) as HandshakeComplete;
        
        // The peerNonce is now included in the complete message
        const result = this.handshakeResponder.processComplete(complete, complete.peerNonce);
        
        if (!result.success) {
          return { status: 400, body: JSON.stringify({ error: result.error }) };
        }
        
        // Create session on server side
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
      
      // Message endpoint
      if (req.path === '/message' && req.method === 'POST') {
        const frame = JSON.parse(req.body.toString());
        const validation = validateFrame(frame);
        
        if (!validation.valid) {
          return { status: 400, body: JSON.stringify({ error: validation.error }) };
        }
        
        // Process the message
        const responseFrame = await this.dispatcher.handleIncoming(frame);
        
        if (responseFrame) {
          // Send the response back directly
          return { status: 200, body: JSON.stringify(responseFrame) };
        }
        
        return { status: 200, body: JSON.stringify({ ok: true }) };
      }
      
      // Health check
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
      
      // Unknown endpoint
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

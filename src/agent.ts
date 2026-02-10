/**
 * AGENIUM Agent
 * Integrated agent with transport, handshake, and session management
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
import { DNSResolver } from './dns/resolver.js';

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
    
    // Wire up bug reporter state provider
    this.bugReporter.setStateProvider(() => ({
      sessionCount: this.sessions.getStats().total,
      queueDepth: 0,
      memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      activeConnections: this.sessions.getActiveCount(),
    }));
  }

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
    
    if (this.server) {
      await this.server.stop();
      this.server = null;
    }
    
    this.client.stop();
    this.bugReporter.stop();
    
    this.emit('stopped');
  }

  /**
   * Connect to a remote agent by URI or direct address
   */
  async connect(target: string | { host: string; port: number }): Promise<ConnectResult> {
    this.bugReporter.recordAction('connect', { target });
    
    let host: string;
    let port: number;
    let remoteAgentName: string;
    
    if (typeof target === 'string') {
      // agent:// URI - resolve via DNS
      const result = await this.resolver.resolve(target);
      if (!result.ok) {
        return { success: false, error: result.error.message };
      }
      
      const url = new URL(result.endpoint.url);
      host = url.hostname;
      port = parseInt(url.port) || 443;
      remoteAgentName = result.endpoint.agentId.name;
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

  /**
   * Send a message to a connected session
   */
  async send(sessionId: string, message: unknown): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.state !== SessionState.ACTIVE) {
      return false;
    }
    
    // TODO: Implement message sending
    this.bugReporter.recordAction('send_message', {
      sessionId,
      messageType: typeof message,
    });
    
    return true;
  }

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

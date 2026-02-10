/**
 * Mock DNS Server
 * For local testing and demo purposes
 * Simulates the DNS system at 185.204.169.26
 */

import * as http from 'node:http';
import { EventEmitter } from 'node:events';
import {
  DNSRegisterRequest,
  DNSRegisterResponse,
  DNSLookupResponse,
  DNSErrorCode,
  validateAgentName,
} from './types.js';
import { verifyAgentSignature } from '../crypto/keys.js';
import { now } from '../core/types.js';

// ============================================================================
// Types
// ============================================================================

export interface DNSServerConfig {
  port: number;
  host: string;
  defaultTtl: number;
}

interface RegisteredAgent {
  name: string;
  publicKey: string;
  endpoint: string;
  description?: string;
  capabilities: string[];
  protocolVersions: string[];
  registeredAt: number;
  updatedAt: number;
}

// ============================================================================
// DNS Server
// ============================================================================

export class DNSServer extends EventEmitter {
  private config: DNSServerConfig;
  private server: http.Server | null = null;
  private agents: Map<string, RegisteredAgent> = new Map();
  private isRunning: boolean = false;

  constructor(config: Partial<DNSServerConfig> = {}) {
    super();
    this.config = {
      port: config.port ?? 8053,
      host: config.host ?? '127.0.0.1',
      defaultTtl: config.defaultTtl ?? 300,
    };
  }

  /**
   * Start the DNS server
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch(err => {
          console.error('[DNSServer] Error:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: { code: 'SERVER_ERROR', message: 'Internal error' } }));
        });
      });

      this.server.on('error', reject);

      this.server.listen(this.config.port, this.config.host, () => {
        this.isRunning = true;
        this.emit('listening', { port: this.config.port, host: this.config.host });
        resolve();
      });
    });
  }

  /**
   * Stop the DNS server
   */
  async stop(): Promise<void> {
    if (!this.isRunning || !this.server) return;

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.isRunning = false;
        this.server = null;
        this.emit('stopped');
        resolve();
      });
    });
  }

  /**
   * Register an agent (programmatic, for testing)
   */
  registerAgent(agent: Omit<RegisteredAgent, 'registeredAt' | 'updatedAt'>): void {
    const currentTime = now();
    this.agents.set(agent.name.toLowerCase(), {
      ...agent,
      registeredAt: currentTime,
      updatedAt: currentTime,
    });
    this.emit('registered', agent.name);
  }

  /**
   * Unregister an agent
   */
  unregisterAgent(name: string): boolean {
    const deleted = this.agents.delete(name.toLowerCase());
    if (deleted) {
      this.emit('unregistered', name);
    }
    return deleted;
  }

  /**
   * Get registered agents
   */
  getAgents(): string[] {
    return Array.from(this.agents.keys());
  }

  /**
   * Get server address
   */
  getAddress(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }

  // ============================================================================
  // Request Handling
  // ============================================================================

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;

    // CORS headers for local testing
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Route: GET /api/agents/:name
    const lookupMatch = path.match(/^\/api\/agents\/([^/]+)$/);
    if (req.method === 'GET' && lookupMatch) {
      const name = decodeURIComponent(lookupMatch[1]);
      return this.handleLookup(name, res);
    }

    // Route: POST /api/agents/register
    if (req.method === 'POST' && path === '/api/agents/register') {
      return this.handleRegister(req, res);
    }

    // Route: GET /api/agents (list all)
    if (req.method === 'GET' && path === '/api/agents') {
      return this.handleList(res);
    }

    // Route: GET /health
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', agents: this.agents.size }));
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Endpoint not found' } }));
  }

  private async handleLookup(name: string, res: http.ServerResponse): Promise<void> {
    this.emit('lookup', name);

    // Validate name
    if (!validateAgentName(name)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      const response: DNSLookupResponse = {
        success: false,
        error: {
          code: DNSErrorCode.INVALID_NAME,
          message: `Invalid agent name: ${name}`,
        },
      };
      res.end(JSON.stringify(response));
      return;
    }

    // Look up agent
    const agent = this.agents.get(name.toLowerCase());
    if (!agent) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      const response: DNSLookupResponse = {
        success: false,
        error: {
          code: DNSErrorCode.NOT_FOUND,
          message: `Agent not found: ${name}`,
        },
      };
      res.end(JSON.stringify(response));
      return;
    }

    // Return agent info
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const response: DNSLookupResponse = {
      success: true,
      agent: {
        name: agent.name,
        publicKey: agent.publicKey,
        endpoint: agent.endpoint,
        description: agent.description,
        capabilities: agent.capabilities,
        protocolVersions: agent.protocolVersions,
        ttl: this.config.defaultTtl,
        updatedAt: agent.updatedAt,
      },
    };
    res.end(JSON.stringify(response));
  }

  private async handleRegister(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Read body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks).toString();

    let data: DNSRegisterRequest;
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      const response: DNSRegisterResponse = {
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'Invalid JSON' },
      };
      res.end(JSON.stringify(response));
      return;
    }

    // Validate name
    if (!validateAgentName(data.name)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      const response: DNSRegisterResponse = {
        success: false,
        error: { code: DNSErrorCode.INVALID_NAME, message: `Invalid agent name: ${data.name}` },
      };
      res.end(JSON.stringify(response));
      return;
    }

    // Register the agent
    this.registerAgent({
      name: data.name,
      publicKey: data.publicKey,
      endpoint: data.endpoint,
      description: data.description,
      capabilities: data.capabilities,
      protocolVersions: data.protocolVersions,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    const response: DNSRegisterResponse = {
      success: true,
      message: `Agent ${data.name} registered successfully`,
    };
    res.end(JSON.stringify(response));
  }

  private async handleList(res: http.ServerResponse): Promise<void> {
    const agents = Array.from(this.agents.values()).map(a => ({
      name: a.name,
      endpoint: a.endpoint,
      capabilities: a.capabilities,
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, agents }));
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createDNSServer(config?: Partial<DNSServerConfig>): DNSServer {
  return new DNSServer(config);
}

/**
 * Transport Client - HTTP/2 with mTLS
 * Connection pooling for outbound agent connections
 */

import * as http2 from 'node:http2';
import * as tls from 'node:tls';
import { EventEmitter } from 'node:events';
import type { CertificateInfo, CAInfo } from '../crypto/certs.js';
import { getBugReporter } from '../bug-report/reporter.js';

// ============================================================================
// Types
// ============================================================================

export interface ClientConfig {
  cert: CertificateInfo;
  ca: CAInfo;
  maxConnectionsPerHost: number;
  connectionTimeout: number;
  requestTimeout: number;
  idleTimeout: number;
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

export interface ResponseResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  peerFingerprint: string;
}

interface PooledConnection {
  session: http2.ClientHttp2Session;
  host: string;
  port: number;
  createdAt: number;
  lastUsed: number;
  activeStreams: number;
  peerFingerprint: string;
}

// ============================================================================
// Connection Pool
// ============================================================================

class ConnectionPool {
  private connections: Map<string, PooledConnection[]> = new Map();
  private config: ClientConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: ClientConfig) {
    this.config = config;
  }

  start(): void {
    // Periodic cleanup of idle connections
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, 30000);
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // Close all connections
    for (const conns of this.connections.values()) {
      for (const conn of conns) {
        conn.session.close();
      }
    }
    this.connections.clear();
  }

  /**
   * Get or create a connection to host:port
   */
  async getConnection(
    host: string,
    port: number,
    certInfo: CertificateInfo,
    caInfo: CAInfo
  ): Promise<PooledConnection> {
    const key = `${host}:${port}`;
    let conns = this.connections.get(key);
    
    if (!conns) {
      conns = [];
      this.connections.set(key, conns);
    }

    // Find available connection
    for (const conn of conns) {
      if (!conn.session.destroyed && !conn.session.closed) {
        conn.lastUsed = Date.now();
        return conn;
      }
    }

    // Remove dead connections
    this.connections.set(key, conns.filter(c => !c.session.destroyed && !c.session.closed));

    // Check pool limit
    if (conns.length >= this.config.maxConnectionsPerHost) {
      // Wait for one to become available or timeout
      throw new Error(`Connection pool exhausted for ${key}`);
    }

    // Create new connection
    const conn = await this.createConnection(host, port, certInfo, caInfo);
    conns.push(conn);
    return conn;
  }

  private async createConnection(
    host: string,
    port: number,
    certInfo: CertificateInfo,
    caInfo: CAInfo
  ): Promise<PooledConnection> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Connection timeout to ${host}:${port}`));
      }, this.config.connectionTimeout);

      const session = http2.connect(`https://${host}:${port}`, {
        key: certInfo.privateKey,
        cert: certInfo.cert,
        ca: caInfo.cert,
        rejectUnauthorized: false, // We verify manually
        minVersion: 'TLSv1.3',
      });

      session.on('connect', () => {
        clearTimeout(timeout);
        
        const socket = session.socket as tls.TLSSocket;
        const peerCert = socket.getPeerCertificate();
        const fingerprint = peerCert?.fingerprint256 || 'unknown';

        const conn: PooledConnection = {
          session,
          host,
          port,
          createdAt: Date.now(),
          lastUsed: Date.now(),
          activeStreams: 0,
          peerFingerprint: fingerprint,
        };

        resolve(conn);
      });

      session.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      session.on('close', () => {
        // Remove from pool
        const key = `${host}:${port}`;
        const conns = this.connections.get(key);
        if (conns) {
          this.connections.set(key, conns.filter(c => c.session !== session));
        }
      });
    });
  }

  private cleanup(): void {
    const now = Date.now();
    const idleThreshold = now - this.config.idleTimeout;

    for (const [key, conns] of this.connections) {
      const active = conns.filter(c => {
        if (c.session.destroyed || c.session.closed) return false;
        if (c.lastUsed < idleThreshold && c.activeStreams === 0) {
          c.session.close();
          return false;
        }
        return true;
      });
      
      if (active.length === 0) {
        this.connections.delete(key);
      } else {
        this.connections.set(key, active);
      }
    }
  }

  getStats(): { totalConnections: number; byHost: Record<string, number> } {
    const byHost: Record<string, number> = {};
    let total = 0;
    
    for (const [key, conns] of this.connections) {
      byHost[key] = conns.length;
      total += conns.length;
    }
    
    return { totalConnections: total, byHost };
  }
}

// ============================================================================
// Transport Client
// ============================================================================

export class TransportClient extends EventEmitter {
  private config: ClientConfig;
  private pool: ConnectionPool;

  constructor(config: ClientConfig) {
    super();
    this.config = config;
    this.pool = new ConnectionPool(config);
  }

  start(): void {
    this.pool.start();
  }

  stop(): void {
    this.pool.stop();
  }

  /**
   * Send a request to a remote agent
   */
  async request(
    host: string,
    port: number,
    options: RequestOptions
  ): Promise<ResponseResult> {
    const startTime = Date.now();
    
    getBugReporter().recordAction('http_request', {
      host,
      port,
      method: options.method,
      path: options.path,
    });

    let conn: PooledConnection;
    
    try {
      conn = await this.pool.getConnection(
        host,
        port,
        this.config.cert,
        this.config.ca
      );
    } catch (err) {
      getBugReporter().report('connection', 'CONNECT_FAILED', (err as Error).message);
      throw err;
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Request timeout to ${host}:${port}${options.path}`));
        getBugReporter().report('timeout', 'REQUEST_TIMEOUT', 'Client request timed out', {
          sessionId: `${host}:${port}`,
        });
      }, this.config.requestTimeout);

      conn.activeStreams++;

      const headers: http2.OutgoingHttpHeaders = {
        ':method': options.method,
        ':path': options.path,
        'content-type': 'application/json',
        ...options.headers,
      };

      const stream = conn.session.request(headers);

      stream.on('error', (err) => {
        clearTimeout(timeout);
        conn.activeStreams--;
        getBugReporter().reportError(err, 'connection');
        reject(err);
      });

      // Collect response
      const responseHeaders: Record<string, string> = {};
      let status = 0;

      stream.on('response', (headers) => {
        status = headers[':status'] as number || 500;
        for (const [key, value] of Object.entries(headers)) {
          if (!key.startsWith(':')) {
            responseHeaders[key] = String(value);
          }
        }
      });

      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => {
        chunks.push(chunk as Buffer);
      });

      stream.on('end', () => {
        clearTimeout(timeout);
        conn.activeStreams--;
        conn.lastUsed = Date.now();

        const duration = Date.now() - startTime;
        getBugReporter().recordAction('http_response', {
          host,
          port,
          status,
          durationMs: duration,
        });

        resolve({
          status,
          headers: responseHeaders,
          body: Buffer.concat(chunks),
          peerFingerprint: conn.peerFingerprint,
        });
      });

      // Send body if present
      if (options.body) {
        stream.end(options.body);
      } else {
        stream.end();
      }
    });
  }

  /**
   * Get connection pool stats
   */
  getStats(): ReturnType<ConnectionPool['getStats']> {
    return this.pool.getStats();
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createClient(config: ClientConfig): TransportClient {
  return new TransportClient(config);
}

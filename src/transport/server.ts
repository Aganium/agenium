/**
 * Transport Server - HTTP/2 with mTLS
 * Accepts incoming agent connections
 */

import * as http2 from 'node:http2';
import * as tls from 'node:tls';
import { EventEmitter } from 'node:events';
import type { CAInfo, CertificateInfo } from '../crypto/certs.js';
import { getBugReporter } from '../bug-report/reporter.js';

// ============================================================================
// Types
// ============================================================================

export interface ServerConfig {
  port: number;
  host: string;
  cert: CertificateInfo;
  ca: CAInfo;
  requestTimeout: number;
}

export interface IncomingRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
  peerFingerprint: string;
  stream: http2.ServerHttp2Stream;
}

export type RequestHandler = (req: IncomingRequest) => Promise<{
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}>;

// ============================================================================
// Transport Server
// ============================================================================

export class TransportServer extends EventEmitter {
  private config: ServerConfig;
  private server: http2.Http2SecureServer | null = null;
  private handler: RequestHandler | null = null;
  private activeStreams: Set<http2.ServerHttp2Stream> = new Set();

  constructor(config: ServerConfig) {
    super();
    this.config = config;
  }

  /**
   * Set the request handler
   */
  onRequest(handler: RequestHandler): void {
    this.handler = handler;
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = http2.createSecureServer({
          key: this.config.cert.privateKey,
          cert: this.config.cert.cert,
          ca: this.config.ca.cert,
          requestCert: true,           // Require client cert (mTLS)
          rejectUnauthorized: false,   // We verify manually
          minVersion: 'TLSv1.3',
        });

        this.server.on('stream', (stream, headers) => {
          this.handleStream(stream, headers).catch(err => {
            getBugReporter().reportError(err, 'protocol');
          });
        });

        this.server.on('session', (session) => {
          const socket = session.socket as tls.TLSSocket;
          const peerCert = socket.getPeerCertificate();
          
          if (!peerCert || !peerCert.fingerprint256) {
            session.destroy(new Error('No client certificate'));
            return;
          }

          this.emit('session', {
            fingerprint: peerCert.fingerprint256,
            subject: peerCert.subject,
          });
        });

        this.server.on('error', (err) => {
          getBugReporter().reportError(err, 'connection');
          this.emit('error', err);
        });

        this.server.listen(this.config.port, this.config.host, () => {
          this.emit('listening', { port: this.config.port, host: this.config.host });
          resolve();
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      // Close all active streams
      for (const stream of this.activeStreams) {
        if (!stream.destroyed) {
          stream.close();
        }
      }
      this.activeStreams.clear();

      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get server address
   */
  getAddress(): { port: number; host: string } | null {
    if (!this.server) return null;
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') return null;
    return { port: addr.port, host: addr.address };
  }

  /**
   * Handle incoming stream
   */
  private async handleStream(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders
  ): Promise<void> {
    this.activeStreams.add(stream);
    
    stream.on('close', () => {
      this.activeStreams.delete(stream);
    });

    // Get peer certificate
    const session = stream.session;
    const socket = session?.socket as tls.TLSSocket | undefined;
    const peerCert = socket?.getPeerCertificate();
    const peerFingerprint = peerCert?.fingerprint256 || 'unknown';

    // Set timeout
    const timeout = setTimeout(() => {
      if (!stream.destroyed) {
        stream.respond({ ':status': 408 });
        stream.end('Request Timeout');
        getBugReporter().report('timeout', 'REQUEST_TIMEOUT', 'Server request timed out');
      }
    }, this.config.requestTimeout);

    try {
      // Collect body
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks);

      clearTimeout(timeout);

      // Build request
      const req: IncomingRequest = {
        method: (headers[':method'] as string) || 'GET',
        path: (headers[':path'] as string) || '/',
        headers: Object.fromEntries(
          Object.entries(headers)
            .filter(([k]) => !k.startsWith(':'))
            .map(([k, v]) => [k, String(v)])
        ),
        body,
        peerFingerprint,
        stream,
      };

      // Call handler
      if (this.handler) {
        const response = await this.handler(req);
        
        if (!stream.destroyed) {
          stream.respond({
            ':status': response.status,
            'content-type': 'application/json',
            ...response.headers,
          });
          
          if (response.body) {
            stream.end(response.body);
          } else {
            stream.end();
          }
        }
      } else {
        stream.respond({ ':status': 501 });
        stream.end('No handler');
      }
    } catch (err) {
      clearTimeout(timeout);
      getBugReporter().reportError(err as Error, 'protocol');
      
      if (!stream.destroyed) {
        stream.respond({ ':status': 500 });
        stream.end('Internal Server Error');
      }
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createServer(config: ServerConfig): TransportServer {
  return new TransportServer(config);
}

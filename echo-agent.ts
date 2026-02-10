#!/usr/bin/env npx tsx
/**
 * Echo Agent (Agent B) - Minimal test agent for integration testing
 * 
 * Supports:
 * - TLS on port 8443 (simplified - no mutual auth required for testing)
 * - Handshake with capabilities ["messaging"]
 * - Protocol v1.0
 * - Method: echo({message}) → {echo:{message}}
 */

import * as http2 from 'node:http2';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';

// ============================================================================
// Configuration
// ============================================================================

const PORT = parseInt(process.env.ECHO_PORT ?? '8443');
const HOST = process.env.ECHO_HOST ?? '0.0.0.0';
const AGENT_NAME = process.env.AGENT_NAME ?? 'shannon';
const CERT_DIR = './echo-agent-certs';

// ============================================================================
// Certificate Management (using openssl)
// ============================================================================

interface CertInfo {
  cert: string;
  key: string;
  pubkey: string;
  fingerprint: string;
}

function ensureCerts(): CertInfo {
  const certPath = path.join(CERT_DIR, 'cert.pem');
  const keyPath = path.join(CERT_DIR, 'key.pem');
  const pubkeyPath = path.join(CERT_DIR, 'pubkey.pem');
  
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    console.log('[EchoAgent] Loading existing certificates...');
    const cert = fs.readFileSync(certPath, 'utf-8');
    const key = fs.readFileSync(keyPath, 'utf-8');
    const pubkey = fs.existsSync(pubkeyPath) ? fs.readFileSync(pubkeyPath, 'utf-8') : '';
    
    // Calculate fingerprint
    const fingerprint = crypto
      .createHash('sha256')
      .update(cert)
      .digest('hex')
      .slice(0, 32);
    
    return { cert, key, pubkey, fingerprint };
  }
  
  console.log('[EchoAgent] Generating new self-signed certificate with openssl...');
  fs.mkdirSync(CERT_DIR, { recursive: true });
  
  // Generate private key
  execSync(`openssl genrsa -out ${keyPath} 2048 2>/dev/null`);
  
  // Generate self-signed certificate
  execSync(`openssl req -new -x509 -key ${keyPath} -out ${certPath} -days 365 -subj "/CN=${AGENT_NAME}" 2>/dev/null`);
  
  // Extract public key
  execSync(`openssl rsa -in ${keyPath} -pubout -out ${pubkeyPath} 2>/dev/null`);
  
  const cert = fs.readFileSync(certPath, 'utf-8');
  const key = fs.readFileSync(keyPath, 'utf-8');
  const pubkey = fs.readFileSync(pubkeyPath, 'utf-8');
  
  const fingerprint = crypto
    .createHash('sha256')
    .update(cert)
    .digest('hex')
    .slice(0, 32);
  
  console.log(`[EchoAgent] Certificate fingerprint: ${fingerprint}`);
  return { cert, key, pubkey, fingerprint };
}

// ============================================================================
// Protocol Handlers
// ============================================================================

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function handleHandshake(id: string | number | undefined, params: Record<string, unknown>): JsonRpcResponse {
  console.log('[EchoAgent] Handshake received:', JSON.stringify(params));
  
  return {
    jsonrpc: '2.0',
    id,
    result: {
      agentId: AGENT_NAME,
      capabilities: ['messaging'],
      protocolVersions: ['1.0'],
      timestamp: Date.now(),
    },
  };
}

function handleEcho(id: string | number | undefined, params: Record<string, unknown>): JsonRpcResponse {
  const message = params.message as string ?? '';
  console.log(`[EchoAgent] Echo: "${message}"`);
  
  return {
    jsonrpc: '2.0',
    id,
    result: {
      echo: message,
      timestamp: Date.now(),
    },
  };
}

function handleUnknown(id: string | number | undefined, method: string): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`,
    },
  };
}

// ============================================================================
// HTTP/2 Server
// ============================================================================

function startServer(): void {
  const certInfo = ensureCerts();
  
  const server = http2.createSecureServer({
    key: certInfo.key,
    cert: certInfo.cert,
    // For testing, don't require client cert
    requestCert: false,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2',
  });
  
  server.on('error', (err) => {
    console.error('[EchoAgent] Server error:', err);
  });
  
  server.on('stream', (stream, headers) => {
    const method = headers[':method'];
    const reqPath = headers[':path'];
    
    console.log(`[EchoAgent] ${method} ${reqPath}`);
    
    // Health check
    if (reqPath === '/health' && method === 'GET') {
      stream.respond({ ':status': 200, 'content-type': 'application/json' });
      stream.end(JSON.stringify({ ok: true, agent: AGENT_NAME, timestamp: Date.now() }));
      return;
    }
    
    // Handshake init endpoint (AGENIUM protocol)
    if (reqPath === '/handshake/init' && method === 'POST') {
      let body = '';
      
      stream.on('data', (chunk) => {
        body += chunk.toString();
      });
      
      stream.on('end', () => {
        try {
          const init = JSON.parse(body);
          console.log(`[EchoAgent] Handshake init from: ${init.agentId?.name || 'unknown'}`);
          
          // Generate nonce
          const nonce = crypto.randomBytes(16).toString('hex');
          const peerNonce = init.nonce || '';
          const ts = Date.now();
          
          // Build response in AGENIUM format
          const response = {
            type: 'handshake_response',
            version: '1.0',
            agentId: {
              name: AGENT_NAME,
              publicKey: certInfo.pubkey,
            },
            capabilities: ['messaging'],
            acceptedCapabilities: init.capabilities || ['messaging'],
            nonce: nonce,
            peerNonce: peerNonce,
            timestamp: ts,
            // Note: Signature is placeholder - real impl would sign properly
            signature: crypto.createHash('sha256').update(`1.0|${AGENT_NAME}|${nonce}|${peerNonce}|${ts}`).digest('base64'),
          };
          
          stream.respond({ ':status': 200, 'content-type': 'application/json' });
          stream.end(JSON.stringify(response));
        } catch (err) {
          console.error('[EchoAgent] Handshake error:', err);
          stream.respond({ ':status': 400, 'content-type': 'application/json' });
          stream.end(JSON.stringify({ type: 'handshake_error', message: 'Invalid handshake init' }));
        }
      });
      
      return;
    }
    
    // Handshake complete endpoint
    if (reqPath === '/handshake/complete' && method === 'POST') {
      let body = '';
      
      stream.on('data', (chunk) => {
        body += chunk.toString();
      });
      
      stream.on('end', () => {
        try {
          const complete = JSON.parse(body);
          console.log(`[EchoAgent] Handshake complete: session ${complete.sessionId}`);
          
          // Respond with session confirmation
          const response = {
            sessionId: complete.sessionId || `sess-${Date.now()}`,
          };
          
          stream.respond({ ':status': 200, 'content-type': 'application/json' });
          stream.end(JSON.stringify(response));
        } catch (err) {
          console.error('[EchoAgent] Handshake complete error:', err);
          stream.respond({ ':status': 400, 'content-type': 'application/json' });
          stream.end(JSON.stringify({ error: 'Invalid handshake complete' }));
        }
      });
      
      return;
    }
    
    // AGENIUM message endpoint (frame-based messaging)
    if (reqPath === '/message' && method === 'POST') {
      let body = '';
      
      stream.on('data', (chunk) => {
        body += chunk.toString();
      });
      
      stream.on('end', () => {
        try {
          const frame = JSON.parse(body);
          console.log(`[EchoAgent] Message: type=${frame.type}, method=${frame.payload?.method || 'N/A'}`);
          
          // Handle REQUEST frames (type can be 0 or 'REQUEST')
          if (frame.type === 0 || frame.type === 'REQUEST') {
            const method = frame.payload?.method;
            const params = frame.payload?.params || {};
            
            let result: unknown;
            
            if (method === 'echo') {
              result = { echo: params.message, timestamp: Date.now() };
            } else if (method === 'notify') {
              result = { ack: true };
            } else {
              result = { error: `Unknown method: ${method}` };
            }
            
            // Build response frame (use same type format as request)
            const responseFrame = {
              version: '1.0',
              messageId: `resp-${Date.now()}`,
              replyTo: frame.messageId,  // Critical: matches original request messageId
              type: typeof frame.type === 'string' ? 'RESPONSE' : 2,
              sessionId: frame.sessionId,
              timestamp: Date.now(),
              payload: { success: true, result },
            };
            
            stream.respond({ ':status': 200, 'content-type': 'application/json' });
            stream.end(JSON.stringify(responseFrame));
            return;
          }
          
          // Handle EVENT frames (fire-and-forget, type can be 1 or 'EVENT')
          if (frame.type === 1 || frame.type === 'EVENT') {
            console.log(`[EchoAgent] Event received: ${frame.payload?.event}`);
            stream.respond({ ':status': 200 });
            stream.end();
            return;
          }
          
          // Unknown frame type
          stream.respond({ ':status': 400, 'content-type': 'application/json' });
          stream.end(JSON.stringify({ error: `Unknown frame type: ${frame.type}` }));
        } catch (err) {
          console.error('[EchoAgent] Message error:', err);
          stream.respond({ ':status': 400, 'content-type': 'application/json' });
          stream.end(JSON.stringify({ error: 'Invalid message frame' }));
        }
      });
      
      return;
    }
    
    // JSON-RPC endpoint
    if (reqPath === '/rpc' && method === 'POST') {
      let body = '';
      
      stream.on('data', (chunk) => {
        body += chunk.toString();
      });
      
      stream.on('end', () => {
        try {
          const request: JsonRpcRequest = JSON.parse(body);
          let response: JsonRpcResponse;
          
          switch (request.method) {
            case 'handshake':
              response = handleHandshake(request.id, request.params ?? {});
              break;
            case 'echo':
              response = handleEcho(request.id, request.params ?? {});
              break;
            case 'notify':
              // Events/notifications
              console.log(`[EchoAgent] Notification: ${JSON.stringify(request.params)}`);
              response = { jsonrpc: '2.0', id: request.id, result: { ack: true } };
              break;
            default:
              response = handleUnknown(request.id, request.method);
          }
          
          stream.respond({ ':status': 200, 'content-type': 'application/json' });
          stream.end(JSON.stringify(response));
        } catch (err) {
          console.error('[EchoAgent] Parse error:', err);
          stream.respond({ ':status': 400, 'content-type': 'application/json' });
          stream.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      
      return;
    }
    
    // 404
    stream.respond({ ':status': 404 });
    stream.end('Not Found');
  });
  
  server.listen(PORT, HOST, () => {
    console.log(`
╔════════════════════════════════════════════╗
║         ECHO AGENT (Agent B) v1.0          ║
╚════════════════════════════════════════════╝

Agent Name:    ${AGENT_NAME}
Endpoint:      https://194.5.206.180:${PORT}
Protocol:      1.0
Capabilities:  ["messaging"]

Endpoints:
  GET  /health  - Health check
  POST /rpc     - JSON-RPC (handshake, echo, notify)

Certificate fingerprint: ${certInfo.fingerprint}
  
Public Key (for DNS registration):
${certInfo.pubkey.trim()}

Ready for connections! 🚀
`);
  });
  
  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[EchoAgent] Shutting down...');
    server.close(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    console.log('\n[EchoAgent] Shutting down...');
    server.close(() => process.exit(0));
  });
}

// ============================================================================
// Main
// ============================================================================

startServer();

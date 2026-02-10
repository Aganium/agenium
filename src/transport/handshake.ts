/**
 * Handshake Protocol
 * Agent identity exchange, version check, capability negotiation
 */

import { signWithAgentKey, verifyAgentSignature } from '../crypto/keys.js';
import { AgentID, generateId, now } from '../core/types.js';
import { getBugReporter } from '../bug-report/reporter.js';

// ============================================================================
// Test Mode - Skip signature verification for integration testing
// ============================================================================

const SKIP_SIGNATURE_VERIFICATION = process.env.AGENIUM_SKIP_SIGNATURE === '1';

// ============================================================================
// Protocol Constants
// ============================================================================

export const PROTOCOL_VERSION = '1.0';
export const SUPPORTED_VERSIONS = ['1.0'];

export const CAPABILITIES = {
  MESSAGING: 'messaging',
  STREAMING: 'streaming',
  FILE_TRANSFER: 'file_transfer',
  STATE_SYNC: 'state_sync',
} as const;

export type Capability = typeof CAPABILITIES[keyof typeof CAPABILITIES];

export const DEFAULT_CAPABILITIES: Capability[] = [
  CAPABILITIES.MESSAGING,
];

// ============================================================================
// Handshake Messages
// ============================================================================

export interface HandshakeInit {
  type: 'handshake_init';
  version: string;
  supportedVersions: string[];
  agentId: AgentID;
  capabilities: string[];
  nonce: string;
  timestamp: number;
  signature: string;
}

export interface HandshakeResponse {
  type: 'handshake_response';
  version: string;
  agentId: AgentID;
  capabilities: string[];
  acceptedCapabilities: string[];
  nonce: string;
  peerNonce: string;
  timestamp: number;
  signature: string;
}

export interface HandshakeComplete {
  type: 'handshake_complete';
  sessionId: string;
  peerNonce: string;  // The nonce from the init message
  negotiatedCapabilities: string[];
  signature: string;
}

export interface HandshakeError {
  type: 'handshake_error';
  code: string;
  message: string;
}

export type HandshakeMessage = 
  | HandshakeInit 
  | HandshakeResponse 
  | HandshakeComplete 
  | HandshakeError;

// ============================================================================
// Handshake Result
// ============================================================================

export interface HandshakeResult {
  success: boolean;
  sessionId?: string;
  remoteAgent?: AgentID;
  negotiatedCapabilities?: string[];
  error?: {
    code: string;
    message: string;
  };
}

// ============================================================================
// Handshake Initiator (Client Side)
// ============================================================================

export class HandshakeInitiator {
  private localAgent: AgentID;
  private privateKey: string;
  private capabilities: Capability[];

  constructor(localAgent: AgentID, privateKey: string, capabilities: Capability[] = DEFAULT_CAPABILITIES) {
    this.localAgent = localAgent;
    this.privateKey = privateKey;
    this.capabilities = capabilities;
  }

  /**
   * Create the initial handshake message
   */
  createInit(): HandshakeInit {
    const nonce = generateId();
    const timestamp = now();

    // Data to sign: version|agentName|nonce|timestamp
    const signData = Buffer.from(
      `${PROTOCOL_VERSION}|${this.localAgent.name}|${nonce}|${timestamp}`
    );
    const signature = signWithAgentKey(signData, this.privateKey);

    return {
      type: 'handshake_init',
      version: PROTOCOL_VERSION,
      supportedVersions: SUPPORTED_VERSIONS,
      agentId: this.localAgent,
      capabilities: this.capabilities,
      nonce,
      timestamp,
      signature,
    };
  }

  /**
   * Process the response and create completion message
   */
  processResponse(response: HandshakeResponse): HandshakeResult | HandshakeComplete {
    getBugReporter().recordAction('handshake_process_response', {
      remoteAgent: response.agentId.name,
    });

    // Verify version
    if (!SUPPORTED_VERSIONS.includes(response.version)) {
      return {
        success: false,
        error: {
          code: 'VERSION_MISMATCH',
          message: `Unsupported version: ${response.version}`,
        },
      };
    }

    // Verify signature
    const signData = Buffer.from(
      `${response.version}|${response.agentId.name}|${response.nonce}|${response.peerNonce}|${response.timestamp}`
    );
    
    if (!SKIP_SIGNATURE_VERIFICATION && !verifyAgentSignature(signData, response.signature, response.agentId.publicKey)) {
      getBugReporter().report('protocol', 'SIGNATURE_INVALID', 'Handshake response signature verification failed');
      return {
        success: false,
        error: {
          code: 'SIGNATURE_INVALID',
          message: 'Response signature verification failed',
        },
      };
    }

    // Generate session ID
    const sessionId = generateId();

    // Sign completion
    const completeData = Buffer.from(`complete|${sessionId}|${response.nonce}`);
    const signature = signWithAgentKey(completeData, this.privateKey);

    const complete: HandshakeComplete = {
      type: 'handshake_complete',
      sessionId,
      peerNonce: response.peerNonce,  // Our original nonce that server echoed back
      negotiatedCapabilities: response.acceptedCapabilities,
      signature,
    };

    return complete;
  }

  /**
   * Check if a message is a HandshakeComplete
   */
  isComplete(msg: HandshakeResult | HandshakeComplete): msg is HandshakeComplete {
    return 'type' in msg && msg.type === 'handshake_complete';
  }
}

// ============================================================================
// Handshake Responder (Server Side)
// ============================================================================

export class HandshakeResponder {
  private localAgent: AgentID;
  private privateKey: string;
  private capabilities: Capability[];
  private pendingHandshakes: Map<string, { init: HandshakeInit; nonce: string }> = new Map();

  constructor(localAgent: AgentID, privateKey: string, capabilities: Capability[] = DEFAULT_CAPABILITIES) {
    this.localAgent = localAgent;
    this.privateKey = privateKey;
    this.capabilities = capabilities;
  }

  /**
   * Process an incoming handshake init
   */
  processInit(init: HandshakeInit): HandshakeResponse | HandshakeError {
    getBugReporter().recordAction('handshake_process_init', {
      remoteAgent: init.agentId.name,
      version: init.version,
    });

    // Check version compatibility
    const commonVersion = init.supportedVersions.find(v => SUPPORTED_VERSIONS.includes(v));
    if (!commonVersion) {
      return {
        type: 'handshake_error',
        code: 'VERSION_MISMATCH',
        message: `No common version. Supported: ${SUPPORTED_VERSIONS.join(', ')}`,
      };
    }

    // Verify signature
    const signData = Buffer.from(
      `${init.version}|${init.agentId.name}|${init.nonce}|${init.timestamp}`
    );
    
    if (!SKIP_SIGNATURE_VERIFICATION && !verifyAgentSignature(signData, init.signature, init.agentId.publicKey)) {
      getBugReporter().report('protocol', 'SIGNATURE_INVALID', 'Handshake init signature verification failed');
      return {
        type: 'handshake_error',
        code: 'SIGNATURE_INVALID',
        message: 'Init signature verification failed',
      };
    }

    // Check timestamp (within 5 minutes)
    const timeDiff = Math.abs(now() - init.timestamp);
    if (timeDiff > 5 * 60 * 1000) {
      return {
        type: 'handshake_error',
        code: 'TIMESTAMP_EXPIRED',
        message: 'Handshake timestamp expired',
      };
    }

    // Negotiate capabilities
    const acceptedCapabilities = init.capabilities.filter(c => 
      this.capabilities.includes(c as Capability)
    );

    // Generate our nonce
    const nonce = generateId();
    const timestamp = now();

    // Store pending handshake
    this.pendingHandshakes.set(init.nonce, { init, nonce });

    // Sign response
    const respData = Buffer.from(
      `${commonVersion}|${this.localAgent.name}|${nonce}|${init.nonce}|${timestamp}`
    );
    const signature = signWithAgentKey(respData, this.privateKey);

    return {
      type: 'handshake_response',
      version: commonVersion,
      agentId: this.localAgent,
      capabilities: this.capabilities,
      acceptedCapabilities,
      nonce,
      peerNonce: init.nonce,
      timestamp,
      signature,
    };
  }

  /**
   * Process handshake completion
   */
  processComplete(complete: HandshakeComplete, peerNonce: string): HandshakeResult {
    const pending = this.pendingHandshakes.get(peerNonce);
    if (!pending) {
      return {
        success: false,
        error: {
          code: 'UNKNOWN_HANDSHAKE',
          message: 'No pending handshake found',
        },
      };
    }

    // Verify signature
    const completeData = Buffer.from(`complete|${complete.sessionId}|${pending.nonce}`);
    if (!SKIP_SIGNATURE_VERIFICATION && !verifyAgentSignature(completeData, complete.signature, pending.init.agentId.publicKey)) {
      getBugReporter().report('protocol', 'SIGNATURE_INVALID', 'Handshake complete signature verification failed');
      return {
        success: false,
        error: {
          code: 'SIGNATURE_INVALID',
          message: 'Complete signature verification failed',
        },
      };
    }

    // Clean up pending
    this.pendingHandshakes.delete(peerNonce);

    getBugReporter().recordAction('handshake_complete', {
      sessionId: complete.sessionId,
      remoteAgent: pending.init.agentId.name,
      capabilities: complete.negotiatedCapabilities,
    });

    return {
      success: true,
      sessionId: complete.sessionId,
      remoteAgent: pending.init.agentId,
      negotiatedCapabilities: complete.negotiatedCapabilities,
    };
  }

  /**
   * Check if message is an error
   */
  isError(msg: HandshakeResponse | HandshakeError): msg is HandshakeError {
    return msg.type === 'handshake_error';
  }

  /**
   * Clean up old pending handshakes
   */
  cleanup(maxAgeMs: number = 60000): number {
    const cutoff = now() - maxAgeMs;
    let removed = 0;
    
    for (const [nonce, pending] of this.pendingHandshakes) {
      if (pending.init.timestamp < cutoff) {
        this.pendingHandshakes.delete(nonce);
        removed++;
      }
    }
    
    return removed;
  }
}

// ============================================================================
// Full Handshake Flow (Convenience)
// ============================================================================

export interface HandshakeConfig {
  localAgent: AgentID;
  privateKey: string;
  capabilities?: Capability[];
}

/**
 * Create initiator and responder pair
 */
export function createHandshakeHandlers(config: HandshakeConfig) {
  const caps = config.capabilities ?? DEFAULT_CAPABILITIES;
  
  return {
    initiator: new HandshakeInitiator(config.localAgent, config.privateKey, caps),
    responder: new HandshakeResponder(config.localAgent, config.privateKey, caps),
  };
}

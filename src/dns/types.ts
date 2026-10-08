/**
 * DNS Types and API Contract
 * Defines the interface with the AGENIUM DNS registry (dns.agenium.net)
 */

// ============================================================================
// DNS API Contract
// ============================================================================

/**
 * Agent registration request
 * POST /api/agents/register
 */
export interface DNSRegisterRequest {
  /** Agent name (unique identifier) */
  name: string;
  /** Agent's Ed25519 public key (base64) */
  publicKey: string;
  /** HTTPS endpoint URL */
  endpoint: string;
  /** Optional description */
  description?: string;
  /** Supported capabilities */
  capabilities: string[];
  /** Supported protocol versions */
  protocolVersions: string[];
  /** Tool definitions advertised to callers */
  tools?: AgentTool[];
  /** Free-form metadata */
  metadata?: Record<string, unknown>;
  /** ms since epoch; must be within 5 minutes of the server clock */
  timestamp: number;
  /** base64 Ed25519 signature of dnsRegisterMessage(...) with the agent identity key */
  signature: string;
}

/**
 * Canonical payloads signed for DNS writes. The registry verifies these
 * byte-for-byte, so they must stay in lockstep with the server.
 * `name` is the lowercase agent name; `timestamp` is ms since epoch.
 */
export function dnsRegisterMessage(name: string, endpoint: string, publicKey: string, timestamp: number): string {
  return ['agenium-dns/v1/register', name.toLowerCase(), endpoint, publicKey, String(timestamp)].join('\n');
}

export function dnsDeleteMessage(name: string, timestamp: number): string {
  return ['agenium-dns/v1/delete', name.toLowerCase(), String(timestamp)].join('\n');
}

/**
 * Agent registration response
 */
export interface DNSRegisterResponse {
  success: boolean;
  message?: string;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Agent lookup request
 * GET /api/agents/{name}
 */
export interface DNSLookupResponse {
  success: boolean;
  agent?: {
    /** Agent name */
    name: string;
    /** Agent's Ed25519 public key (base64) */
    publicKey: string;
    /** HTTPS endpoint URL */
    endpoint: string;
    /** Description */
    description?: string;
    /** Supported capabilities */
    capabilities: string[];
    /** Supported protocol versions */
    protocolVersions: string[];
    /** Cache TTL in seconds */
    ttl: number;
    /** When this record was last updated */
    updatedAt: number;
  };
  error?: {
    code: DNSErrorCode;
    message: string;
  };
}

// ============================================================================
// Error Codes
// ============================================================================

export enum DNSErrorCode {
  /** Agent not found in registry */
  NOT_FOUND = 'NOT_FOUND',
  /** DNS server timeout */
  TIMEOUT = 'TIMEOUT',
  /** Invalid agent name format */
  INVALID_NAME = 'INVALID_NAME',
  /** Invalid public key */
  INVALID_KEY = 'INVALID_KEY',
  /** Registration failed */
  REGISTRATION_FAILED = 'REGISTRATION_FAILED',
  /** Network error */
  NETWORK_ERROR = 'NETWORK_ERROR',
  /** Server error */
  SERVER_ERROR = 'SERVER_ERROR',
  /** Signature verification failed */
  SIGNATURE_INVALID = 'SIGNATURE_INVALID',
  /** Public key mismatch */
  KEY_MISMATCH = 'KEY_MISMATCH',
}

// ============================================================================
// Capability Manifest
// ============================================================================

/**
 * A tool/function that an agent exposes.
 * Follows MCP/OpenAI-style schema for interoperability.
 */
export interface AgentTool {
  /** Tool identifier (unique within this agent) */
  name: string;
  /** Human-readable description */
  description?: string;
  /** JSON Schema describing accepted input */
  inputSchema?: Record<string, unknown>;
  /** JSON Schema describing output format */
  outputSchema?: Record<string, unknown>;
}

/**
 * Full capability manifest returned in resolve response.
 * Tells callers exactly what an agent can do.
 */
export interface CapabilityManifest {
  /** Structured tool definitions */
  tools: AgentTool[];
  /** Free-form capability tags (backward compat) */
  capabilities: string[];
  /** Supported protocol versions */
  protocolVersions: string[];
  /** Agent description */
  description?: string;
  /** Extra metadata (contact, docs URL, etc.) */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Resolved Agent Info
// ============================================================================

export interface ResolvedAgent {
  /** Agent name */
  name: string;
  /** Agent's Ed25519 public key (base64) */
  publicKey: string;
  /** HTTPS endpoint URL */
  endpoint: string;
  /** Parsed host from endpoint */
  host: string;
  /** Parsed port from endpoint */
  port: number;
  /** Description */
  description?: string;
  /** Supported capabilities (tags) */
  capabilities: string[];
  /** Structured tool definitions */
  tools: AgentTool[];
  /** Supported protocol versions */
  protocolVersions: string[];
  /** Extra metadata from the agent */
  metadata?: Record<string, unknown>;
  /** When this was resolved */
  resolvedAt: number;
  /** When this cache entry expires */
  expiresAt: number;
}

// ============================================================================
// Resolve Result
// ============================================================================

export type ResolveResult = 
  | { ok: true; agent: ResolvedAgent }
  | { ok: false; error: { code: DNSErrorCode; message: string } };

// ============================================================================
// Agent Name Validation
// ============================================================================

const AGENT_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/;

export function validateAgentName(name: string): boolean {
  return AGENT_NAME_REGEX.test(name);
}

// Re-export agent URI utilities from core types for convenience
export { parseAgentURI, isValidAgentURI, toAgentURI } from '../core/types.js';

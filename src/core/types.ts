/**
 * AGENIUM Core Types
 * Defines fundamental data structures for agent-to-agent communication
 */

// ============================================================================
// Agent Identity
// ============================================================================

/**
 * Unique identifier for an agent in the network
 */
export interface AgentID {
  /** Unique name (used in agent:// URI) */
  name: string;
  /** Ed25519 public key (base64 encoded) */
  publicKey: string;
  /** Optional human-readable description */
  description?: string;
}

/**
 * Parse agent:// URI to extract agent name
 * Format: agent://name
 * - Length: 2-50 characters
 * - Characters: lowercase alphanumeric, hyphens, unicode (IDN)
 * - Must not start or end with hyphen
 * @example agent://alice, agent://my-agent, agent://bot123
 */
export function parseAgentURI(uri: string): { name: string } | null {
  if (!uri.startsWith('agent://')) return null;
  
  const name = uri.slice(8).toLowerCase();
  
  // Validate length
  if (name.length < 2 || name.length > 50) return null;
  
  // Must not start/end with hyphen
  if (name.startsWith('-') || name.endsWith('-')) return null;
  
  // IDN: allow lowercase, digits, hyphen, unicode
  // Regex: starts with alphanumeric/unicode, middle can have hyphens, ends with alphanumeric/unicode
  const valid = /^[a-z0-9\u0080-\uffff]([a-z0-9\u0080-\uffff-]*[a-z0-9\u0080-\uffff])?$/i.test(name);
  if (!valid) return null;

  return { name };
}

/**
 * Validate if a string is a valid agent:// URI
 */
export function isValidAgentURI(uri: string): boolean {
  return parseAgentURI(uri) !== null;
}

/**
 * Convert a name to agent:// URI format
 */
export function toAgentURI(name: string): string {
  return `agent://${name.toLowerCase()}`;
}

// ============================================================================
// Agent Endpoint
// ============================================================================

/**
 * A tool/function that an agent exposes (re-exported from dns/types for convenience)
 */
export interface AgentToolRef {
  name: string;
  description?: string;
}

/**
 * Resolved endpoint for connecting to an agent
 */
export interface AgentEndpoint {
  /** The agent's identity */
  agentId: AgentID;
  /** HTTPS endpoint URL */
  url: string;
  /** mTLS certificate fingerprint (for pinning) */
  certFingerprint?: string;
  /** Supported protocol versions */
  protocolVersions: string[];
  /** Capabilities this agent supports */
  capabilities: string[];
  /** Tools this agent exposes */
  tools: AgentToolRef[];
  /** TTL in seconds for caching */
  ttl: number;
  /** When this endpoint was resolved */
  resolvedAt: number;
}

// ============================================================================
// Session State Machine
// ============================================================================

/**
 * Session states in the FSM
 */
export enum SessionState {
  /** Initial state, no connection */
  IDLE = 'IDLE',
  /** Connection in progress */
  CONNECTING = 'CONNECTING',
  /** Handshake in progress */
  HANDSHAKING = 'HANDSHAKING',
  /** Fully connected and operational */
  ACTIVE = 'ACTIVE',
  /** Temporarily paused (can resume) */
  SUSPENDED = 'SUSPENDED',
  /** Terminated (cannot resume) */
  CLOSED = 'CLOSED',
  /** Error state (can retry or close) */
  ERROR = 'ERROR',
}

/**
 * Events that trigger state transitions
 */
export enum SessionEvent {
  CONNECT = 'CONNECT',
  CONNECTED = 'CONNECTED',
  HANDSHAKE_START = 'HANDSHAKE_START',
  HANDSHAKE_OK = 'HANDSHAKE_OK',
  HANDSHAKE_FAIL = 'HANDSHAKE_FAIL',
  SUSPEND = 'SUSPEND',
  RESUME = 'RESUME',
  DISCONNECT = 'DISCONNECT',
  ERROR = 'ERROR',
  TIMEOUT = 'TIMEOUT',
}

/**
 * Full session data structure
 */
export interface Session {
  /** Unique session identifier */
  id: string;
  /** Local agent identity */
  localAgent: AgentID;
  /** Remote agent identity */
  remoteAgent: AgentID;
  /** Current FSM state */
  state: SessionState;
  /** When session was created */
  createdAt: number;
  /** Last activity timestamp */
  lastActivity: number;
  /** Handshake completion flag */
  handshakeComplete: boolean;
  /** Negotiated capabilities */
  capabilities: string[];
  /** Message counter for replay protection */
  messageCounter: number;
  /** Error message if in ERROR state */
  errorMessage?: string;
}

// ============================================================================
// Messages
// ============================================================================

/**
 * Message priority levels
 */
export enum MessagePriority {
  CRITICAL = 0,
  NORMAL = 1,
  LOW = 2,
}

/**
 * A message in the queue
 */
export interface Message {
  /** Unique message ID */
  id: string;
  /** Target session ID */
  sessionId: string;
  /** Message payload (JSON-serializable) */
  payload: unknown;
  /** Priority level */
  priority: MessagePriority;
  /** When message was queued */
  queuedAt: number;
  /** Number of send attempts */
  attempts: number;
  /** Max retry attempts */
  maxAttempts: number;
}

// ============================================================================
// Bug Report
// ============================================================================

/**
 * Types of errors that can be reported
 */
export type BugReportType = 
  | 'crash'
  | 'timeout'
  | 'protocol'
  | 'connection'
  | 'internal'
  | 'validation';

/**
 * An action in the action history
 */
export interface ActionRecord {
  /** Action type */
  type: string;
  /** When it occurred */
  timestamp: number;
  /** Action details */
  details?: Record<string, unknown>;
  /** Duration in ms (if applicable) */
  durationMs?: number;
}

/**
 * Complete bug report schema
 */
export interface BugReport {
  /** Unique report ID */
  reportId: string;
  /** Reporting agent's ID */
  agentId: string;
  /** Software version */
  agentVersion: string;
  
  /** When error occurred */
  timestamp: number;
  /** Agent uptime in seconds */
  uptime: number;
  
  /** Error classification */
  errorType: BugReportType;
  /** Machine-readable error code */
  errorCode: string;
  /** Human-readable message */
  errorMessage: string;
  /** Stack trace if available */
  stackTrace?: string;
  
  /** Related session ID */
  sessionId?: string;
  /** Last N actions before error */
  lastActions: ActionRecord[];
  
  /** System state snapshot */
  state: {
    sessionCount: number;
    queueDepth: number;
    memoryUsageMB: number;
    activeConnections: number;
  };
  
  /** Runtime environment */
  environment: {
    platform: string;
    nodeVersion: string;
    arch: string;
  };
  
  /** Whether sensitive data was removed */
  sanitized: boolean;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Daemon configuration
 */
export interface AgeniumConfig {
  /** Agent name (for agent:// URI) */
  agentName: string;
  /** DNS server for agent resolution */
  dnsServer: string;
  /** Bug report server URL */
  bugReportServer: string;
  /** Port for inbound connections */
  listenPort: number;
  /** Data directory path */
  dataDir: string;
  /** Session history depth */
  historyDepth: number;
  /** Connection timeout in ms */
  connectionTimeoutMs: number;
  /** Request timeout in ms */
  requestTimeoutMs: number;
}

/**
 * Default configuration
 */
export const DEFAULT_CONFIG: AgeniumConfig = {
  agentName: 'unnamed-agent',
  dnsServer: '185.204.169.26',
  bugReportServer: 'https://bugs.agenium.local',
  listenPort: 8443,
  dataDir: '~/.agenium',
  historyDepth: 100,
  connectionTimeoutMs: 10000,
  requestTimeoutMs: 30000,
};

// ============================================================================
// Utilities
// ============================================================================

/**
 * Generate a UUID v4
 */
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Get current timestamp in milliseconds
 */
export function now(): number {
  return Date.now();
}

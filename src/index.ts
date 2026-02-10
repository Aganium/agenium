/**
 * AGENIUM - Local, Stateful Agent-to-Agent Client
 * 
 * Entry point and public API
 */

// Core types and utilities
export * from './core/index.js';

// Cryptography
export * from './crypto/index.js';

// DNS resolution - explicit exports to avoid conflicts
export {
  // Types
  DNSErrorCode,
  ResolvedAgent,
  validateAgentName,
  // Resolver
  DNSResolver,
  getResolver,
  resetResolver,
  // Server (for testing)
  DNSServer,
  createDNSServer,
} from './dns/index.js';

// Session state management
export * from './state/index.js';

// Bug reporting
export * from './bug-report/index.js';

// Protocol (messaging) - explicit exports to avoid conflicts
export {
  // Types
  MessageType,
  AnyFrame,
  RequestFrame,
  ResponseFrame,
  EventFrame,
  ErrorFrame,
  RequestPayload,
  ResponsePayload,
  EventPayload,
  ErrorPayload,
  ErrorCodes,
  // Frame builders
  createRequestFrame,
  createResponseFrame,
  createEventFrame,
  createErrorFrame,
  validateFrame,
  // Dispatcher
  MessageDispatcher,
  createDispatcher,
} from './protocol/index.js';

// Transport layer - explicit exports to avoid conflicts
export {
  TransportServer,
  createServer,
  TransportClient,
  createClient,
  HandshakeInitiator,
  HandshakeResponder,
  createHandshakeHandlers,
  PROTOCOL_VERSION,
  CAPABILITIES,
  DEFAULT_CAPABILITIES,
} from './transport/index.js';

// Persistence
export {
  DatabaseManager,
  createDatabase,
  ResumeManager,
  createResumeManager,
  OutboxManager,
  createOutboxManager,
} from './persistence/index.js';

// High-level Agent API
export { Agent, createAgent, type AgentConfig, type ConnectResult } from './agent.js';

// Metrics and observability
export {
  metrics,
  getHealth,
  getMetricsText,
  setHealthProvider,
  type HealthStatus,
} from './metrics/index.js';
export { MetricsServer } from './metrics/server.js';

// Configuration
export {
  getConfig,
  setConfig,
  CircuitBreaker,
  DEFAULT_CONFIG,
  type AgeniumConfig,
  type TimeoutConfig,
  type PoolConfig,
  type CircuitBreakerConfig,
} from './config.js';

// Shutdown management
export {
  getShutdownManager,
  registerStandardHooks,
  type ShutdownConfig,
} from './shutdown.js';

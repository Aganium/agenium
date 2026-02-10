/**
 * Unified Bug Report Adapter for AGENIUM
 * Converts native BugReport → UnifiedBugReport for the unified bug server
 */

import type { BugReport, BugReportType } from '../core/types.js';
import { generateId, now } from '../core/types.js';

// ============================================================================
// Unified Bug Report Types (from unified-bug-server)
// ============================================================================

export type Source = 'dns' | 'marketplace' | 'agenium';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type ErrorType = 
  | 'connection' | 'protocol' | 'timeout' | 'internal' 
  | 'security' | 'payment' | 'db' | 'validation' | 'dns' | 'handshake';

export interface Environment {
  host: string;
  service: string;
  version: string;
  region?: string;
  platform?: string;
  node_version?: string;
}

export interface UnifiedBugReport {
  report_id: string;
  source: Source;
  severity: Severity;
  error_type: ErrorType;
  error_code: string;
  message: string;
  timestamp_client: number;
  environment: Environment;
  stack_trace?: string;
  trace_id?: string;
  session_id?: string;
  domain?: string;
  agent_uri?: string;
  endpoint?: string;
  context?: Record<string, unknown>;
  user_id?: string;
  request_id?: string;
}

// ============================================================================
// Type Mappings
// ============================================================================

const ERROR_TYPE_MAP: Record<BugReportType, ErrorType> = {
  crash: 'internal',
  timeout: 'timeout',
  protocol: 'protocol',
  connection: 'connection',
  internal: 'internal',
  validation: 'validation',
};

const SEVERITY_MAP: Record<BugReportType, Severity> = {
  crash: 'critical',
  timeout: 'medium',
  protocol: 'high',
  connection: 'medium',
  internal: 'high',
  validation: 'low',
};

// Error codes that should be high/critical severity
const HIGH_SEVERITY_CODES = new Set([
  'UNCAUGHT_EXCEPTION',
  'UNHANDLED_REJECTION',
  'TLS_CERT_EXPIRED',
  'TLS_CERT_INVALID',
  'HANDSHAKE_FAILED',
  'AUTH_FAILED',
  'DATA_CORRUPTION',
]);

// ============================================================================
// Adapter Functions
// ============================================================================

/**
 * Convert Agenium BugReport to UnifiedBugReport
 */
export function toUnifiedReport(
  report: BugReport,
  options: {
    traceId?: string;
    agentUri?: string;
    endpoint?: string;
    domain?: string;
  } = {}
): UnifiedBugReport {
  // Map error type
  const errorType = ERROR_TYPE_MAP[report.errorType] ?? 'internal';
  
  // Determine severity
  let severity = SEVERITY_MAP[report.errorType] ?? 'medium';
  if (HIGH_SEVERITY_CODES.has(report.errorCode)) {
    severity = 'critical';
  }
  
  // Build context from state and actions
  const context: Record<string, unknown> = {
    uptime_seconds: report.uptime,
    state: {
      sessions: report.state.sessionCount,
      queue_depth: report.state.queueDepth,
      memory_mb: report.state.memoryUsageMB,
      connections: report.state.activeConnections,
    },
  };
  
  // Include last actions if present
  if (report.lastActions.length > 0) {
    context.last_actions = report.lastActions.map(a => ({
      type: a.type,
      timestamp: a.timestamp,
      details: a.details,
      duration_ms: a.durationMs,
    }));
  }

  return {
    report_id: report.reportId,
    source: 'agenium',
    severity,
    error_type: errorType,
    error_code: report.errorCode,
    message: report.errorMessage,
    timestamp_client: report.timestamp,
    environment: {
      host: report.agentId,
      service: 'agenium-client',
      version: report.agentVersion,
      platform: report.environment.platform,
      node_version: report.environment.nodeVersion,
    },
    stack_trace: report.stackTrace,
    trace_id: options.traceId,
    session_id: report.sessionId,
    agent_uri: options.agentUri,
    endpoint: options.endpoint,
    domain: options.domain,
    context,
  };
}

/**
 * Create a new unified report directly (for new errors)
 */
export function createUnifiedReport(
  errorCode: string,
  message: string,
  options: {
    errorType?: ErrorType;
    severity?: Severity;
    stackTrace?: string;
    traceId?: string;
    sessionId?: string;
    agentUri?: string;
    endpoint?: string;
    domain?: string;
    context?: Record<string, unknown>;
    environment?: Partial<Environment>;
  } = {}
): UnifiedBugReport {
  return {
    report_id: generateId(),
    source: 'agenium',
    severity: options.severity ?? 'medium',
    error_type: options.errorType ?? 'internal',
    error_code: errorCode,
    message,
    timestamp_client: now(),
    environment: {
      host: options.environment?.host ?? process.env.HOSTNAME ?? 'unknown',
      service: options.environment?.service ?? 'agenium-client',
      version: options.environment?.version ?? '0.1.0',
      platform: options.environment?.platform ?? process.platform,
      node_version: options.environment?.node_version ?? process.version,
    },
    stack_trace: options.stackTrace,
    trace_id: options.traceId,
    session_id: options.sessionId,
    agent_uri: options.agentUri,
    endpoint: options.endpoint,
    domain: options.domain,
    context: options.context,
  };
}

// ============================================================================
// Unified Bug Reporter (sends to unified-bug-server)
// ============================================================================

export interface UnifiedReporterConfig {
  serverUrl: string;
  authToken: string;
  timeoutMs: number;
}

const DEFAULT_CONFIG: UnifiedReporterConfig = {
  serverUrl: process.env.UNIFIED_BUG_URL ?? 'http://localhost:3100/api/reports',
  authToken: process.env.UNIFIED_BUG_TOKEN ?? 'dev-token-change-me',
  timeoutMs: 5000,
};

/**
 * Send a unified report to the bug server
 * Non-blocking - returns immediately
 */
export function sendUnifiedReport(
  report: UnifiedBugReport,
  config: Partial<UnifiedReporterConfig> = {}
): void {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  
  // Fire and forget - don't block
  (async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);
      
      const response = await fetch(cfg.serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.authToken}`,
        },
        body: JSON.stringify(report),
        signal: controller.signal,
      });
      
      clearTimeout(timeout);
      
      if (!response.ok) {
        console.error(`[UnifiedAdapter] Upload failed: ${response.status}`);
      } else {
        const result = await response.json() as { fingerprint?: string };
        console.log(`[UnifiedAdapter] Sent ${report.report_id} → ${result.fingerprint?.slice(0, 8)}...`);
      }
    } catch (err) {
      // Silent fail - don't block main flow
      if ((err as Error).name !== 'AbortError') {
        console.error(`[UnifiedAdapter] Error:`, (err as Error).message);
      }
    }
  })();
}

/**
 * Report an error to the unified server
 * Convenience function combining create + send
 */
export function reportToUnified(
  errorCode: string,
  message: string,
  options: Parameters<typeof createUnifiedReport>[2] = {}
): string {
  const report = createUnifiedReport(errorCode, message, options);
  sendUnifiedReport(report);
  return report.report_id;
}

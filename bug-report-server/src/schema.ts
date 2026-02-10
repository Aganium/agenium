/**
 * Bug Report Server - Schema Definitions
 * Zod schemas for validation and type safety
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';

// ============================================================================
// Input Schemas (from Agenium client)
// ============================================================================

export const ActionRecordSchema = z.object({
  type: z.string(),
  timestamp: z.number(),
  details: z.record(z.unknown()).optional(),
  durationMs: z.number().optional(),
});

export const StateSnapshotSchema = z.object({
  sessionCount: z.number(),
  queueDepth: z.number(),
  memoryUsageMB: z.number(),
  activeConnections: z.number(),
});

export const EnvironmentSchema = z.object({
  platform: z.string(),
  nodeVersion: z.string(),
  arch: z.string(),
});

export const BugReportSchema = z.object({
  reportId: z.string(),
  agentId: z.string(),
  agentVersion: z.string(),
  timestamp: z.number(),
  uptime: z.number(),
  errorType: z.enum(['protocol', 'transport', 'state', 'timeout', 'internal', 'crash']),
  errorCode: z.string(),
  errorMessage: z.string().max(5000),
  stackTrace: z.string().max(10000).optional(),
  sessionId: z.string().optional(),
  remoteAgent: z.string().optional(),
  protocolVersion: z.string().optional(),
  lastActions: z.array(ActionRecordSchema).max(10).optional(),
  state: StateSnapshotSchema.optional(),
  environment: EnvironmentSchema.optional(),
  sanitized: z.boolean().optional(),
});

export type BugReport = z.infer<typeof BugReportSchema>;
export type ActionRecord = z.infer<typeof ActionRecordSchema>;

// ============================================================================
// Redaction Rules
// ============================================================================

const REDACT_PATTERNS = [
  // API keys, tokens
  /(?:api[_-]?key|token|secret|password|auth|bearer)[=:\s]["']?[\w\-\.]+/gi,
  // Private keys
  /-----BEGIN[\w\s]+PRIVATE KEY-----[\s\S]*?-----END[\w\s]+PRIVATE KEY-----/g,
  // URLs with credentials
  /https?:\/\/[^:]+:[^@]+@/g,
  // Environment variables with sensitive names
  /(?:DATABASE_URL|REDIS_URL|SECRET|PRIVATE)[=]\S+/g,
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of REDACT_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

export function sanitizeReport(report: BugReport): BugReport {
  return {
    ...report,
    errorMessage: redactSecrets(report.errorMessage),
    stackTrace: report.stackTrace ? redactSecrets(report.stackTrace) : undefined,
    sanitized: true,
  };
}

// ============================================================================
// Fingerprinting
// ============================================================================

export function computeFingerprint(report: BugReport): string {
  // Extract top of stack trace (first 3 lines or empty)
  const topStack = report.stackTrace
    ?.split('\n')
    .slice(0, 3)
    .join('\n') ?? '';

  // Create fingerprint from stable fields
  const data = [
    report.errorCode,
    report.remoteAgent ?? '',
    topStack,
    report.protocolVersion ?? '',
    report.errorType,
  ].join('|');

  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

// ============================================================================
// Response Schemas
// ============================================================================

export interface IngestResponse {
  ok: boolean;
  reportId: string;
  fingerprint: string;
  isNew: boolean;
}

export interface ReportSummary {
  fingerprint: string;
  errorCode: string;
  errorType: string;
  errorMessage: string;
  occurrences: number;
  firstSeen: number;
  lastSeen: number;
  agents: string[];
}

export interface ReportDetail extends BugReport {
  fingerprint: string;
  occurrences: number;
  firstSeen: number;
  lastSeen: number;
}

/**
 * Tests for Unified Bug Report Adapter
 */

import { 
  toUnifiedReport, 
  createUnifiedReport,
  type UnifiedBugReport,
} from './unified-adapter.js';
import type { BugReport } from '../core/types.js';

// ============================================================================
// Test Helpers
// ============================================================================

function makeBugReport(overrides: Partial<BugReport> = {}): BugReport {
  return {
    reportId: 'test-report-123',
    agentId: 'test-agent',
    agentVersion: '0.1.0',
    timestamp: Date.now(),
    uptime: 3600,
    errorType: 'connection',
    errorCode: 'CONN_REFUSED',
    errorMessage: 'Connection refused to agent://target.agent',
    stackTrace: 'Error: Connection refused\n    at connect (client.ts:42)',
    sessionId: 'session-456',
    lastActions: [
      { type: 'resolve', timestamp: Date.now() - 1000, durationMs: 150 },
      { type: 'connect', timestamp: Date.now() - 500, durationMs: 250 },
    ],
    state: {
      sessionCount: 5,
      queueDepth: 3,
      memoryUsageMB: 128,
      activeConnections: 2,
    },
    environment: {
      platform: 'linux',
      nodeVersion: 'v22.0.0',
      arch: 'x64',
    },
    sanitized: true,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, passed: true });
    console.log(`✅ ${name}`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, error });
    console.log(`❌ ${name}: ${error}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function assertEqual<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${expected}, got ${actual}`);
  }
}

// ============================================================================
// Run Tests
// ============================================================================

console.log('\n========== Unified Adapter Tests ==========\n');

test('toUnifiedReport - maps source correctly', () => {
  const report = toUnifiedReport(makeBugReport());
  assertEqual(report.source, 'agenium', 'source should be agenium');
});

test('toUnifiedReport - maps error_type from errorType', () => {
  const report = toUnifiedReport(makeBugReport({ errorType: 'connection' }));
  assertEqual(report.error_type, 'connection', 'error_type should map correctly');
});

test('toUnifiedReport - crash maps to critical severity', () => {
  const report = toUnifiedReport(makeBugReport({ errorType: 'crash' }));
  assertEqual(report.severity, 'critical', 'crash should be critical');
});

test('toUnifiedReport - timeout maps to medium severity', () => {
  const report = toUnifiedReport(makeBugReport({ errorType: 'timeout' }));
  assertEqual(report.severity, 'medium', 'timeout should be medium');
});

test('toUnifiedReport - high severity codes override', () => {
  const report = toUnifiedReport(makeBugReport({ 
    errorType: 'connection', 
    errorCode: 'HANDSHAKE_FAILED' 
  }));
  assertEqual(report.severity, 'critical', 'HANDSHAKE_FAILED should be critical');
});

test('toUnifiedReport - includes environment', () => {
  const report = toUnifiedReport(makeBugReport());
  assertEqual(report.environment.service, 'agenium-client', 'service correct');
  assertEqual(report.environment.platform, 'linux', 'platform correct');
  assertEqual(report.environment.node_version, 'v22.0.0', 'node_version correct');
});

test('toUnifiedReport - includes stack_trace', () => {
  const report = toUnifiedReport(makeBugReport());
  assert(report.stack_trace?.includes('at connect') === true, 'stack_trace included');
});

test('toUnifiedReport - includes optional trace_id', () => {
  const traceId = 'trace-123-456';
  const report = toUnifiedReport(makeBugReport(), { traceId });
  assertEqual(report.trace_id, traceId, 'trace_id included');
});

test('toUnifiedReport - includes optional agent_uri', () => {
  const report = toUnifiedReport(makeBugReport(), { 
    agentUri: 'agent://target.agent' 
  });
  assertEqual(report.agent_uri, 'agent://target.agent', 'agent_uri included');
});

test('toUnifiedReport - context includes state', () => {
  const report = toUnifiedReport(makeBugReport());
  const state = (report.context as any).state;
  assertEqual(state.sessions, 5, 'sessions in context');
  assertEqual(state.queue_depth, 3, 'queue_depth in context');
});

test('toUnifiedReport - context includes last_actions', () => {
  const report = toUnifiedReport(makeBugReport());
  const actions = (report.context as any).last_actions;
  assert(Array.isArray(actions), 'last_actions is array');
  assertEqual(actions.length, 2, 'has 2 actions');
  assertEqual(actions[0].type, 'resolve', 'first action type');
});

test('createUnifiedReport - generates report_id', () => {
  const report = createUnifiedReport('TEST_ERROR', 'Test message');
  assert(report.report_id.length > 0, 'has report_id');
});

test('createUnifiedReport - sets source to agenium', () => {
  const report = createUnifiedReport('TEST_ERROR', 'Test message');
  assertEqual(report.source, 'agenium', 'source is agenium');
});

test('createUnifiedReport - accepts all options', () => {
  const report = createUnifiedReport('TEST_ERROR', 'Test message', {
    errorType: 'handshake',
    severity: 'high',
    traceId: 'trace-789',
    sessionId: 'sess-999',
    agentUri: 'agent://test.agent',
    endpoint: 'https://example.com:8443',
    domain: 'test.agent',
    context: { custom: 'data' },
  });
  assertEqual(report.error_type, 'handshake', 'error_type set');
  assertEqual(report.severity, 'high', 'severity set');
  assertEqual(report.trace_id, 'trace-789', 'trace_id set');
  assertEqual(report.session_id, 'sess-999', 'session_id set');
  assertEqual(report.agent_uri, 'agent://test.agent', 'agent_uri set');
  assertEqual((report.context as any).custom, 'data', 'context set');
});

// ============================================================================
// Summary
// ============================================================================

console.log('\n========== Summary ==========');
const passed = results.filter(r => r.passed).length;
const failed = results.filter(r => !r.passed).length;
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total:  ${results.length}`);

if (failed > 0) {
  console.log('\nFailed tests:');
  for (const r of results.filter(r => !r.passed)) {
    console.log(`  - ${r.name}: ${r.error}`);
  }
  process.exit(1);
}

console.log('\n✅ All adapter tests passed!\n');

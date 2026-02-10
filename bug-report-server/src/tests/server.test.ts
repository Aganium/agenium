/**
 * Bug Report Server - Tests
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { BugReportServer } from '../server.js';
import { BugReportDB } from '../db.js';
import { computeFingerprint, sanitizeReport, redactSecrets, BugReport } from '../schema.js';

// ============================================================================
// Test Data
// ============================================================================

const TEST_TOKEN = 'test-token-12345';

function makeBugReport(overrides: Partial<BugReport> = {}): BugReport {
  return {
    reportId: `report-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    agentId: 'test-agent-1',
    agentVersion: '1.0.0',
    timestamp: Date.now(),
    uptime: 3600,
    errorType: 'protocol',
    errorCode: 'HANDSHAKE_FAILED',
    errorMessage: 'Connection refused by remote agent',
    stackTrace: 'Error: Connection refused\n    at connect (/app/transport.ts:42:5)\n    at dial (/app/agent.ts:100:3)',
    remoteAgent: 'remote-agent-1',
    protocolVersion: '1.0.0',
    ...overrides,
  };
}

// ============================================================================
// Schema Tests
// ============================================================================

describe('Schema', () => {
  it('should compute consistent fingerprints', () => {
    const report = makeBugReport();
    const fp1 = computeFingerprint(report);
    const fp2 = computeFingerprint(report);
    assert.strictEqual(fp1, fp2, 'Fingerprints should be consistent');
    assert.strictEqual(fp1.length, 16, 'Fingerprint should be 16 chars');
  });

  it('should compute different fingerprints for different errors', () => {
    const report1 = makeBugReport({ errorCode: 'ERROR_A' });
    const report2 = makeBugReport({ errorCode: 'ERROR_B' });
    const fp1 = computeFingerprint(report1);
    const fp2 = computeFingerprint(report2);
    assert.notStrictEqual(fp1, fp2, 'Different errors should have different fingerprints');
  });

  it('should redact secrets from text', () => {
    const input = 'api_key=sk-12345 and token=abc123 found';
    const output = redactSecrets(input);
    assert.ok(!output.includes('sk-12345'), 'API key should be redacted');
    assert.ok(!output.includes('abc123'), 'Token should be redacted');
    assert.ok(output.includes('[REDACTED]'), 'Should contain [REDACTED]');
  });

  it('should sanitize reports', () => {
    const report = makeBugReport({
      errorMessage: 'Failed with api_key=secret123',
      stackTrace: 'Error at password=hunter2',
    });
    const sanitized = sanitizeReport(report);
    assert.ok(!sanitized.errorMessage.includes('secret123'));
    assert.ok(!sanitized.stackTrace?.includes('hunter2'));
    assert.strictEqual(sanitized.sanitized, true);
  });
});

// ============================================================================
// Database Tests
// ============================================================================

describe('Database', () => {
  let db: BugReportDB;

  before(() => {
    db = new BugReportDB(':memory:');
  });

  after(() => {
    db.close();
  });

  it('should ingest a new report', () => {
    const report = makeBugReport();
    const result = db.ingest(report);
    assert.strictEqual(result.isNew, true);
    assert.strictEqual(result.occurrences, 1);
    assert.ok(result.fingerprint.length === 16);
  });

  it('should deduplicate identical reports', () => {
    const report = makeBugReport({ errorCode: 'DEDUP_TEST' });
    const r1 = db.ingest(report);
    const r2 = db.ingest({ ...report, reportId: 'new-id' });
    const r3 = db.ingest({ ...report, reportId: 'another-id' });

    assert.strictEqual(r1.isNew, true);
    assert.strictEqual(r2.isNew, false);
    assert.strictEqual(r3.isNew, false);
    assert.strictEqual(r1.fingerprint, r2.fingerprint);
    assert.strictEqual(r3.occurrences, 3);
  });

  it('should track multiple agents', () => {
    const errorCode = 'MULTI_AGENT_TEST';
    db.ingest(makeBugReport({ errorCode, agentId: 'agent-1' }));
    db.ingest(makeBugReport({ errorCode, agentId: 'agent-2' }));
    db.ingest(makeBugReport({ errorCode, agentId: 'agent-3' }));

    const reports = db.getRecent(100);
    const report = reports.find(r => r.errorCode === errorCode);
    assert.ok(report);
    assert.deepStrictEqual(report.agents.sort(), ['agent-1', 'agent-2', 'agent-3']);
  });

  it('should get recent reports', () => {
    const reports = db.getRecent(10);
    assert.ok(Array.isArray(reports));
    assert.ok(reports.length > 0);
  });

  it('should get top reports', () => {
    const top = db.getTop(24 * 60 * 60 * 1000, 10);
    assert.ok(Array.isArray(top));
  });

  it('should get report by id', () => {
    const report = makeBugReport({ errorCode: 'GET_BY_ID_TEST' });
    const { fingerprint } = db.ingest(report);
    
    const found = db.getById(fingerprint);
    assert.ok(found);
    assert.strictEqual(found.errorCode, 'GET_BY_ID_TEST');
  });

  it('should return stats', () => {
    const stats = db.getStats();
    assert.ok(stats.totalReports > 0);
    assert.ok(stats.uniqueFingerprints > 0);
  });
});

// ============================================================================
// Server Integration Tests
// ============================================================================

describe('Server', () => {
  let server: BugReportServer;
  const port = 3199; // Test port

  before(async () => {
    server = new BugReportServer({
      port,
      dbPath: ':memory:',
      authToken: TEST_TOKEN,
    });
    await server.start();
  });

  after(async () => {
    await server.stop();
  });

  async function request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; data: unknown }> {
    const res = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_TOKEN}`,
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    return { status: res.status, data };
  }

  it('should respond to health check', async () => {
    const { status, data } = await request('GET', '/health', undefined, {});
    assert.strictEqual(status, 200);
    assert.strictEqual((data as { ok: boolean }).ok, true);
  });

  it('should reject unauthorized requests', async () => {
    const res = await fetch(`http://localhost:${port}/api/bug-reports/recent`);
    assert.strictEqual(res.status, 401);
  });

  it('should ingest a bug report', async () => {
    const report = makeBugReport();
    const { status, data } = await request('POST', '/api/bug-reports', report);
    assert.strictEqual(status, 200);
    assert.strictEqual((data as { ok: boolean }).ok, true);
    assert.ok((data as { fingerprint: string }).fingerprint);
  });

  it('should validate bug reports', async () => {
    const { status, data } = await request('POST', '/api/bug-reports', {
      invalid: 'data',
    });
    assert.strictEqual(status, 400);
    assert.strictEqual((data as { error: string }).error, 'Validation Error');
  });

  it('should get recent reports', async () => {
    const { status, data } = await request('GET', '/api/bug-reports/recent?limit=10');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data));
  });

  it('should get top reports', async () => {
    const { status, data } = await request('GET', '/api/bug-reports/top?window=24h');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data));
  });

  it('should require auth for stats', async () => {
    const res = await fetch(`http://localhost:${port}/api/stats`);
    assert.strictEqual(res.status, 401);
  });

  it('should get stats with auth', async () => {
    const res = await fetch(`http://localhost:${port}/api/stats`, {
      headers: { 'Authorization': `Bearer ${TEST_TOKEN}` },
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json() as { totalReports: number };
    assert.ok(data.totalReports !== undefined);
  });
});

// ============================================================================
// Metrics Tests
// ============================================================================

describe('Metrics', () => {
  let server: BugReportServer;
  const port = 3198; // Different test port

  before(async () => {
    server = new BugReportServer({
      port,
      dbPath: ':memory:',
      authToken: TEST_TOKEN,
    });
    await server.start();
  });

  after(async () => {
    await server.stop();
  });

  it('should expose /metrics endpoint', async () => {
    const res = await fetch(`http://localhost:${port}/metrics`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('text/plain'));
    
    const text = await res.text();
    assert.ok(text.includes('bug_reports_ingested_total'));
    assert.ok(text.includes('bug_reports_dedup_total'));
    assert.ok(text.includes('bug_reports_server_uptime_seconds'));
  });

  it('should track ingestion metrics', async () => {
    // Ingest a report
    const report = makeBugReport({ errorCode: 'METRICS_TEST' });
    await fetch(`http://localhost:${port}/api/bug-reports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify(report),
    });

    // Check metrics
    const res = await fetch(`http://localhost:${port}/metrics`);
    const text = await res.text();
    
    // Should have at least 1 ingested
    assert.ok(text.includes('bug_reports_ingested_total'));
  });

  it('should require auth for /api/stats', async () => {
    const res = await fetch(`http://localhost:${port}/api/stats`);
    assert.strictEqual(res.status, 401);
  });

  it('should return stats with auth', async () => {
    const res = await fetch(`http://localhost:${port}/api/stats`, {
      headers: { 'Authorization': `Bearer ${TEST_TOKEN}` },
    });
    assert.strictEqual(res.status, 200);
  });

  it('should include uptime in /health', async () => {
    const res = await fetch(`http://localhost:${port}/health`);
    const health = await res.json() as { uptime: number; stats: unknown };
    assert.ok(health.uptime >= 0);
    assert.ok(health.stats !== undefined);
  });
});

console.log('All tests passed! ✅');

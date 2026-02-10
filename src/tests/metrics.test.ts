/**
 * Metrics Tests
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { metrics, getHealth, getMetricsText, MetricsServer } from '../index.js';

describe('Metrics', () => {
  describe('Counters', () => {
    it('should increment counters', () => {
      const initial = metrics.sessionsCreatedTotal.get();
      metrics.sessionsCreatedTotal.inc();
      assert.strictEqual(metrics.sessionsCreatedTotal.get(), initial + 1);
    });

    it('should track labeled counters', () => {
      metrics.dnsLookupTotal.inc({ result: 'success' });
      metrics.dnsLookupTotal.inc({ result: 'success' });
      metrics.dnsLookupTotal.inc({ result: 'failure' });
      
      assert.strictEqual(metrics.dnsLookupTotal.get({ result: 'success' }), 2);
      assert.strictEqual(metrics.dnsLookupTotal.get({ result: 'failure' }), 1);
    });
  });

  describe('Gauges', () => {
    it('should set gauge values', () => {
      metrics.sessionsActive.set(5);
      assert.strictEqual(metrics.sessionsActive.get(), 5);
      
      metrics.sessionsActive.inc();
      assert.strictEqual(metrics.sessionsActive.get(), 6);
      
      metrics.sessionsActive.dec(3);
      assert.strictEqual(metrics.sessionsActive.get(), 3);
    });
  });

  describe('Health', () => {
    it('should return health status', () => {
      const health = getHealth('1.0.0');
      
      assert.strictEqual(health.ok, true);
      assert.strictEqual(health.version, '1.0.0');
      assert.ok(health.uptime >= 0);
      assert.ok(health.timestamp > 0);
      assert.ok(health.sessions !== undefined);
      assert.ok(health.outbox !== undefined);
      assert.ok(health.dnsCache !== undefined);
      assert.ok(health.bugReporter !== undefined);
    });
  });

  describe('Prometheus Export', () => {
    it('should export metrics in Prometheus format', () => {
      const text = getMetricsText();
      
      assert.ok(text.includes('# HELP'));
      assert.ok(text.includes('# TYPE'));
      assert.ok(text.includes('agenium_sessions_active'));
      assert.ok(text.includes('agenium_uptime_seconds'));
      assert.ok(text.includes('counter') || text.includes('gauge'));
    });
  });
});

describe('MetricsServer', () => {
  let server: MetricsServer;
  const port = 9199; // Test port

  before(async () => {
    server = new MetricsServer({ port, version: '1.0.0-test' });
    await server.start();
  });

  after(async () => {
    await server.stop();
  });

  it('should respond to /health', async () => {
    const res = await fetch(`http://localhost:${port}/health`);
    assert.strictEqual(res.status, 200);
    
    const health = await res.json() as { ok: boolean; version: string };
    assert.strictEqual(health.ok, true);
    assert.strictEqual(health.version, '1.0.0-test');
  });

  it('should respond to /metrics', async () => {
    const res = await fetch(`http://localhost:${port}/metrics`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('text/plain'));
    
    const text = await res.text();
    assert.ok(text.includes('agenium_uptime_seconds'));
  });

  it('should respond to /', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    assert.strictEqual(res.status, 200);
    
    const html = await res.text();
    assert.ok(html.includes('Agenium Metrics'));
  });

  it('should return 404 for unknown paths', async () => {
    const res = await fetch(`http://localhost:${port}/unknown`);
    assert.strictEqual(res.status, 404);
  });
});

console.log('Metrics tests passed! ✅');

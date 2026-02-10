#!/usr/bin/env npx tsx
/**
 * Phase 8 Demo: Health Checks + Metrics
 * 
 * Demonstrates:
 * 1. Bug Report Server /metrics endpoint
 * 2. Agenium Metrics Server /health and /metrics
 * 3. Counter increments on errors
 */

import { spawn, ChildProcess } from 'node:child_process';

const BUG_SERVER_PORT = 3100;
const METRICS_PORT = 9090;
const AUTH_TOKEN = 'dev-token-change-me';

let bugServerProc: ChildProcess | null = null;

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function startBugServer(): Promise<void> {
  console.log('🚀 Starting Bug Report Server...');
  bugServerProc = spawn('node', ['bug-report-server/dist/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(BUG_SERVER_PORT) },
    stdio: 'inherit',
  });
  await sleep(2000);
}

async function stopBugServer(): Promise<void> {
  if (bugServerProc) {
    bugServerProc.kill('SIGTERM');
    await sleep(500);
  }
}

async function sendBugReport(errorCode: string, agentId: string): Promise<void> {
  const report = {
    reportId: `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    agentId,
    agentVersion: '1.0.0',
    timestamp: Date.now(),
    uptime: 3600,
    errorType: 'protocol',
    errorCode,
    errorMessage: `Test error: ${errorCode}`,
    stackTrace: 'Error: test\n    at demo.ts:1:1',
    remoteAgent: 'target.agent',
    protocolVersion: '1.0.0',
  };

  const res = await fetch(`http://localhost:${BUG_SERVER_PORT}/api/bug-reports`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify(report),
  });

  const data = await res.json() as { ok: boolean; fingerprint: string };
  console.log(`   📤 Sent ${errorCode} from ${agentId} → fp=${data.fingerprint?.slice(0, 8)}...`);
}

async function getMetrics(port: number, name: string): Promise<string> {
  const res = await fetch(`http://localhost:${port}/metrics`);
  return res.text();
}

async function getHealth(port: number): Promise<unknown> {
  const res = await fetch(`http://localhost:${port}/health`);
  return res.json();
}

function extractMetric(text: string, name: string): string | null {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith(name) && !line.startsWith('#')) {
      return line;
    }
  }
  return null;
}

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║     AGENIUM Phase 8: Health Checks + Metrics Demo         ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  try {
    await startBugServer();

    // === Step 1: Check initial metrics ===
    console.log('\n━━━ STEP 1: Initial Bug Server Metrics ━━━');
    let metrics = await getMetrics(BUG_SERVER_PORT, 'Bug Server');
    console.log('  bug_reports_ingested_total:', extractMetric(metrics, 'bug_reports_ingested_total'));
    console.log('  bug_reports_dedup_total:', extractMetric(metrics, 'bug_reports_dedup_total'));

    // === Step 2: Send 2 different errors ===
    console.log('\n━━━ STEP 2: Sending 2 Bug Reports ━━━');
    await sendBugReport('HANDSHAKE_FAILED', 'agent-alpha');
    await sendBugReport('TIMEOUT_ERROR', 'agent-beta');

    // === Step 3: Check metrics after ===
    console.log('\n━━━ STEP 3: Metrics After Ingestion ━━━');
    metrics = await getMetrics(BUG_SERVER_PORT, 'Bug Server');
    console.log('  bug_reports_ingested_total:', extractMetric(metrics, 'bug_reports_ingested_total'));
    console.log('  bug_reports_dedup_total:', extractMetric(metrics, 'bug_reports_dedup_total'));

    // === Step 4: Send duplicate (same fingerprint) ===
    console.log('\n━━━ STEP 4: Sending Duplicate (should increment dedup) ━━━');
    await sendBugReport('HANDSHAKE_FAILED', 'agent-gamma'); // Same error code = same fingerprint

    // === Step 5: Final metrics ===
    console.log('\n━━━ STEP 5: Final Metrics ━━━');
    metrics = await getMetrics(BUG_SERVER_PORT, 'Bug Server');
    console.log('  bug_reports_ingested_total:', extractMetric(metrics, 'bug_reports_ingested_total'));
    console.log('  bug_reports_dedup_total:', extractMetric(metrics, 'bug_reports_dedup_total'));
    console.log('  bug_reports_server_uptime_seconds:', extractMetric(metrics, 'bug_reports_server_uptime_seconds'));

    // === Step 6: Health check ===
    console.log('\n━━━ STEP 6: Health Check ━━━');
    const health = await getHealth(BUG_SERVER_PORT) as { ok: boolean; uptime: number; stats: unknown };
    console.log('  Health:', JSON.stringify(health, null, 2));

    // === Full metrics output ===
    console.log('\n━━━ FULL PROMETHEUS METRICS OUTPUT ━━━');
    console.log(metrics);

    console.log('\n✅ Demo complete!');
  } finally {
    await stopBugServer();
  }
}

main().catch(err => {
  console.error('Demo failed:', err);
  stopBugServer();
  process.exit(1);
});

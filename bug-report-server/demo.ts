#!/usr/bin/env npx tsx
/**
 * Demo: Trigger bug reports from Agenium to Bug Report Server
 * 
 * Usage:
 *   1. Start the server: npm start
 *   2. Run demo: npx tsx demo.ts
 */

const SERVER_URL = process.env.BUG_REPORT_URL ?? 'http://localhost:3100/api/bug-reports';
const AUTH_TOKEN = process.env.BUG_REPORT_TOKEN ?? 'dev-token-change-me';

interface BugReport {
  reportId: string;
  agentId: string;
  agentVersion: string;
  timestamp: number;
  uptime: number;
  errorType: 'protocol' | 'transport' | 'state' | 'timeout' | 'internal' | 'crash';
  errorCode: string;
  errorMessage: string;
  stackTrace?: string;
  remoteAgent?: string;
  protocolVersion?: string;
  state?: {
    sessionCount: number;
    queueDepth: number;
    memoryUsageMB: number;
    activeConnections: number;
  };
  environment?: {
    platform: string;
    nodeVersion: string;
    arch: string;
  };
}

function makeReport(overrides: Partial<BugReport> = {}): BugReport {
  return {
    reportId: `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    agentId: 'demo-agent-1',
    agentVersion: '1.0.0',
    timestamp: Date.now(),
    uptime: 3600,
    errorType: 'protocol',
    errorCode: 'HANDSHAKE_FAILED',
    errorMessage: 'Connection refused by remote agent',
    stackTrace: `Error: Connection refused
    at TLSSocket.connect (/app/src/transport/client.ts:42:15)
    at Agent.dial (/app/src/agent.ts:100:23)
    at main (/app/demo.ts:50:5)`,
    remoteAgent: 'target-agent.example',
    protocolVersion: '1.0.0',
    state: {
      sessionCount: 5,
      queueDepth: 2,
      memoryUsageMB: 128,
      activeConnections: 3,
    },
    environment: {
      platform: 'linux',
      nodeVersion: 'v20.10.0',
      arch: 'x64',
    },
    ...overrides,
  };
}

async function sendReport(report: BugReport): Promise<void> {
  console.log(`📤 Sending: ${report.errorCode} from ${report.agentId}`);
  
  const res = await fetch(SERVER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AUTH_TOKEN}`,
      'X-Agent-Id': report.agentId,
    },
    body: JSON.stringify(report),
  });

  const data = await res.json() as { ok: boolean; fingerprint: string; isNew: boolean };
  
  if (data.ok) {
    console.log(`   ✅ Accepted: fp=${data.fingerprint}, new=${data.isNew}`);
  } else {
    console.log(`   ❌ Rejected:`, data);
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║    AGENIUM Bug Report Demo                 ║');
  console.log('╚════════════════════════════════════════════╝\n');
  console.log(`Server: ${SERVER_URL}\n`);

  // === Error 1: Handshake failure (new) ===
  console.log('--- Error 1: Handshake Failure ---');
  await sendReport(makeReport({
    errorCode: 'HANDSHAKE_FAILED',
    errorMessage: 'TLS handshake timeout after 5000ms',
    remoteAgent: 'slow-agent.network',
  }));

  // === Error 2: Same error from different agent (dedupe) ===
  console.log('\n--- Error 2: Same error, different agent (should dedupe) ---');
  await sendReport(makeReport({
    agentId: 'demo-agent-2',
    errorCode: 'HANDSHAKE_FAILED',
    errorMessage: 'TLS handshake timeout after 5000ms',
    remoteAgent: 'slow-agent.network',
  }));

  // === Error 3: Protocol error ===
  console.log('\n--- Error 3: Protocol Error ---');
  await sendReport(makeReport({
    errorType: 'protocol',
    errorCode: 'INVALID_MESSAGE_FORMAT',
    errorMessage: 'Expected REQUEST but got malformed JSON',
    stackTrace: `SyntaxError: Unexpected token '<' at position 0
    at JSON.parse (<anonymous>)
    at MessageDispatcher.handleIncoming (/app/src/protocol/dispatcher.ts:88:22)`,
    remoteAgent: 'buggy-agent.local',
  }));

  // === Error 4: Crash (same fingerprint as #3 duplicate) ===
  console.log('\n--- Error 4: Same protocol error again (should increment count) ---');
  await sendReport(makeReport({
    agentId: 'demo-agent-3',
    errorType: 'protocol',
    errorCode: 'INVALID_MESSAGE_FORMAT',
    errorMessage: 'Expected REQUEST but got malformed JSON',
    stackTrace: `SyntaxError: Unexpected token '<' at position 0
    at JSON.parse (<anonymous>)
    at MessageDispatcher.handleIncoming (/app/src/protocol/dispatcher.ts:88:22)`,
    remoteAgent: 'buggy-agent.local',
  }));

  // === Query results ===
  console.log('\n\n════════════════════════════════════════════');
  console.log('📊 Querying results...\n');

  // Recent
  console.log('--- GET /api/bug-reports/recent?limit=10 ---');
  const recentRes = await fetch(`http://localhost:3100/api/bug-reports/recent?limit=10`, {
    headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` },
  });
  const recent = await recentRes.json() as Array<{ fingerprint: string; errorCode: string; occurrences: number }>;
  console.table(recent.map(r => ({
    fingerprint: r.fingerprint.slice(0, 8) + '...',
    errorCode: r.errorCode,
    occurrences: r.occurrences,
  })));

  // Top
  console.log('\n--- GET /api/bug-reports/top?window=24h ---');
  const topRes = await fetch(`http://localhost:3100/api/bug-reports/top?window=24h`, {
    headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` },
  });
  const top = await topRes.json() as Array<{ fingerprint: string; errorCode: string; occurrences: number; agents: string[] }>;
  console.table(top.map(r => ({
    fingerprint: r.fingerprint.slice(0, 8) + '...',
    errorCode: r.errorCode,
    occurrences: r.occurrences,
    agents: r.agents.join(', '),
  })));

  // Stats
  console.log('\n--- GET /api/stats ---');
  const statsRes = await fetch(`http://localhost:3100/api/stats`);
  const stats = await statsRes.json();
  console.log(stats);

  console.log('\n✅ Demo complete!');
}

main().catch(console.error);

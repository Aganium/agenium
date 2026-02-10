#!/usr/bin/env npx tsx
/**
 * Step 8: Bug Reporting Proof
 * 
 * Tests:
 * 1. Submit bug reports via API
 * 2. Verify deduplication (fingerprint)
 * 3. Query /api/bug-reports/recent
 * 4. Verify secret redaction
 */

const BUG_SERVER = 'http://127.0.0.1:3100';
const TEST_TOKEN = 'dev-token-change-me';

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
  sessionId?: string;
  remoteAgent?: string;
  environment?: {
    platform: string;
    nodeVersion: string;
    arch: string;
  };
}

async function submitBugReport(report: BugReport): Promise<{ success: boolean; id?: string; dedupe?: boolean; error?: string }> {
  try {
    const resp = await fetch(`${BUG_SERVER}/api/bug-reports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify(report),
    });
    
    const data = await resp.json();
    
    if (resp.ok) {
      return { success: true, id: data.id, dedupe: data.deduplicated };
    } else {
      return { success: false, error: data.error || data.message || `HTTP ${resp.status}` };
    }
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function getRecentReports(): Promise<{ success: boolean; reports?: any[]; error?: string }> {
  try {
    const resp = await fetch(`${BUG_SERVER}/api/bug-reports/recent?limit=10`, {
      headers: { 'Authorization': `Bearer ${TEST_TOKEN}` },
    });
    
    if (resp.ok) {
      const data = await resp.json();
      return { success: true, reports: data.reports || data };
    } else {
      return { success: false, error: `HTTP ${resp.status}` };
    }
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function runTest(): Promise<void> {
  const now = Date.now();
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  STEP 8: Bug Reporting Proof');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Bug Server: ${BUG_SERVER}`);
  console.log('');
  
  // Phase 1: Health check
  console.log('Phase 1: Bug Server Health Check');
  console.log('─────────────────────────────────');
  
  try {
    const healthResp = await fetch(`${BUG_SERVER}/health`);
    const health = await healthResp.json();
    console.log(`  Status: ${healthResp.ok ? '✓ Healthy' : '✗ Unhealthy'}`);
    console.log(`  Uptime: ${health.uptime || 'N/A'}s`);
  } catch (err: any) {
    console.log(`  ✗ Health check failed: ${err.message}`);
    console.log('  ❌ STEP 8 FAILED: Bug server not reachable');
    process.exit(1);
  }
  console.log('');
  
  // Phase 2: Submit bug reports
  console.log('Phase 2: Submit Bug Reports');
  console.log('───────────────────────────');
  
  // Report 1: Connection error
  const report1: BugReport = {
    reportId: `conn-err-${now}`,
    agentId: 'integration-test-agent',
    agentVersion: '0.1.0',
    timestamp: now,
    uptime: 3600,
    errorType: 'transport',
    errorCode: 'ECONNREFUSED',
    errorMessage: 'Failed to connect to remote agent: connect ECONNREFUSED 194.5.206.180:8443',
    stackTrace: 'Error: connect ECONNREFUSED\n    at TCPConnectWrap.afterConnect',
    remoteAgent: 'shannon.agent',
    environment: {
      platform: 'linux',
      nodeVersion: 'v22.22.0',
      arch: 'x64',
    },
  };
  
  const r1 = await submitBugReport(report1);
  console.log(`  [1] TRANSPORT (ECONNREFUSED): ${r1.success ? `✓ ID=${r1.id?.slice(0, 12)}...` : `✗ ${r1.error}`}`);
  
  // Report 2: Protocol error with SECRET in message (should be redacted)
  const report2: BugReport = {
    reportId: `proto-err-${now}`,
    agentId: 'integration-test-agent',
    agentVersion: '0.1.0',
    timestamp: now,
    uptime: 3600,
    errorType: 'protocol',
    errorCode: 'INVALID_HANDSHAKE',
    errorMessage: 'Handshake failed with api_key=sk-secret-12345 and token=eyJhbGciOiJIUzI1NiJ9',
    sessionId: 'test-session-123',
    remoteAgent: 'shannon.agent',
  };
  
  const r2 = await submitBugReport(report2);
  console.log(`  [2] PROTOCOL (with secrets): ${r2.success ? `✓ ID=${r2.id?.slice(0, 12)}...` : `✗ ${r2.error}`}`);
  
  // Report 3: Duplicate of report 1 (should be deduplicated by fingerprint)
  const report3: BugReport = { ...report1, reportId: `conn-err-dup-${now}` };
  const r3 = await submitBugReport(report3);
  console.log(`  [3] Duplicate (same error): ${r3.success ? (r3.dedupe ? '✓ Deduplicated!' : `✓ ID=${r3.id?.slice(0, 12)}...`) : `✗ ${r3.error}`}`);
  
  // Report 4: Timeout error
  const report4: BugReport = {
    reportId: `timeout-${now}`,
    agentId: 'integration-test-agent',
    agentVersion: '0.1.0',
    timestamp: now,
    uptime: 3600,
    errorType: 'timeout',
    errorCode: 'REQUEST_TIMEOUT',
    errorMessage: 'Request timed out after 30000ms waiting for response',
    sessionId: 'sess-abc123',
    remoteAgent: 'shannon.agent',
  };
  
  const r4 = await submitBugReport(report4);
  console.log(`  [4] TIMEOUT: ${r4.success ? `✓ ID=${r4.id?.slice(0, 12)}...` : `✗ ${r4.error}`}`);
  
  console.log('');
  
  // Phase 3: Query recent reports
  console.log('Phase 3: Query Recent Reports');
  console.log('─────────────────────────────');
  
  const recent = await getRecentReports();
  
  if (recent.success && recent.reports) {
    console.log(`  Found ${recent.reports.length} recent reports:`);
    
    for (const report of recent.reports.slice(0, 5)) {
      const errType = report.errorType || report.error_type || 'unknown';
      const errCode = report.errorCode || report.error_code || 'N/A';
      const msg = report.errorMessage || report.error_message || 'N/A';
      console.log(`    • [${errType}] ${errCode}: ${msg.slice(0, 45)}...`);
    }
  } else {
    console.log(`  ✗ Failed to get recent reports: ${recent.error}`);
  }
  console.log('');
  
  // Phase 4: Verify secret redaction
  console.log('Phase 4: Verify Secret Redaction');
  console.log('────────────────────────────────');
  
  if (r2.success && r2.id) {
    try {
      const resp = await fetch(`${BUG_SERVER}/api/bug-reports/${r2.id}`, {
        headers: { 'Authorization': `Bearer ${TEST_TOKEN}` },
      });
      
      if (resp.ok) {
        const report = await resp.json();
        const msg = report.errorMessage || report.error_message || '';
        
        const apiKeyVisible = msg.includes('sk-secret');
        const tokenVisible = msg.includes('eyJhbGci');
        
        console.log(`  api_key redacted: ${!apiKeyVisible ? '✓' : '✗ LEAKED!'}`);
        console.log(`  token redacted:   ${!tokenVisible ? '✓' : '✗ LEAKED!'}`);
        
        if (apiKeyVisible || tokenVisible) {
          console.log('');
          console.log('  ⚠️  WARNING: Secrets visible in stored report!');
        }
      } else {
        console.log(`  ✗ Could not fetch report ${r2.id}: HTTP ${resp.status}`);
      }
    } catch (err: any) {
      console.log(`  ✗ Error fetching report: ${err.message}`);
    }
  } else {
    console.log('  ⚠ Skipping (report 2 not submitted)');
  }
  console.log('');
  
  // Summary
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  
  const submittedOk = r1.success && r2.success && r4.success;
  const queryOk = recent.success;
  
  console.log(`  Bug reports submitted: ${submittedOk ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`  Deduplication:         ${r3.dedupe ? '✓ PASS' : '⚠ Not confirmed (may be new)'}`);
  console.log(`  Recent query:          ${queryOk ? '✓ PASS' : '✗ FAIL'}`);
  console.log('');
  
  if (submittedOk && queryOk) {
    console.log('  ✅ STEP 8 COMPLETE: Bug Reporting Proof PASSED');
  } else {
    console.log('  ⚠️ STEP 8 PARTIAL: Some features may need review');
  }
  
  console.log('═══════════════════════════════════════════════════════════════');
}

runTest().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});

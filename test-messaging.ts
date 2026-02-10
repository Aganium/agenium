#!/usr/bin/env npx tsx
/**
 * Full Messaging Test - 10 REQUESTs + 10 EVENTs
 * Tests AGENIUM → Echo Agent message flow
 */

import * as https from 'node:https';
import * as http2 from 'node:http2';

const ECHO_AGENT_URL = 'https://194.5.206.180:8443';
const SESSION_ID = '48b3be4b-ca24-4507-93f5-918cfbb1d7fe';

interface TestResult {
  type: 'REQUEST' | 'EVENT';
  index: number;
  success: boolean;
  latencyMs: number;
  error?: string;
}

async function sendFrame(client: http2.ClientHttp2Session, frame: object): Promise<{ success: boolean; latencyMs: number; response?: any; error?: string }> {
  const start = Date.now();
  
  return new Promise((resolve) => {
    const req = client.request({
      ':method': 'POST',
      ':path': '/message',
      'content-type': 'application/json',
    });
    
    let data = '';
    
    req.on('response', (headers) => {
      const status = headers[':status'];
      if (status !== 200) {
        resolve({ success: false, latencyMs: Date.now() - start, error: `HTTP ${status}` });
      }
    });
    
    req.on('data', (chunk) => {
      data += chunk.toString();
    });
    
    req.on('end', () => {
      const latencyMs = Date.now() - start;
      try {
        const response = data ? JSON.parse(data) : null;
        resolve({ success: true, latencyMs, response });
      } catch (e) {
        resolve({ success: true, latencyMs });  // EVENT responses may be empty
      }
    });
    
    req.on('error', (err) => {
      resolve({ success: false, latencyMs: Date.now() - start, error: err.message });
    });
    
    req.write(JSON.stringify(frame));
    req.end();
  });
}

async function runTest(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  AGENIUM Integration Test: Full Messaging (10 REQ + 10 EVT)');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Target: ${ECHO_AGENT_URL}`);
  console.log(`Session: ${SESSION_ID}`);
  console.log('');
  
  // Connect with HTTP/2
  const client = http2.connect(ECHO_AGENT_URL, {
    rejectUnauthorized: false,  // Self-signed cert
  });
  
  await new Promise<void>((resolve, reject) => {
    client.on('connect', resolve);
    client.on('error', reject);
  });
  
  console.log('✓ HTTP/2 connection established\n');
  
  const results: TestResult[] = [];
  
  // Test 1: 10 REQUEST frames (echo method)
  console.log('Phase 1: Sending 10 REQUEST frames (echo method)');
  console.log('─────────────────────────────────────────────────');
  
  for (let i = 0; i < 10; i++) {
    const frame = {
      version: '1.0',
      messageId: `req-${Date.now()}-${i}`,
      type: 'REQUEST',
      sessionId: SESSION_ID,
      timestamp: Date.now(),
      payload: {
        method: 'echo',
        params: { message: `Hello from test #${i + 1}` },
      },
    };
    
    const result = await sendFrame(client, frame);
    
    if (result.success && result.response?.payload?.success) {
      console.log(`  [${i + 1}/10] ✓ ${result.latencyMs}ms - echo: "${result.response.payload.result.echo}"`);
      results.push({ type: 'REQUEST', index: i, success: true, latencyMs: result.latencyMs });
    } else {
      console.log(`  [${i + 1}/10] ✗ ${result.latencyMs}ms - ${result.error || 'Invalid response'}`);
      results.push({ type: 'REQUEST', index: i, success: false, latencyMs: result.latencyMs, error: result.error });
    }
  }
  
  console.log('');
  
  // Test 2: 10 EVENT frames (fire-and-forget)
  console.log('Phase 2: Sending 10 EVENT frames (fire-and-forget)');
  console.log('───────────────────────────────────────────────────');
  
  for (let i = 0; i < 10; i++) {
    const frame = {
      version: '1.0',
      messageId: `evt-${Date.now()}-${i}`,
      type: 'EVENT',
      sessionId: SESSION_ID,
      timestamp: Date.now(),
      payload: {
        event: 'test_event',
        data: { counter: i + 1, message: `Event #${i + 1}` },
      },
    };
    
    const result = await sendFrame(client, frame);
    
    // EVENTs just need HTTP 200 (no body expected)
    if (result.success) {
      console.log(`  [${i + 1}/10] ✓ ${result.latencyMs}ms - event delivered`);
      results.push({ type: 'EVENT', index: i, success: true, latencyMs: result.latencyMs });
    } else {
      console.log(`  [${i + 1}/10] ✗ ${result.latencyMs}ms - ${result.error}`);
      results.push({ type: 'EVENT', index: i, success: false, latencyMs: result.latencyMs, error: result.error });
    }
  }
  
  // Close connection
  client.close();
  
  // Summary
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  
  const requests = results.filter(r => r.type === 'REQUEST');
  const events = results.filter(r => r.type === 'EVENT');
  
  const reqSuccess = requests.filter(r => r.success).length;
  const evtSuccess = events.filter(r => r.success).length;
  
  const avgReqLatency = requests.length > 0 
    ? Math.round(requests.reduce((sum, r) => sum + r.latencyMs, 0) / requests.length)
    : 0;
  const avgEvtLatency = events.length > 0
    ? Math.round(events.reduce((sum, r) => sum + r.latencyMs, 0) / events.length)
    : 0;
  
  console.log(`  REQUESTs: ${reqSuccess}/10 passed (avg ${avgReqLatency}ms)`);
  console.log(`  EVENTs:   ${evtSuccess}/10 passed (avg ${avgEvtLatency}ms)`);
  console.log('');
  
  const allPassed = reqSuccess === 10 && evtSuccess === 10;
  
  if (allPassed) {
    console.log('  ✅ STEP 6 COMPLETE: Full messaging validation PASSED');
  } else {
    console.log('  ❌ STEP 6 FAILED: Some messages failed');
    process.exit(1);
  }
  
  console.log('═══════════════════════════════════════════════════════════════');
}

runTest().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});

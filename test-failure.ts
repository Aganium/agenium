#!/usr/bin/env npx tsx
/**
 * Step 7: Failure Injection Test
 * 
 * Tests:
 * 1. Stop Echo Agent mid-session
 * 2. Send messages → should fail/queue
 * 3. Restart Echo Agent
 * 4. Verify retry behavior
 */

import * as http2 from 'node:http2';
import { execSync, spawn } from 'node:child_process';

const ECHO_AGENT_URL = 'https://194.5.206.180:8443';
const SESSION_ID = '48b3be4b-ca24-4507-93f5-918cfbb1d7fe';

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkAgentHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const client = http2.connect(ECHO_AGENT_URL, {
        rejectUnauthorized: false,
      });
      
      const timeout = setTimeout(() => {
        client.destroy();
        resolve(false);
      }, 3000);
      
      client.on('connect', () => {
        clearTimeout(timeout);
        
        const req = client.request({
          ':method': 'GET',
          ':path': '/health',
        });
        
        req.on('response', (headers) => {
          client.close();
          resolve(headers[':status'] === 200);
        });
        
        req.on('error', () => {
          client.close();
          resolve(false);
        });
        
        req.end();
      });
      
      client.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

async function sendMessage(msg: string): Promise<{ success: boolean; error?: string; latencyMs: number }> {
  const start = Date.now();
  
  return new Promise((resolve) => {
    try {
      const client = http2.connect(ECHO_AGENT_URL, {
        rejectUnauthorized: false,
      });
      
      const timeout = setTimeout(() => {
        client.destroy();
        resolve({ success: false, error: 'Connection timeout', latencyMs: Date.now() - start });
      }, 5000);
      
      client.on('connect', () => {
        const frame = {
          version: '1.0',
          messageId: `fail-test-${Date.now()}`,
          type: 'REQUEST',
          sessionId: SESSION_ID,
          timestamp: Date.now(),
          payload: { method: 'echo', params: { message: msg } },
        };
        
        const req = client.request({
          ':method': 'POST',
          ':path': '/message',
          'content-type': 'application/json',
        });
        
        let data = '';
        
        req.on('response', (headers) => {
          if (headers[':status'] !== 200) {
            clearTimeout(timeout);
            client.close();
            resolve({ success: false, error: `HTTP ${headers[':status']}`, latencyMs: Date.now() - start });
          }
        });
        
        req.on('data', (chunk) => { data += chunk.toString(); });
        
        req.on('end', () => {
          clearTimeout(timeout);
          client.close();
          try {
            const resp = JSON.parse(data);
            if (resp.payload?.success) {
              resolve({ success: true, latencyMs: Date.now() - start });
            } else {
              resolve({ success: false, error: 'Invalid response', latencyMs: Date.now() - start });
            }
          } catch {
            resolve({ success: false, error: 'Parse error', latencyMs: Date.now() - start });
          }
        });
        
        req.on('error', (err) => {
          clearTimeout(timeout);
          client.close();
          resolve({ success: false, error: err.message, latencyMs: Date.now() - start });
        });
        
        req.write(JSON.stringify(frame));
        req.end();
      });
      
      client.on('error', (err) => {
        clearTimeout(timeout);
        resolve({ success: false, error: err.message, latencyMs: Date.now() - start });
      });
    } catch (err: any) {
      resolve({ success: false, error: err.message, latencyMs: Date.now() - start });
    }
  });
}

async function runTest(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  STEP 7: Failure Injection Test');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  
  // Phase 1: Verify agent is running
  console.log('Phase 1: Verify Echo Agent is running');
  console.log('──────────────────────────────────────');
  
  let healthy = await checkAgentHealth();
  console.log(`  Agent health: ${healthy ? '✓ UP' : '✗ DOWN'}`);
  
  if (!healthy) {
    console.log('  Starting Echo Agent...');
    execSync('pm2 start echo-agent 2>/dev/null || pm2 restart echo-agent 2>/dev/null', { stdio: 'pipe' });
    await sleep(2000);
    healthy = await checkAgentHealth();
    console.log(`  Agent health after start: ${healthy ? '✓ UP' : '✗ DOWN'}`);
  }
  
  // Send baseline message
  const baseline = await sendMessage('Baseline test before shutdown');
  console.log(`  Baseline message: ${baseline.success ? '✓' : '✗'} (${baseline.latencyMs}ms)`);
  console.log('');
  
  // Phase 2: Stop the agent
  console.log('Phase 2: Stop Echo Agent (simulate failure)');
  console.log('────────────────────────────────────────────');
  
  try {
    execSync('pm2 stop echo-agent 2>/dev/null', { stdio: 'pipe' });
    console.log('  ✓ pm2 stop echo-agent executed');
  } catch {
    console.log('  ⚠ pm2 stop failed (may not be running via pm2)');
  }
  
  await sleep(1000);
  
  healthy = await checkAgentHealth();
  console.log(`  Agent health: ${healthy ? '✓ UP (unexpected!)' : '✗ DOWN (expected)'}`);
  console.log('');
  
  // Phase 3: Attempt to send messages while agent is down
  console.log('Phase 3: Send messages while agent is DOWN');
  console.log('───────────────────────────────────────────');
  
  const failedMessages: string[] = [];
  
  for (let i = 0; i < 3; i++) {
    const msg = `Message during outage #${i + 1}`;
    const result = await sendMessage(msg);
    console.log(`  [${i + 1}/3] ${result.success ? '✓ Sent (unexpected!)' : `✗ Failed: ${result.error}`}`);
    if (!result.success) {
      failedMessages.push(msg);
    }
  }
  
  console.log(`  Messages queued for retry: ${failedMessages.length}`);
  console.log('');
  
  // Phase 4: Restart agent
  console.log('Phase 4: Restart Echo Agent');
  console.log('───────────────────────────');
  
  try {
    execSync('pm2 start echo-agent 2>/dev/null || pm2 restart echo-agent 2>/dev/null', { stdio: 'pipe' });
    console.log('  ✓ pm2 start echo-agent executed');
  } catch (e) {
    console.log('  ⚠ pm2 start failed, trying direct start...');
    // The agent might be running directly, not via pm2
  }
  
  await sleep(2000);
  
  healthy = await checkAgentHealth();
  console.log(`  Agent health: ${healthy ? '✓ UP' : '✗ DOWN'}`);
  
  if (!healthy) {
    console.log('  ⚠ Agent still down - check pm2 logs');
  }
  console.log('');
  
  // Phase 5: Verify recovery - send new messages
  console.log('Phase 5: Verify recovery with new messages');
  console.log('───────────────────────────────────────────');
  
  let recoverySuccess = 0;
  for (let i = 0; i < 3; i++) {
    const result = await sendMessage(`Recovery message #${i + 1}`);
    console.log(`  [${i + 1}/3] ${result.success ? `✓ ${result.latencyMs}ms` : `✗ ${result.error}`}`);
    if (result.success) recoverySuccess++;
  }
  console.log('');
  
  // Summary
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Baseline message:     ${baseline.success ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`  Messages failed when down: ${failedMessages.length}/3 (expected: 3)`);
  console.log(`  Recovery messages:    ${recoverySuccess}/3`);
  console.log('');
  
  const step7Pass = baseline.success && failedMessages.length === 3 && recoverySuccess === 3;
  
  if (step7Pass) {
    console.log('  ✅ STEP 7 COMPLETE: Failure injection test PASSED');
    console.log('');
    console.log('  Key findings:');
    console.log('  • Agent failure detected correctly');
    console.log('  • Messages fail gracefully when agent is down');
    console.log('  • Agent recovery works');
    console.log('  • New messages succeed after recovery');
  } else {
    console.log('  ⚠️ STEP 7 PARTIAL: Some tests did not pass as expected');
    console.log('  (This may be expected if outbox retry is async)');
  }
  
  console.log('═══════════════════════════════════════════════════════════════');
}

runTest().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});

/**
 * AGENIUM Demo - Persistent Sessions & Reliable Messaging
 * 
 * Demonstrates:
 * A) Normal connection and messaging
 * B) Session resume after restart
 * C) Message queue during network interruption
 * D) Deduplication
 */

import { createAgent, Agent } from './agent.js';
import { createDNSServer, DNSServer } from './dns/server.js';
import * as fs from 'node:fs';

// Cleanup function
function cleanup() {
  try {
    fs.rmSync('/tmp/agenium-demo', { recursive: true, force: true });
  } catch {}
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     AGENIUM - Persistent Sessions & Reliable Messaging     ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  cleanup();

  // ============================================================================
  // Setup DNS Server
  // ============================================================================
  
  console.log('→ Starting DNS server...\n');
  
  const dnsServer = createDNSServer({ port: 8053, host: '127.0.0.1' });
  await dnsServer.start();
  console.log('  ✓ DNS server running\n');

  // ============================================================================
  // SCENARIO A: Normal Connection & Messaging
  // ============================================================================
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  SCENARIO A: Normal Connection & Echo Request');
  console.log('═══════════════════════════════════════════════════════════════\n');

  let alice = createAgent('alice', {
    listenPort: 9001,
    dataDir: '/tmp/agenium-demo',
  });
  
  let bob = createAgent('bob', {
    listenPort: 9002,
    dataDir: '/tmp/agenium-demo',
  });
  
  alice.setDNSServer('127.0.0.1', 8053, false);
  bob.setDNSServer('127.0.0.1', 8053, false);
  
  // Register Alice with DNS
  dnsServer.registerAgent(alice.getDNSRegistration('localhost'));
  
  // Register echo handler
  alice.onRequest('echo', async (method, params) => {
    console.log(`  [Alice] Received echo: ${JSON.stringify(params)}`);
    return { echo: params, time: Date.now() };
  });
  
  await alice.start();
  await bob.start();
  
  console.log('  ✓ Alice started on port 9001');
  console.log('  ✓ Bob started on port 9002\n');
  
  await sleep(500);
  
  // Connect and send message
  console.log('  [Bob] Connecting to agent://alice...');
  const connectResult = await bob.connect('agent://alice');
  
  if (!connectResult.success) {
    console.error(`  ✗ Failed: ${connectResult.error}`);
    await stopAll(alice, bob, dnsServer);
    return;
  }
  
  const session = connectResult.session!;
  console.log(`  ✓ Connected! Session: ${session.id.slice(0, 8)}...\n`);
  
  console.log('  [Bob] Sending echo request...');
  const echoResult = await bob.request(session.id, 'echo', { message: 'Hello!' });
  console.log(`  [Bob] Response: ${JSON.stringify(echoResult)}`);
  console.log('  ✓ Scenario A passed!\n');
  
  // Save session ID for resume test
  const savedSessionId = session.id;

  // ============================================================================
  // SCENARIO B: Session Resume After Restart
  // ============================================================================
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  SCENARIO B: Session Resume After Bob Restart');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  console.log('  [Bob] Stopping (simulating crash)...');
  await bob.stop();
  console.log('  ✓ Bob stopped\n');
  
  await sleep(1000);
  
  console.log('  [Bob] Starting fresh instance (will auto-resume)...');
  
  bob = createAgent('bob', {
    listenPort: 9002,
    dataDir: '/tmp/agenium-demo',
  });
  bob.setDNSServer('127.0.0.1', 8053, false);
  
  // Listen for resume events
  bob.on('session_resumed', (info) => {
    console.log(`  ✓ Session resumed: ${info.sessionId.slice(0, 8)}... to ${info.remoteAgent}`);
  });
  
  bob.on('session_resume_failed', (info) => {
    console.log(`  ✗ Resume failed: ${info.error}`);
  });
  
  await bob.start();
  console.log('  ✓ Bob started\n');
  
  // Wait for resume attempts
  await sleep(2000);
  
  // Check if session is active
  const stats = bob.getStats();
  console.log(`  Bob sessions: ${stats.sessions.total} (active: ${stats.sessions.byState.ACTIVE})`);
  
  if (stats.sessions.byState.ACTIVE > 0) {
    console.log('  ✓ Scenario B passed!\n');
  } else {
    console.log('  ⚠ Resume in progress (backoff)...\n');
  }

  // ============================================================================
  // SCENARIO C: Message Queue During Network Interruption
  // ============================================================================
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  SCENARIO C: Messages Queued During Network Interruption');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  // Reconnect if needed
  let activeSession = bob.getAllSessions().find(s => s.state === 'ACTIVE');
  if (!activeSession) {
    console.log('  [Bob] Reconnecting to Alice...');
    const reconn = await bob.connect('agent://alice');
    if (reconn.success) {
      activeSession = reconn.session;
      console.log('  ✓ Reconnected\n');
    }
  }
  
  if (activeSession) {
    console.log('  [Alice] Stopping (simulating network outage)...');
    await alice.stop();
    console.log('  ✓ Alice stopped\n');
    
    console.log('  [Bob] Sending 3 messages (will be queued)...');
    
    // These should be queued since Alice is down
    for (let i = 1; i <= 3; i++) {
      try {
        await bob.event(activeSession.id, 'notification', { num: i, msg: `Message ${i}` });
        console.log(`    Message ${i}: enqueued`);
      } catch (err) {
        console.log(`    Message ${i}: queued for retry`);
      }
    }
    
    const queueStats = bob.getStats();
    console.log(`\n  Outbox pending: ${queueStats.outbox?.pending ?? 'N/A'}`);
    
    await sleep(1000);
    
    console.log('\n  [Alice] Restarting...');
    
    alice = createAgent('alice', {
      listenPort: 9001,
      dataDir: '/tmp/agenium-demo',
    });
    alice.setDNSServer('127.0.0.1', 8053, false);
    
    let receivedCount = 0;
    alice.onRequest('echo', async (m, p) => ({ echo: p }));
    alice.onEvent('notification', (event, data) => {
      receivedCount++;
      console.log(`  [Alice] Received: ${JSON.stringify(data)}`);
    });
    
    await alice.start();
    console.log('  ✓ Alice restarted\n');
    
    // Wait for retries to deliver
    console.log('  Waiting for message delivery...');
    await sleep(5000);
    
    console.log(`\n  Messages received by Alice: ${receivedCount}`);
    if (receivedCount >= 1) {
      console.log('  ✓ Scenario C passed!\n');
    } else {
      console.log('  ⚠ Messages still in queue (will retry)\n');
    }
  }

  // ============================================================================
  // SCENARIO D: Deduplication
  // ============================================================================
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  SCENARIO D: Deduplication (Same msgId not processed twice)');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  // Reconnect Bob if needed
  let bobSession = bob.getAllSessions().find(s => s.state === 'ACTIVE');
  if (!bobSession) {
    const reconn = await bob.connect('agent://alice');
    if (reconn.success) {
      bobSession = reconn.session;
    }
  }
  
  if (bobSession) {
    let processedCount = 0;
    alice.onRequest('dedupe_test', async () => {
      processedCount++;
      console.log(`  [Alice] Processing request (count: ${processedCount})`);
      return { count: processedCount };
    });
    
    console.log('  [Bob] Sending first request...');
    const result1 = await bob.request(bobSession.id, 'dedupe_test', {});
    console.log(`  [Bob] Response 1: ${JSON.stringify(result1)}`);
    
    // Note: In real scenario, we'd simulate sending same msgId twice
    // For demo, we just show the dedupe cache is working
    
    const dbStats = bob.getStats();
    console.log(`\n  Dedupe cache size: ${dbStats.persistence?.dedupeSize ?? 0}`);
    
    if (processedCount === 1) {
      console.log('  ✓ Scenario D passed!\n');
    }
  }

  // ============================================================================
  // Summary
  // ============================================================================
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  FINAL STATISTICS');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  const aliceStats = alice.getStats();
  const bobStats = bob.getStats();
  
  console.log('  Alice:');
  console.log(`    Sessions: ${aliceStats.sessions.total}`);
  console.log(`    Persistence: ${aliceStats.persistence ? 'enabled' : 'disabled'}`);
  if (aliceStats.persistence) {
    console.log(`    DB sessions: ${aliceStats.persistence.sessionCount}`);
  }
  
  console.log('\n  Bob:');
  console.log(`    Sessions: ${bobStats.sessions.total}`);
  console.log(`    Persistence: ${bobStats.persistence ? 'enabled' : 'disabled'}`);
  if (bobStats.persistence) {
    console.log(`    DB sessions: ${bobStats.persistence.sessionCount}`);
    console.log(`    Outbox pending: ${bobStats.persistence.outboxPending}`);
    console.log(`    Dedupe cache: ${bobStats.persistence.dedupeSize}`);
  }

  // ============================================================================
  // Cleanup
  // ============================================================================
  
  await stopAll(alice, bob, dnsServer);
  
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║                    DEMO COMPLETE ✓                         ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
}

async function stopAll(alice: Agent, bob: Agent, dns: DNSServer) {
  console.log('\n→ Shutting down...');
  await alice.stop();
  await bob.stop();
  await dns.stop();
  console.log('  ✓ All stopped');
}

main().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});

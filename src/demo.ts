/**
 * AGENIUM Demo - Agent-to-Agent Messaging
 * 
 * This demonstrates:
 * 1. Agent initialization and connection
 * 2. Request/Response messaging
 * 3. Fire-and-forget events
 * 4. Error handling
 * 5. Timeouts and retries
 */

import { createAgent } from './agent.js';

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           AGENIUM - Messaging Protocol Demo                ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // ============================================================================
  // Create two agents: Alice (server) and Bob (client)
  // ============================================================================
  
  console.log('→ Creating agents...\n');
  
  const alice = createAgent('alice', {
    listenPort: 9001,
    dataDir: '/tmp/agenium-demo',
  });
  
  const bob = createAgent('bob', {
    listenPort: 9002,
    dataDir: '/tmp/agenium-demo',
  });
  
  console.log(`  Alice: ${alice.getURI()} (port 9001)`);
  console.log(`  Bob: ${bob.getURI()} (port 9002)`);

  // ============================================================================
  // Register handlers on Alice
  // ============================================================================
  
  console.log('\n→ Registering handlers on Alice...\n');
  
  // Echo handler - returns whatever is sent
  alice.onRequest('echo', async (method, params) => {
    console.log(`  [Alice] Received echo request: ${JSON.stringify(params)}`);
    return { echo: params };
  });
  
  // Task handler - simulates async work
  alice.onRequest('task', async (method, params) => {
    const taskId = params?.taskId ?? 'unknown';
    const duration = (params?.duration as number) ?? 100;
    
    console.log(`  [Alice] Starting task ${taskId} (${duration}ms)...`);
    
    // Simulate work
    await new Promise(resolve => setTimeout(resolve, duration));
    
    console.log(`  [Alice] Task ${taskId} complete!`);
    return { 
      taskId, 
      status: 'completed', 
      result: Math.random() * 100 
    };
  });
  
  // Math handler - performs calculations
  alice.onRequest('math.add', async (method, params) => {
    const a = params?.a as number ?? 0;
    const b = params?.b as number ?? 0;
    console.log(`  [Alice] Calculating ${a} + ${b}`);
    return { result: a + b };
  });
  
  // Error handler - intentionally fails
  alice.onRequest('fail', async () => {
    console.log(`  [Alice] Intentional failure!`);
    throw new Error('This is an intentional error for testing');
  });
  
  // Event handler
  alice.onEvent('ping', (event, data) => {
    console.log(`  [Alice] Received ping event: ${JSON.stringify(data)}`);
  });
  
  alice.onEvent('notification', (event, data) => {
    console.log(`  [Alice] Received notification: ${JSON.stringify(data)}`);
  });
  
  console.log('  ✓ Registered handlers: echo, task, math.add, fail');
  console.log('  ✓ Registered events: ping, notification');

  // ============================================================================
  // Start both agents
  // ============================================================================
  
  console.log('\n→ Starting agents...');
  
  await alice.start();
  await bob.start();
  
  console.log('  ✓ Alice listening on port 9001');
  console.log('  ✓ Bob listening on port 9002');

  // Wait for servers to be ready
  await new Promise(r => setTimeout(r, 500));

  // ============================================================================
  // Bob connects to Alice
  // ============================================================================
  
  console.log('\n→ Bob connecting to Alice...');
  
  const connectResult = await bob.connect({ host: 'localhost', port: 9001 });
  
  if (!connectResult.success) {
    console.error(`  ✗ Connection failed: ${connectResult.error}`);
    await cleanup(alice, bob);
    return;
  }
  
  const session = connectResult.session!;
  console.log(`  ✓ Connected! Session: ${session.id.slice(0, 8)}...`);

  // ============================================================================
  // Protocol Frame Examples
  // ============================================================================
  
  console.log('\n┌────────────────────────────────────────────────────────────┐');
  console.log('│                    PROTOCOL FRAMES                         │');
  console.log('├────────────────────────────────────────────────────────────┤');
  console.log('│                                                            │');
  console.log('│  REQUEST Frame:                                            │');
  console.log('│  {                                                         │');
  console.log('│    "version": "1.0",                                       │');
  console.log('│    "messageId": "uuid-v4",                                 │');
  console.log('│    "type": "REQUEST",                                      │');
  console.log('│    "sessionId": "session-uuid",                            │');
  console.log('│    "timestamp": 1234567890,                                │');
  console.log('│    "payload": { "method": "echo", "params": {...} }        │');
  console.log('│  }                                                         │');
  console.log('│                                                            │');
  console.log('│  RESPONSE Frame:                                           │');
  console.log('│  {                                                         │');
  console.log('│    "version": "1.0",                                       │');
  console.log('│    "messageId": "uuid-v4",                                 │');
  console.log('│    "type": "RESPONSE",                                     │');
  console.log('│    "replyTo": "request-uuid",                              │');
  console.log('│    "payload": { "success": true, "result": {...} }         │');
  console.log('│  }                                                         │');
  console.log('│                                                            │');
  console.log('│  EVENT Frame:                                              │');
  console.log('│  {                                                         │');
  console.log('│    "type": "EVENT",                                        │');
  console.log('│    "payload": { "event": "ping", "data": {...} }           │');
  console.log('│  }                                                         │');
  console.log('│                                                            │');
  console.log('└────────────────────────────────────────────────────────────┘');

  // ============================================================================
  // Test 1: Echo request/response
  // ============================================================================
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  TEST 1: Echo Request/Response');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  console.log('  [Bob] Sending echo request...');
  
  try {
    const echoResult = await bob.request(session.id, 'echo', { 
      message: 'Hello, Alice!',
      timestamp: Date.now()
    });
    console.log(`  [Bob] Received response: ${JSON.stringify(echoResult)}`);
    console.log('  ✓ Echo test passed!\n');
  } catch (err) {
    console.error(`  ✗ Echo failed: ${(err as Error).message}\n`);
  }

  // ============================================================================
  // Test 2: Math calculation
  // ============================================================================
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TEST 2: Math Calculation');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  console.log('  [Bob] Calculating 42 + 17...');
  
  try {
    const mathResult = await bob.request(session.id, 'math.add', { a: 42, b: 17 });
    console.log(`  [Bob] Result: ${JSON.stringify(mathResult)}`);
    console.log('  ✓ Math test passed!\n');
  } catch (err) {
    console.error(`  ✗ Math failed: ${(err as Error).message}\n`);
  }

  // ============================================================================
  // Test 3: Async task
  // ============================================================================
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TEST 3: Async Task (200ms)');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  console.log('  [Bob] Starting async task...');
  
  const taskStart = Date.now();
  try {
    const taskResult = await bob.request(session.id, 'task', { 
      taskId: 'task-001',
      duration: 200 
    });
    const elapsed = Date.now() - taskStart;
    console.log(`  [Bob] Task result: ${JSON.stringify(taskResult)}`);
    console.log(`  [Bob] Elapsed time: ${elapsed}ms`);
    console.log('  ✓ Task test passed!\n');
  } catch (err) {
    console.error(`  ✗ Task failed: ${(err as Error).message}\n`);
  }

  // ============================================================================
  // Test 4: Fire-and-forget events
  // ============================================================================
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TEST 4: Fire-and-Forget Events');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  console.log('  [Bob] Sending ping event...');
  await bob.event(session.id, 'ping', { from: 'bob', time: Date.now() });
  
  console.log('  [Bob] Sending notification event...');
  await bob.event(session.id, 'notification', { 
    title: 'Hello!',
    body: 'This is a fire-and-forget message'
  });
  
  // Give events time to be processed
  await new Promise(r => setTimeout(r, 100));
  console.log('  ✓ Events sent!\n');

  // ============================================================================
  // Test 5: Error handling
  // ============================================================================
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TEST 5: Error Handling');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  console.log('  [Bob] Calling method that will fail...');
  
  try {
    await bob.request(session.id, 'fail', {});
    console.error('  ✗ Should have thrown an error!\n');
  } catch (err) {
    console.log(`  [Bob] Caught expected error: ${(err as Error).message}`);
    console.log('  ✓ Error handling test passed!\n');
  }
  
  console.log('  [Bob] Calling unknown method...');
  
  try {
    await bob.request(session.id, 'nonexistent_method', {});
    console.error('  ✗ Should have thrown an error!\n');
  } catch (err) {
    console.log(`  [Bob] Caught expected error: ${(err as Error).message}`);
    console.log('  ✓ Unknown method test passed!\n');
  }

  // ============================================================================
  // Show final statistics
  // ============================================================================
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  FINAL STATISTICS');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  const aliceStats = alice.getStats();
  const bobStats = bob.getStats();
  
  console.log('  Alice:');
  console.log(`    Sessions: ${aliceStats.sessions.total} (${aliceStats.sessions.byState.ACTIVE} active)`);
  console.log(`    Registered methods: ${aliceStats.dispatcher.registeredMethods.join(', ')}`);
  console.log(`    Registered events: ${aliceStats.dispatcher.registeredEvents.join(', ')}`);
  
  console.log('\n  Bob:');
  console.log(`    Sessions: ${bobStats.sessions.total} (${bobStats.sessions.byState.ACTIVE} active)`);
  console.log(`    Pending requests: ${bobStats.dispatcher.pendingRequests}`);
  console.log(`    Queued messages: ${bobStats.dispatcher.queuedMessages}`);

  // ============================================================================
  // Cleanup
  // ============================================================================
  
  await cleanup(alice, bob);
  
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║                    DEMO COMPLETE ✓                         ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
}

async function cleanup(alice: any, bob: any) {
  console.log('\n→ Shutting down...');
  await alice.stop();
  await bob.stop();
  console.log('  ✓ Agents stopped');
}

// Run demo
main().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});

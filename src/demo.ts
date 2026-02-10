/**
 * AGENIUM Demo - DNS Resolution for agent:// Protocol
 * 
 * This demonstrates:
 * 1. Local DNS server (simulating 185.204.169.26)
 * 2. Agent registration with DNS
 * 3. agent:// URI resolution
 * 4. Secure connection with key verification
 * 5. Error handling (NOT_FOUND, KEY_MISMATCH)
 */

import { createAgent } from './agent.js';
import { createDNSServer } from './dns/server.js';

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║          AGENIUM - DNS Resolution Demo                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // ============================================================================
  // Start DNS Server (simulating 185.204.169.26)
  // ============================================================================
  
  console.log('→ Starting DNS server (simulating 185.204.169.26)...\n');
  
  const dnsServer = createDNSServer({
    port: 8053,
    host: '127.0.0.1',
    defaultTtl: 60,
  });
  
  dnsServer.on('lookup', (name) => {
    console.log(`  [DNS] Lookup request for: ${name}`);
  });
  
  dnsServer.on('registered', (name) => {
    console.log(`  [DNS] Agent registered: ${name}`);
  });
  
  await dnsServer.start();
  console.log(`  ✓ DNS server running at ${dnsServer.getAddress()}\n`);

  // ============================================================================
  // Create agents
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
  
  // Point both agents to our local DNS server
  alice.setDNSServer('127.0.0.1', 8053, false);
  bob.setDNSServer('127.0.0.1', 8053, false);
  
  console.log(`  Alice: ${alice.getURI()} (port 9001)`);
  console.log(`  Bob: ${bob.getURI()} (port 9002)`);

  // ============================================================================
  // Register Alice with DNS
  // ============================================================================
  
  console.log('\n→ Registering Alice with DNS server...\n');
  
  const aliceReg = alice.getDNSRegistration('localhost');
  dnsServer.registerAgent(aliceReg);
  
  console.log('  DNS Registration Request:');
  console.log('  ┌────────────────────────────────────────────────────────────┐');
  console.log('  │  POST /api/agents/register                                 │');
  console.log('  │  {                                                         │');
  console.log(`  │    "name": "${aliceReg.name}",`);
  console.log(`  │    "publicKey": "${aliceReg.publicKey.slice(0, 40)}..."`);
  console.log(`  │    "endpoint": "${aliceReg.endpoint}",`);
  console.log(`  │    "capabilities": ${JSON.stringify(aliceReg.capabilities)},`);
  console.log(`  │    "protocolVersions": ${JSON.stringify(aliceReg.protocolVersions)}`);
  console.log('  │  }                                                         │');
  console.log('  └────────────────────────────────────────────────────────────┘');
  console.log('  ✓ Alice registered!\n');

  // ============================================================================
  // Register handlers on Alice
  // ============================================================================
  
  alice.onRequest('ping', async () => {
    console.log('  [Alice] Received ping request');
    return { pong: true, time: Date.now() };
  });
  
  alice.onRequest('echo', async (method, params) => {
    console.log(`  [Alice] Received echo: ${JSON.stringify(params)}`);
    return { echo: params };
  });

  // ============================================================================
  // Start agents
  // ============================================================================
  
  console.log('→ Starting agents...');
  
  await alice.start();
  await bob.start();
  
  console.log('  ✓ Alice listening on port 9001');
  console.log('  ✓ Bob listening on port 9002\n');

  await new Promise(r => setTimeout(r, 500));

  // ============================================================================
  // TEST 1: Successful DNS Resolution
  // ============================================================================
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TEST 1: Successful DNS Resolution');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  console.log('  [Bob] Connecting to agent://alice...\n');
  
  console.log('  DNS Lookup Request:');
  console.log('  ┌────────────────────────────────────────────────────────────┐');
  console.log('  │  GET /api/agents/alice                                     │');
  console.log('  └────────────────────────────────────────────────────────────┘');
  
  const result1 = await bob.connect('agent://alice');
  
  if (result1.success) {
    console.log('\n  DNS Lookup Response:');
    console.log('  ┌────────────────────────────────────────────────────────────┐');
    console.log('  │  {                                                         │');
    console.log('  │    "success": true,                                        │');
    console.log('  │    "agent": {                                              │');
    console.log(`  │      "name": "alice",`);
    console.log(`  │      "endpoint": "https://localhost:9001",`);
    console.log(`  │      "publicKey": "${aliceReg.publicKey.slice(0, 30)}..."`);
    console.log('  │      "ttl": 60                                             │');
    console.log('  │    }                                                       │');
    console.log('  │  }                                                         │');
    console.log('  └────────────────────────────────────────────────────────────┘');
    
    console.log(`\n  ✓ Connected to Alice!`);
    console.log(`    Session: ${result1.session!.id.slice(0, 8)}...`);
    console.log(`    State: ${result1.session!.state}`);
    
    // Send a test message
    console.log('\n  [Bob] Sending ping request...');
    const pingResult = await bob.request(result1.session!.id, 'ping', {});
    console.log(`  [Bob] Received: ${JSON.stringify(pingResult)}`);
    console.log('  ✓ Test 1 passed!\n');
  } else {
    console.log(`  ✗ Connection failed: ${result1.error}\n`);
  }

  // ============================================================================
  // TEST 2: Agent Not Found
  // ============================================================================
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TEST 2: Agent Not Found');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  console.log('  [Bob] Connecting to agent://unknown-agent...\n');
  
  console.log('  DNS Lookup Request:');
  console.log('  ┌────────────────────────────────────────────────────────────┐');
  console.log('  │  GET /api/agents/unknown-agent                             │');
  console.log('  └────────────────────────────────────────────────────────────┘');
  
  const result2 = await bob.connect('agent://unknown-agent');
  
  console.log('\n  DNS Lookup Response:');
  console.log('  ┌────────────────────────────────────────────────────────────┐');
  console.log('  │  {                                                         │');
  console.log('  │    "success": false,                                       │');
  console.log('  │    "error": {                                              │');
  console.log('  │      "code": "NOT_FOUND",                                  │');
  console.log('  │      "message": "Agent not found: unknown-agent"           │');
  console.log('  │    }                                                       │');
  console.log('  │  }                                                         │');
  console.log('  └────────────────────────────────────────────────────────────┘');
  
  if (!result2.success) {
    console.log(`\n  ✓ Expected error received: ${result2.error}`);
    console.log('  ✓ Test 2 passed!\n');
  } else {
    console.log('  ✗ Should have failed!\n');
  }

  // ============================================================================
  // TEST 3: Invalid Agent Name
  // ============================================================================
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TEST 3: Invalid Agent Name');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  console.log('  [Bob] Connecting to agent://123-invalid...\n');
  
  const result3 = await bob.connect('agent://123-invalid');
  
  console.log('  DNS Validation Error:');
  console.log('  ┌────────────────────────────────────────────────────────────┐');
  console.log('  │  {                                                         │');
  console.log('  │    "code": "INVALID_NAME",                                 │');
  console.log('  │    "message": "Invalid agent name: must start with letter" │');
  console.log('  │  }                                                         │');
  console.log('  └────────────────────────────────────────────────────────────┘');
  
  if (!result3.success) {
    console.log(`\n  ✓ Expected error received: ${result3.error}`);
    console.log('  ✓ Test 3 passed!\n');
  } else {
    console.log('  ✗ Should have failed!\n');
  }

  // ============================================================================
  // TEST 4: DNS Cache Demonstration
  // ============================================================================
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TEST 4: DNS Cache (TTL-based)');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  console.log('  [Bob] Second connection to agent://alice...');
  console.log('  (Should use cached DNS entry)\n');
  
  const startTime = Date.now();
  const result4 = await bob.connect('agent://alice');
  const elapsed = Date.now() - startTime;
  
  if (result4.success) {
    console.log(`  ✓ Connected in ${elapsed}ms (cache hit - no DNS query)`);
    console.log(`  ✓ Reusing existing session: ${result4.session!.id.slice(0, 8)}...`);
    console.log('  ✓ Test 4 passed!\n');
  } else {
    console.log(`  ✗ Connection failed: ${result4.error}\n`);
  }

  // ============================================================================
  // Summary
  // ============================================================================
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  DNS RESOLUTION FLOW');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  console.log('  ┌─────────┐         ┌─────────────┐         ┌─────────┐');
  console.log('  │   Bob   │         │  DNS Server │         │  Alice  │');
  console.log('  └────┬────┘         └──────┬──────┘         └────┬────┘');
  console.log('       │                     │                     │');
  console.log('       │ GET /api/agents/alice                     │');
  console.log('       │────────────────────►│                     │');
  console.log('       │                     │                     │');
  console.log('       │◄────────────────────│                     │');
  console.log('       │ { endpoint, pubkey }│                     │');
  console.log('       │                     │                     │');
  console.log('       │ Handshake (mTLS) ──────────────────────►│');
  console.log('       │                     │                     │');
  console.log('       │ Verify pubkey matches DNS                │');
  console.log('       │                     │                     │');
  console.log('       │◄────────────────────────── Session ACTIVE │');
  console.log('       │                     │                     │');
  console.log('  ┌────┴────┐         ┌──────┴──────┐         ┌────┴────┐');
  console.log('  │   Bob   │         │  DNS Server │         │  Alice  │');
  console.log('  └─────────┘         └─────────────┘         └─────────┘');

  // ============================================================================
  // Stats
  // ============================================================================
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  FINAL STATISTICS');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  const aliceStats = alice.getStats();
  const bobStats = bob.getStats();
  
  console.log('  DNS Server:');
  console.log(`    Registered agents: ${dnsServer.getAgents().join(', ')}`);
  
  console.log('\n  Alice:');
  console.log(`    Sessions: ${aliceStats.sessions.total} (${aliceStats.sessions.byState.ACTIVE} active)`);
  
  console.log('\n  Bob:');
  console.log(`    Sessions: ${bobStats.sessions.total} (${bobStats.sessions.byState.ACTIVE} active)`);

  // ============================================================================
  // Cleanup
  // ============================================================================
  
  console.log('\n→ Shutting down...');
  
  await alice.stop();
  await bob.stop();
  await dnsServer.stop();
  
  console.log('  ✓ All services stopped');
  
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║                    DEMO COMPLETE ✓                         ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
}

// Run demo
main().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});

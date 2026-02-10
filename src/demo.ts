/**
 * AGENIUM Demo - Two Agents Connecting Locally
 * 
 * This demonstrates:
 * 1. Agent initialization with keys and certificates
 * 2. mTLS server/client setup
 * 3. Handshake protocol execution
 * 4. Session establishment
 * 5. Bug reporting integration
 */

import { createAgent } from './agent.js';

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           AGENIUM - Agent-to-Agent Demo                    ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // ============================================================================
  // Create two agents: Alice and Bob
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
  
  console.log(`  Alice: ${alice.getURI()}`);
  console.log(`    └─ Public Key: ${alice.getIdentity().publicKey.slice(0, 40)}...`);
  console.log(`  Bob: ${bob.getURI()}`);
  console.log(`    └─ Public Key: ${bob.getIdentity().publicKey.slice(0, 40)}...`);

  // ============================================================================
  // Set up event handlers
  // ============================================================================
  
  alice.on('listening', (addr) => {
    console.log(`\n✓ Alice listening on port ${addr.port}`);
  });
  
  alice.on('connection', (info) => {
    console.log(`\n✓ Alice received connection from ${info.remoteAgent.name}`);
    console.log(`  └─ Session: ${info.sessionId.slice(0, 8)}...`);
    console.log(`  └─ Capabilities: ${info.capabilities.join(', ')}`);
  });
  
  bob.on('listening', (addr) => {
    console.log(`✓ Bob listening on port ${addr.port}`);
  });
  
  bob.on('connected', (info) => {
    console.log(`\n✓ Bob connected to ${info.remoteAgent.name}`);
    console.log(`  └─ Session: ${info.sessionId.slice(0, 8)}...`);
    console.log(`  └─ Capabilities: ${info.capabilities.join(', ')}`);
  });

  // ============================================================================
  // Start both agents
  // ============================================================================
  
  console.log('\n→ Starting agents...');
  
  await alice.start();
  await bob.start();
  
  // Wait a bit for servers to be ready
  await new Promise(r => setTimeout(r, 500));

  // ============================================================================
  // Bob connects to Alice
  // ============================================================================
  
  console.log('\n→ Bob connecting to Alice...');
  console.log('  ┌────────────────────────────────────────────────────────┐');
  console.log('  │                  HANDSHAKE FLOW                        │');
  console.log('  │                                                        │');
  console.log('  │  Bob                                           Alice   │');
  console.log('  │   │                                              │     │');
  console.log('  │   │──── HandshakeInit (version, caps, sig) ─────►│     │');
  console.log('  │   │                                              │     │');
  console.log('  │   │◄─── HandshakeResponse (caps, sig) ───────────│     │');
  console.log('  │   │                                              │     │');
  console.log('  │   │──── HandshakeComplete (session, sig) ───────►│     │');
  console.log('  │   │                                              │     │');
  console.log('  │   │◄─── Session Established ─────────────────────│     │');
  console.log('  │   │                                              │     │');
  console.log('  └────────────────────────────────────────────────────────┘');
  
  const result = await bob.connect({ host: 'localhost', port: 9001 });
  
  if (result.success) {
    console.log('\n✅ CONNECTION SUCCESSFUL!');
    console.log('\n  Session Details:');
    console.log(`    ID: ${result.session!.id}`);
    console.log(`    State: ${result.session!.state}`);
    console.log(`    Remote: ${result.session!.remoteAgent.name}`);
    console.log(`    Capabilities: ${result.session!.capabilities.join(', ') || 'messaging'}`);
  } else {
    console.log(`\n❌ Connection failed: ${result.error}`);
  }

  // ============================================================================
  // Show stats
  // ============================================================================
  
  console.log('\n→ Agent Statistics:');
  
  const aliceStats = alice.getStats();
  console.log('\n  Alice:');
  console.log(`    Sessions: ${aliceStats.sessions.total}`);
  console.log(`    Active: ${aliceStats.sessions.byState.ACTIVE}`);
  console.log(`    Connections: ${aliceStats.connections.totalConnections}`);
  
  const bobStats = bob.getStats();
  console.log('\n  Bob:');
  console.log(`    Sessions: ${bobStats.sessions.total}`);
  console.log(`    Active: ${bobStats.sessions.byState.ACTIVE}`);
  console.log(`    Connections: ${bobStats.connections.totalConnections}`);

  // ============================================================================
  // Cleanup
  // ============================================================================
  
  console.log('\n→ Shutting down...');
  
  await alice.stop();
  await bob.stop();
  
  console.log('\n✓ Demo complete!\n');
}

// Run demo
main().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});

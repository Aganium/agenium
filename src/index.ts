/**
 * AGENIUM - Local, Stateful Agent-to-Agent Client
 * 
 * Entry point and public API
 */

// Core types and utilities
export * from './core/index.js';

// DNS resolution
export * from './dns/index.js';

// Session state management
export * from './state/index.js';

// Bug reporting
export * from './bug-report/index.js';

// Transport (TODO)
export * from './transport/index.js';

// ============================================================================
// Quick Start Example
// ============================================================================

import { DNSResolver } from './dns/index.js';
import { SessionManager, createSessionManager } from './state/index.js';
import { BugReporter, getBugReporter } from './bug-report/index.js';
import { AgentID, SessionState, SessionEvent } from './core/index.js';

/**
 * Initialize AGENIUM with a local agent identity
 */
export function createAgent(agentId: AgentID) {
  const resolver = new DNSResolver();
  const sessions = createSessionManager(agentId);
  const bugReporter = getBugReporter({
    agentId: agentId.name,
  });

  // Wire up bug reporter state provider
  bugReporter.setStateProvider(() => ({
    sessionCount: sessions.getStats().total,
    queueDepth: 0,
    memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    activeConnections: sessions.getActiveCount(),
  }));

  bugReporter.start();

  return {
    resolver,
    sessions,
    bugReporter,
    
    /**
     * Connect to a remote agent by URI
     */
    async connect(agentUri: string) {
      bugReporter.recordAction('connect', { uri: agentUri });
      
      // Resolve the agent
      const result = await resolver.resolve(agentUri);
      if (!result.ok) {
        bugReporter.report('connection', 'RESOLVE_FAILED', result.error.message);
        throw new Error(result.error.message);
      }

      // Create or find session
      let session = sessions.findByRemote(result.endpoint.agentId.name);
      if (!session) {
        session = sessions.create(result.endpoint.agentId);
      }

      // Transition to CONNECTING
      sessions.transition(session.id, SessionEvent.CONNECT);

      return { session, endpoint: result.endpoint };
    },

    /**
     * Shutdown the agent
     */
    shutdown() {
      bugReporter.stop();
      sessions.cleanup();
    },
  };
}

// ============================================================================
// Demo / Self-Test
// ============================================================================

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('AGENIUM v0.1.0');
  console.log('==============\n');

  // Create a test agent
  const agent = createAgent({
    name: 'test-agent',
    publicKey: 'demo-key-not-real',
  });

  console.log('✓ Agent initialized');
  console.log(`  Sessions: ${agent.sessions.getStats().total}`);
  console.log(`  Bug reporter: active`);

  // Test DNS resolution (will fail without real server)
  console.log('\n→ Testing DNS resolution for agent://bob...');
  agent.connect('agent://bob').catch(err => {
    console.log(`  Expected error: ${err.message}`);
  });

  // Test session FSM
  console.log('\n→ Testing session FSM...');
  const remoteAgent: AgentID = { name: 'alice', publicKey: 'alice-pubkey' };
  const session = agent.sessions.create(remoteAgent);
  console.log(`  Created session: ${session.id} (state: ${session.state})`);

  agent.sessions.transition(session.id, SessionEvent.CONNECT);
  console.log(`  After CONNECT: ${agent.sessions.get(session.id)?.state}`);

  agent.sessions.transition(session.id, SessionEvent.CONNECTED);
  console.log(`  After CONNECTED: ${agent.sessions.get(session.id)?.state}`);

  agent.sessions.transition(session.id, SessionEvent.HANDSHAKE_OK);
  console.log(`  After HANDSHAKE_OK: ${agent.sessions.get(session.id)?.state}`);

  // Test bug reporter
  console.log('\n→ Testing bug reporter...');
  const reportId = agent.bugReporter.report('internal', 'TEST', 'This is a test report');
  console.log(`  Created report: ${reportId}`);
  console.log(`  Queue stats:`, agent.bugReporter.getStats());

  // Cleanup
  setTimeout(() => {
    agent.shutdown();
    console.log('\n✓ Shutdown complete');
  }, 100);
}

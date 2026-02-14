#!/usr/bin/env npx tsx
/**
 * agent://echo — Minimal demo agent
 * 
 * Tools:
 *   echo({message}) → {echo, timestamp}
 *   ping() → {pong, uptime}
 *   info() → agent metadata
 * 
 * Proves the AGENIUM protocol works end-to-end:
 *   DNS resolve → TLS handshake → tool.list → tool.invoke
 */

import { createAgent } from '../dist/index.js';

const PORT = parseInt(process.env.PORT ?? '9001');
const DNS_API_KEY = process.env.DNS_API_KEY ?? '';
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? 'localhost';
const DNS_SERVER = process.env.DNS_SERVER ?? '185.204.169.26:3000';

const agent = createAgent('echo', {
  listenPort: PORT,
  dnsServer: DNS_SERVER,
  persistence: true,
  tools: [
    {
      name: 'echo',
      description: 'Echo back the message you send',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Message to echo' },
        },
        required: ['message'],
      },
      handler: async (input) => ({
        echo: (input as any).message,
        timestamp: new Date().toISOString(),
      }),
    },
    {
      name: 'ping',
      description: 'Health check — returns pong + uptime',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({
        pong: true,
        uptime: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
      }),
    },
    {
      name: 'info',
      description: 'Agent metadata and capabilities',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({
        name: 'echo',
        version: '1.0.0',
        protocol: 'agent://',
        description: 'AGENIUM demo echo agent — proves the protocol works',
        tools: ['echo', 'ping', 'info'],
        uptime: Math.round(process.uptime()),
      }),
    },
  ],
});

// Lifecycle events
agent.on('started', ({ name, port }) => {
  console.log(`\n🤖 agent://echo started on port ${port}`);
  console.log(`   Tools: echo, ping, info`);
  console.log(`   DNS: ${DNS_SERVER}`);
});

agent.on('connection', ({ sessionId, remoteAgent }) => {
  console.log(`📡 New connection: ${remoteAgent?.name ?? 'unknown'} (session: ${sessionId})`);
});

agent.on('registered', ({ domain, tools }) => {
  console.log(`✅ DNS registered: ${domain} (${tools} tools)`);
});

agent.on('error', (err) => {
  console.error('❌ Error:', err.message);
});

// Start
(async () => {
  await agent.start();

  if (DNS_API_KEY) {
    const result = await agent.register(DNS_API_KEY, PUBLIC_HOST);
    if (!result.success) {
      console.warn(`⚠️  DNS registration failed: ${result.error}`);
    }
  } else {
    console.log('ℹ️  No DNS_API_KEY — skipping DNS registration (local-only mode)');
  }

  // Graceful shutdown
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      console.log(`\n🛑 ${sig} received, shutting down...`);
      await agent.stop();
      process.exit(0);
    });
  }
})();

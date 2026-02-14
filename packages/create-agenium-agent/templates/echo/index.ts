/**
 * agent://{{NAME}} — Echo Agent
 *
 * Tools: echo, ping, info
 * Template: echo (minimal)
 */

import { createAgent } from 'agenium';

const PORT = parseInt(process.env.PORT ?? '{{PORT}}');
const DNS_API_KEY = process.env.DNS_API_KEY ?? '';
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? 'localhost';
const DNS_SERVER = process.env.DNS_SERVER ?? '{{DNS_SERVER}}';

const agent = createAgent('{{NAME}}', {
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
      description: 'Health check',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({
        pong: true,
        uptime: Math.round(process.uptime()),
      }),
    },
    {
      name: 'info',
      description: 'Agent metadata',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({
        name: '{{NAME}}',
        version: '0.1.0',
        protocol: 'agent://',
        description: '{{DESCRIPTION}}',
      }),
    },
  ],
});

agent.on('started', ({ name, port }) => {
  console.log(`🤖 agent://${name} started on port ${port}`);
});

agent.on('connection', ({ sessionId, remoteAgent }) => {
  console.log(`📡 Connection: ${remoteAgent?.name ?? 'unknown'} (${sessionId})`);
});

agent.on('error', (err) => {
  console.error('❌', err.message);
});

(async () => {
  await agent.start();

  if (DNS_API_KEY) {
    const res = await agent.register(DNS_API_KEY, PUBLIC_HOST);
    if (res.success) console.log(`✅ Registered: agent://{{NAME}}`);
    else console.warn(`⚠️  Registration failed: ${res.error}`);
  } else {
    console.log('ℹ️  No DNS_API_KEY — local-only mode');
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      console.log(`\n🛑 Shutting down...`);
      await agent.stop();
      process.exit(0);
    });
  }
})();

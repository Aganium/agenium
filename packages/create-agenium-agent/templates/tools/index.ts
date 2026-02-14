/**
 * agent://{{NAME}} — Custom Tools Agent
 *
 * Starter template with example tools you can customize.
 * Add your own tools, connect APIs, build something useful.
 */

import { createAgent } from 'agenium';

const PORT = parseInt(process.env.PORT ?? '{{PORT}}');
const DNS_API_KEY = process.env.DNS_API_KEY ?? '';
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? 'localhost';
const DNS_SERVER = process.env.DNS_SERVER ?? '{{DNS_SERVER}}';

// ─── Define your tools ───────────────────────────────────────────────────────

const tools = [
  {
    name: 'greet',
    description: 'Generate a personalized greeting',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Name to greet' },
        language: {
          type: 'string',
          description: 'Language (en, es, fr, de, fa)',
          enum: ['en', 'es', 'fr', 'de', 'fa'],
        },
      },
      required: ['name'],
    },
    handler: async (input: any) => {
      const greetings: Record<string, string> = {
        en: `Hello, ${input.name}! Welcome to AGENIUM.`,
        es: `¡Hola, ${input.name}! Bienvenido a AGENIUM.`,
        fr: `Bonjour, ${input.name}! Bienvenue sur AGENIUM.`,
        de: `Hallo, ${input.name}! Willkommen bei AGENIUM.`,
        fa: `سلام ${input.name}! به AGENIUM خوش آمدید.`,
      };
      const lang = input.language ?? 'en';
      return { greeting: greetings[lang] ?? greetings.en, language: lang };
    },
  },
  {
    name: 'calculate',
    description: 'Perform basic math operations',
    inputSchema: {
      type: 'object' as const,
      properties: {
        operation: {
          type: 'string',
          description: 'Math operation',
          enum: ['add', 'subtract', 'multiply', 'divide'],
        },
        a: { type: 'number', description: 'First operand' },
        b: { type: 'number', description: 'Second operand' },
      },
      required: ['operation', 'a', 'b'],
    },
    handler: async (input: any) => {
      const { operation, a, b } = input;
      const ops: Record<string, () => number> = {
        add: () => a + b,
        subtract: () => a - b,
        multiply: () => a * b,
        divide: () => {
          if (b === 0) throw new Error('Division by zero');
          return a / b;
        },
      };
      const fn = ops[operation];
      if (!fn) throw new Error(`Unknown operation: ${operation}`);
      return { result: fn(), expression: `${a} ${operation} ${b}` };
    },
  },
  {
    name: 'status',
    description: 'Agent status and uptime',
    inputSchema: { type: 'object' as const, properties: {} },
    handler: async () => ({
      name: '{{NAME}}',
      version: '0.1.0',
      uptime: Math.round(process.uptime()),
      memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
      timestamp: new Date().toISOString(),
    }),
  },
];

// ─── Create and start the agent ──────────────────────────────────────────────

const agent = createAgent('{{NAME}}', {
  listenPort: PORT,
  dnsServer: DNS_SERVER,
  persistence: true,
  tools,
});

agent.on('started', ({ name, port }) => {
  console.log(`🤖 agent://${name} started on port ${port}`);
  console.log(`   Tools: ${tools.map(t => t.name).join(', ')}`);
});

agent.on('connection', ({ sessionId, remoteAgent }) => {
  console.log(`📡 Connection: ${remoteAgent?.name ?? 'unknown'} (${sessionId})`);
});

agent.on('error', (err) => console.error('❌', err.message));

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

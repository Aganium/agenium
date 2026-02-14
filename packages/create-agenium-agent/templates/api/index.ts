/**
 * agent://{{NAME}} — API Wrapper Agent
 *
 * Wraps an external REST API as agent:// tools.
 * Replace the example endpoints with your own API.
 */

import { createAgent } from 'agenium';

const PORT = parseInt(process.env.PORT ?? '{{PORT}}');
const DNS_API_KEY = process.env.DNS_API_KEY ?? '';
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? 'localhost';
const DNS_SERVER = process.env.DNS_SERVER ?? '{{DNS_SERVER}}';

// ─── Your API configuration ─────────────────────────────────────────────────

const API_BASE = process.env.API_BASE ?? 'https://jsonplaceholder.typicode.com';

async function apiFetch(path: string): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

// ─── Tools that wrap your API ────────────────────────────────────────────────

const tools = [
  {
    name: 'list_items',
    description: 'List items from the API (paginated)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max items to return (default 5)' },
      },
    },
    handler: async (input: any) => {
      const limit = input.limit ?? 5;
      const items = await apiFetch(`/posts?_limit=${limit}`);
      return {
        count: items.length,
        items: items.map((p: any) => ({ id: p.id, title: p.title })),
      };
    },
  },
  {
    name: 'get_item',
    description: 'Get a single item by ID',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Item ID' },
      },
      required: ['id'],
    },
    handler: async (input: any) => {
      const item = await apiFetch(`/posts/${input.id}`);
      return { id: item.id, title: item.title, body: item.body };
    },
  },
  {
    name: 'search',
    description: 'Search items by keyword',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search keyword' },
        limit: { type: 'number', description: 'Max results (default 5)' },
      },
      required: ['query'],
    },
    handler: async (input: any) => {
      const all = await apiFetch('/posts');
      const q = (input.query as string).toLowerCase();
      const matches = all
        .filter((p: any) => p.title.toLowerCase().includes(q) || p.body.toLowerCase().includes(q))
        .slice(0, input.limit ?? 5);
      return { query: input.query, count: matches.length, results: matches.map((p: any) => ({ id: p.id, title: p.title })) };
    },
  },
  {
    name: 'status',
    description: 'Agent and API status',
    inputSchema: { type: 'object' as const, properties: {} },
    handler: async () => {
      let apiOk = false;
      try {
        await apiFetch('/posts/1');
        apiOk = true;
      } catch {}
      return {
        agent: '{{NAME}}',
        version: '0.1.0',
        uptime: Math.round(process.uptime()),
        apiBase: API_BASE,
        apiHealthy: apiOk,
      };
    },
  },
];

// ─── Create and start ────────────────────────────────────────────────────────

const agent = createAgent('{{NAME}}', {
  listenPort: PORT,
  dnsServer: DNS_SERVER,
  persistence: true,
  tools,
});

agent.on('started', ({ name, port }) => {
  console.log(`🤖 agent://${name} started on port ${port}`);
  console.log(`   API: ${API_BASE}`);
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

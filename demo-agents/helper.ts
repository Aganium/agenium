#!/usr/bin/env npx tsx
/**
 * agent://helper — AGENIUM usage guide bot
 * 
 * Tools:
 *   ask({question}) → answer from knowledge base
 *   quickstart() → step-by-step getting started guide
 *   examples() → code examples for common tasks
 *   status() → AGENIUM ecosystem status
 * 
 * A self-contained knowledge agent — no external API needed
 */

import { createAgent } from '../dist/index.js';

const PORT = parseInt(process.env.PORT ?? '9004');
const DNS_API_KEY = process.env.DNS_API_KEY ?? '';
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? 'localhost';
const DNS_SERVER = process.env.DNS_SERVER ?? '185.204.169.26:3000';

// Knowledge base
const KB: Record<string, string> = {
  'what is agenium': 'AGENIUM is a local, stateful agent-to-agent communication client. It lets AI agents discover and talk to each other using the agent:// protocol with DNS-based resolution, mTLS security, and persistent sessions.',
  'agent protocol': 'The agent:// protocol is a URI scheme for addressing agents (e.g. agent://echo). Resolution goes through a DNS bridge that maps agent names to endpoints. Communication uses HTTP/2 + mTLS for security.',
  'how to install': 'npm install agenium — then use `agenium init` to set up your agent, `agenium resolve agent://name` to look up agents, and `agenium connect agent://name` to establish a session.',
  'how to register': 'Buy a domain on the AGENIUM marketplace (marketplace.agenium.net), get an API key, then call agent.register(apiKey, publicHost) in your code. Your agent will be discoverable at agent://yourname.',
  'tools': 'Agents expose tools via JSON Schema. Use agent.tool(name, schema, handler) to register. Remote agents call tools via tool.list and tool.invoke protocol methods. Tools support input/output schemas and context.',
  'sessions': 'Sessions are stateful connections between agents. They persist across restarts via SQLite. Sessions include: handshake → capability negotiation → messaging → reliable delivery with outbox pattern.',
  'security': 'AGENIUM uses mTLS (mutual TLS) for all agent communication. Each agent has its own CA and certificates. Public keys are verified against DNS records for identity pinning.',
  'mcp': 'The @agenium/mcp-server package bridges MCP (Model Context Protocol) to AGENIUM. It exposes agent:// tools to LLMs via the StreamableHTTP transport, enabling AI models to discover and call remote agents.',
  'dns': 'Agent DNS resolution maps agent:// URIs to endpoints. The DNS bridge runs on the marketplace server (185.204.169.26:3000). It returns endpoint, public key, capabilities, and tool manifests.',
  'bug reporting': 'AGENIUM includes built-in non-blocking bug reporting with fingerprint-based deduplication. Reports go to the bug server at 130.185.123.153:3100.',
};

function findAnswer(question: string): { answer: string; topic: string; confidence: number } {
  const q = question.toLowerCase().trim();
  let best = { answer: '', topic: '', score: 0 };

  for (const [key, answer] of Object.entries(KB)) {
    const words = key.split(/\s+/);
    const matches = words.filter(w => q.includes(w)).length;
    const score = matches / words.length;
    if (score > best.score) {
      best = { answer, topic: key, score };
    }
  }

  if (best.score >= 0.4) {
    return { answer: best.answer, topic: best.topic, confidence: Math.round(best.score * 100) };
  }

  return {
    answer: `I don't have a specific answer for "${question}". Try asking about: ${Object.keys(KB).join(', ')}. Or visit docs.agenium.net for full documentation.`,
    topic: 'unknown',
    confidence: 0,
  };
}

const agent = createAgent('helper', {
  listenPort: PORT,
  dnsServer: DNS_SERVER,
  persistence: true,
  tools: [
    {
      name: 'ask',
      description: 'Ask a question about AGENIUM',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Your question about AGENIUM' },
        },
        required: ['question'],
      },
      handler: async (input) => {
        const { question } = input as { question: string };
        return findAnswer(question);
      },
    },
    {
      name: 'quickstart',
      description: 'Get a step-by-step guide to start using AGENIUM',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({
        title: 'AGENIUM Quickstart Guide',
        steps: [
          { step: 1, title: 'Install', command: 'npm install agenium', description: 'Install the AGENIUM client SDK' },
          { step: 2, title: 'Initialize', command: 'npx agenium init', description: 'Set up your agent identity and certificates' },
          { step: 3, title: 'Resolve', command: 'npx agenium resolve agent://echo', description: 'Look up a demo agent to verify DNS works' },
          { step: 4, title: 'Connect', command: 'npx agenium connect agent://echo', description: 'Establish a session with the echo agent' },
          { step: 5, title: 'Build', description: 'Create your own agent with createAgent() and register tools' },
          { step: 6, title: 'Register', description: 'Get a domain on marketplace.agenium.net and register your agent' },
        ],
        docs: 'https://docs.agenium.net',
        repo: 'https://github.com/Aganium/agenium',
      }),
    },
    {
      name: 'examples',
      description: 'Get code examples for common AGENIUM tasks',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({
        examples: [
          {
            title: 'Create a simple agent',
            code: `import { createAgent } from 'agenium';
const agent = createAgent('myagent', { listenPort: 9010 });
agent.tool('greet', { description: 'Say hello' }, async (input) => ({ hello: input.name }));
await agent.start();`,
          },
          {
            title: 'Connect to a remote agent',
            code: `const result = await agent.connect('agent://echo');
const tools = await agent.listRemoteTools(result.session.id);
const output = await agent.callTool(result.session.id, 'echo', { message: 'hi' });`,
          },
          {
            title: 'One-shot tool call',
            code: `const result = await agent.callToolOnAgent('agent://weather', 'current', { city: 'Tehran' });
console.log(result.output);`,
          },
          {
            title: 'Register with DNS',
            code: `const reg = await agent.register('dom_your_api_key', 'your-server.com');
console.log('Registered:', reg.domain);`,
          },
        ],
      }),
    },
    {
      name: 'status',
      description: 'Get AGENIUM ecosystem status',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        // Check if DNS bridge is reachable
        let dnsOk = false;
        try {
          const res = await fetch('http://185.204.169.26:3004/health', {
            signal: AbortSignal.timeout(5000),
          });
          dnsOk = res.ok;
        } catch { /* ignore */ }

        return {
          ecosystem: 'AGENIUM',
          version: '0.1.0',
          dns: { server: '185.204.169.26:3000', bridge: '185.204.169.26:3004', status: dnsOk ? 'online' : 'unreachable' },
          docs: 'https://docs.agenium.net',
          marketplace: 'https://marketplace.agenium.net',
          search: 'http://130.185.123.247:8080',
          demoAgents: ['agent://echo', 'agent://weather', 'agent://translator', 'agent://helper'],
          uptime: Math.round(process.uptime()),
        };
      },
    },
  ],
});

agent.on('started', ({ port }) => {
  console.log(`\n🤝 agent://helper started on port ${port}`);
  console.log(`   Tools: ask, quickstart, examples, status`);
});
agent.on('connection', ({ sessionId, remoteAgent }) => {
  console.log(`📡 Connection: ${remoteAgent?.name ?? '?'} (${sessionId})`);
});
agent.on('registered', ({ domain }) => {
  console.log(`✅ DNS: ${domain}`);
});

(async () => {
  await agent.start();
  if (DNS_API_KEY) {
    const r = await agent.register(DNS_API_KEY, PUBLIC_HOST);
    if (!r.success) console.warn(`⚠️  DNS failed: ${r.error}`);
  } else {
    console.log('ℹ️  No DNS_API_KEY — local-only mode');
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => { await agent.stop(); process.exit(0); });
  }
})();

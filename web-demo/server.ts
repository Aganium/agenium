/**
 * AGENIUM Web Demo — Backend Proxy
 * 
 * Uses the agenium SDK to connect to demo agents via agent:// protocol
 * (handles mTLS, handshake, sessions automatically)
 * Frontend talks to this via simple JSON REST API
 */

import express from 'express';
import cors from 'cors';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createAgent, type Agent } from 'agenium';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? '3080');
const PROXY_PORT = parseInt(process.env.PROXY_PORT ?? '19999');

// Demo agents on DNS server
const DEMO_AGENTS: Record<string, { host: string; port: number; description: string }> = {
  echo: {
    host: process.env.AGENT_HOST ?? '185.204.169.26',
    port: 9001,
    description: 'Echo back messages — proves the protocol works end-to-end',
  },
  weather: {
    host: process.env.AGENT_HOST ?? '185.204.169.26',
    port: 9002,
    description: 'Get weather for any city worldwide',
  },
  translator: {
    host: process.env.AGENT_HOST ?? '185.204.169.26',
    port: 9003,
    description: 'Translate text between 10+ languages',
  },
  helper: {
    host: process.env.AGENT_HOST ?? '185.204.169.26',
    port: 9004,
    description: 'AI coding helper — answers dev questions',
  },
};

// Client session tracking
interface ClientSession {
  agentName: string;
  agentSessionId: string;
  createdAt: number;
}
const clientSessions = new Map<string, ClientSession>();

// The proxy agent (acts as client to demo agents)
let proxyAgent: Agent;

// Rate limiting
const requestCounts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 30;
const RATE_WINDOW = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = requestCounts.get(ip);
  if (!entry || now > entry.resetAt) {
    requestCounts.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

// ============================================================================
// Express App
// ============================================================================

const app = express();
app.use(cors());
app.use(express.json());
app.set('trust proxy', 1);

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Rate limit for API
app.use('/api', (req, res, next) => {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  if (!checkRateLimit(ip)) {
    res.status(429).json({ error: 'Rate limit exceeded. Try again in a minute.' });
    return;
  }
  next();
});

// GET /api/agents — list available demo agents
app.get('/api/agents', (_req, res) => {
  const agents = Object.entries(DEMO_AGENTS).map(([name, info]) => ({
    name,
    uri: `agent://${name}.agent`,
    description: info.description,
  }));
  res.json({ agents });
});

// POST /api/agents/:name/connect — connect + list tools
app.post('/api/agents/:name/connect', async (req, res) => {
  const { name } = req.params;
  const agent = DEMO_AGENTS[name];
  if (!agent) {
    res.status(404).json({ error: `Agent '${name}' not found` });
    return;
  }

  try {
    // Connect via the SDK (handles mTLS + handshake)
    const result = await proxyAgent.connect({ host: agent.host, port: agent.port });
    if (!result.success || !result.session) {
      throw new Error(result.error ?? 'Connection failed');
    }

    // List tools
    const toolsResult = await proxyAgent.listRemoteTools(result.session.id);
    const tools = toolsResult.tools ?? [];

    // Create client-facing session ID
    const clientSessionId = randomUUID();
    clientSessions.set(clientSessionId, {
      agentName: name,
      agentSessionId: result.session.id,
      createdAt: Date.now(),
    });

    // Cleanup old sessions (>30 min)
    const cutoff = Date.now() - 30 * 60_000;
    for (const [id, s] of clientSessions) {
      if (s.createdAt < cutoff) clientSessions.delete(id);
    }

    res.json({
      sessionId: clientSessionId,
      agent: {
        name,
        uri: `agent://${name}.agent`,
        description: agent.description,
      },
      tools,
    });
  } catch (err: any) {
    console.error(`Connect to ${name} failed:`, err.message);
    res.status(502).json({ error: `Failed to connect to agent://${name}.agent: ${err.message}` });
  }
});

// POST /api/agents/:name/invoke — invoke a tool
app.post('/api/agents/:name/invoke', async (req, res) => {
  const { name } = req.params;
  const { sessionId: clientSessionId, tool, input } = req.body;

  if (!tool) {
    res.status(400).json({ error: 'Missing "tool" field' });
    return;
  }

  const agentInfo = DEMO_AGENTS[name];
  if (!agentInfo) {
    res.status(404).json({ error: `Agent '${name}' not found` });
    return;
  }

  try {
    // Find or create session
    let session = clientSessionId ? clientSessions.get(clientSessionId) : null;
    
    if (!session) {
      // Auto-connect
      const connectResult = await proxyAgent.connect({ host: agentInfo.host, port: agentInfo.port });
      if (!connectResult.success || !connectResult.session) {
        throw new Error(connectResult.error ?? 'Auto-connect failed');
      }
      const newClientId = randomUUID();
      session = {
        agentName: name,
        agentSessionId: connectResult.session.id,
        createdAt: Date.now(),
      };
      clientSessions.set(newClientId, session);
    }

    const result = await proxyAgent.callTool(session.agentSessionId, tool, input ?? {});

    res.json({ result: result.output });
  } catch (err: any) {
    // On session error, try reconnecting once
    if (err.message.includes('session') || err.message.includes('Session') || err.message.includes('not found')) {
      try {
        const connectResult = await proxyAgent.connect({ host: agentInfo.host, port: agentInfo.port });
        if (connectResult.success && connectResult.session) {
          const result = await proxyAgent.callTool(connectResult.session.id, tool, input ?? {});
          res.json({ result: result.output });
          return;
        }
      } catch (retryErr: any) {
        console.error(`Retry invoke on ${name} failed:`, retryErr.message);
      }
    }
    console.error(`Invoke ${tool} on ${name} failed:`, err.message);
    res.status(502).json({ error: `Tool invocation failed: ${err.message}` });
  }
});

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    agents: Object.keys(DEMO_AGENTS).length,
    sessions: clientSessions.size,
    uptime: Math.round(process.uptime()),
  });
});

// ============================================================================
// Startup
// ============================================================================

// Prevent crashes from unhandled rejections
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});
process.on('unhandledRejection', (err: any) => {
  console.error('Unhandled rejection:', err?.message ?? err);
});

async function main() {
  console.log('🔧 Initializing AGENIUM proxy agent...');

  // Create a local agent that acts as client to demo agents
  proxyAgent = createAgent('web-demo-proxy', {
    listenPort: PROXY_PORT,
    persistence: false,
    dnsServer: '185.204.169.26:3000',
  });

  await proxyAgent.start();
  console.log('✅ Proxy agent ready (mTLS client initialized)');

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🎯 AGENIUM Web Demo running on http://0.0.0.0:${PORT}`);
    console.log(`   Agents: ${Object.keys(DEMO_AGENTS).join(', ')}`);
    console.log(`   Frontend: http://localhost:${PORT}\n`);
  });

  // Graceful shutdown
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      console.log(`\n🛑 ${sig} received, shutting down...`);
      await proxyAgent.stop();
      process.exit(0);
    });
  }
}

main().catch(err => {
  console.error('❌ Startup failed:', err);
  process.exit(1);
});

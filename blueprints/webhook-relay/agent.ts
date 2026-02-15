#!/usr/bin/env npx tsx
/**
 * agent://webhook-relay — Webhook Relay Agent
 *
 * Blueprint 3: Receives webhooks via HTTP, stores events in a ring buffer,
 * and exposes them through the AGENIUM protocol. Bridges the webhook world
 * with the agent:// world.
 *
 * Tools:
 *   events({source?, type?, since?, limit?}) → query stored events
 *   subscribe({source?, type?})              → register event interest
 *   sources({})                              → list sources + stats
 *   replay({eventId})                        → re-deliver an event
 *   health({})                               → relay health stats
 */

import { createAgent } from '../../dist/index.js';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createHmac } from 'crypto';

const PORT = parseInt(process.env.PORT ?? '9012');
const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT ?? String(PORT + 1000));
const DNS_API_KEY = process.env.DNS_API_KEY ?? '';
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? 'localhost';
const DNS_SERVER = process.env.DNS_SERVER ?? '185.204.169.26:3000';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? '';
const MAX_EVENTS = parseInt(process.env.MAX_EVENTS ?? '5000');

// ── Types ────────────────────────────────────────────────────

interface WebhookEvent {
  id: string;
  source: string;
  type: string;
  timestamp: string;
  headers: Record<string, string>;
  body: any;
  ip: string;
}

interface Subscription {
  id: string;
  source?: string;
  type?: string;
  createdAt: string;
}

// ── State ────────────────────────────────────────────────────

let events: WebhookEvent[] = [];
const subscriptions: Subscription[] = [];
let eventCounter = 0;
let eventsPerMinute: number[] = []; // timestamps of recent events

function generateId(): string {
  return `evt_${Date.now().toString(36)}_${(++eventCounter).toString(36)}`;
}

function addEvent(event: WebhookEvent) {
  events.push(event);
  if (events.length > MAX_EVENTS) {
    events = events.slice(-MAX_EVENTS);
  }
  eventsPerMinute.push(Date.now());
  // Keep only last 60s for rate calculation
  const cutoff = Date.now() - 60000;
  eventsPerMinute = eventsPerMinute.filter(t => t > cutoff);
}

function detectEventType(source: string, headers: Record<string, string>, body: any): string {
  // GitHub
  if (headers['x-github-event']) return headers['x-github-event'];
  // Stripe
  if (body?.type && source === 'stripe') return body.type;
  // Generic
  if (body?.event) return String(body.event);
  if (body?.type) return String(body.type);
  if (body?.action) return String(body.action);
  return 'unknown';
}

function verifySignature(payload: string, signature: string): boolean {
  if (!WEBHOOK_SECRET) return true;
  const expected = createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
  return `sha256=${expected}` === signature;
}

function parseTimeRange(since: string): number {
  const m = since.match(/^(\d+)(m|h|d)$/);
  if (!m) return Date.now() - 24 * 3600000;
  const val = parseInt(m[1]);
  const unit = m[2];
  const ms = unit === 'm' ? val * 60000 : unit === 'h' ? val * 3600000 : val * 86400000;
  return Date.now() - ms;
}

// ── HTTP Webhook Listener ────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

const webhookServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // Health endpoint
  if (req.url === '/webhook/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, events: events.length, sources: new Set(events.map(e => e.source)).size }));
    return;
  }

  // Only accept POST to /webhook/:source or /webhook/:source/:type
  if (req.method !== 'POST' || !req.url?.startsWith('/webhook/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'POST /webhook/:source' }));
    return;
  }

  const parts = req.url.replace('/webhook/', '').split('/').filter(Boolean);
  const source = parts[0] ?? 'unknown';
  const explicitType = parts[1];

  try {
    const rawBody = await readBody(req);

    // Signature verification
    const sig = req.headers['x-hub-signature-256'] as string
      ?? req.headers['x-webhook-secret'] as string
      ?? '';
    if (WEBHOOK_SECRET && !verifySignature(rawBody, sig)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid signature' }));
      return;
    }

    // Parse body
    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = { raw: rawBody };
    }

    // Extract headers of interest
    const headers: Record<string, string> = {};
    for (const key of ['x-github-event', 'x-github-delivery', 'x-stripe-event',
      'content-type', 'user-agent', 'x-request-id']) {
      if (req.headers[key]) headers[key] = String(req.headers[key]);
    }

    const type = explicitType ?? detectEventType(source, headers, body);
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      ?? req.socket.remoteAddress ?? 'unknown';

    const event: WebhookEvent = {
      id: generateId(),
      source,
      type,
      timestamp: new Date().toISOString(),
      headers,
      body,
      ip,
    };

    addEvent(event);
    console.log(`📨 ${source}/${type} from ${ip} (${event.id})`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ received: true, id: event.id }));
  } catch (err: any) {
    console.error('❌ Webhook error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// ── Agent ────────────────────────────────────────────────────

const agent = createAgent('webhook-relay', {
  listenPort: PORT,
  dnsServer: DNS_SERVER,
  persistence: true,
  tools: [
    {
      name: 'events',
      description: 'Query recent webhook events with optional filtering',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Filter by source (e.g. "github", "stripe")' },
          type: { type: 'string', description: 'Filter by event type (e.g. "push", "payment_intent.succeeded")' },
          since: { type: 'string', description: 'Time range: "30m", "2h", "1d" (default "24h")' },
          limit: { type: 'number', description: 'Max results (default 50)' },
          search: { type: 'string', description: 'Text search in event body' },
        },
      },
      handler: async (input) => {
        const { source, type, since = '24h', limit = 50, search } = input as any;
        const cutoff = parseTimeRange(since);

        let filtered = events.filter(e => new Date(e.timestamp).getTime() > cutoff);

        if (source) filtered = filtered.filter(e => e.source === source);
        if (type) filtered = filtered.filter(e => e.type === type);
        if (search) {
          const lower = search.toLowerCase();
          filtered = filtered.filter(e =>
            JSON.stringify(e.body).toLowerCase().includes(lower)
          );
        }

        const limited = filtered.slice(-limit);

        return {
          total_matches: filtered.length,
          returned: limited.length,
          events: limited.map(e => ({
            id: e.id,
            source: e.source,
            type: e.type,
            timestamp: e.timestamp,
            ip: e.ip,
            body_preview: JSON.stringify(e.body).slice(0, 200),
          })),
        };
      },
    },
    {
      name: 'subscribe',
      description: 'Register interest in specific event types (for future push notifications)',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source to subscribe to' },
          type: { type: 'string', description: 'Event type to subscribe to' },
        },
      },
      handler: async (input) => {
        const { source, type } = input as any;
        const sub: Subscription = {
          id: `sub_${Date.now().toString(36)}`,
          source,
          type,
          createdAt: new Date().toISOString(),
        };
        subscriptions.push(sub);

        return {
          subscribed: true,
          subscription: sub,
          total_subscriptions: subscriptions.length,
        };
      },
    },
    {
      name: 'sources',
      description: 'List all webhook sources and their statistics',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        const sourceMap = new Map<string, { count: number; types: Set<string>; last: string }>();

        for (const e of events) {
          let s = sourceMap.get(e.source);
          if (!s) {
            s = { count: 0, types: new Set(), last: '' };
            sourceMap.set(e.source, s);
          }
          s.count++;
          s.types.add(e.type);
          s.last = e.timestamp;
        }

        return {
          total_sources: sourceMap.size,
          total_events: events.length,
          sources: Array.from(sourceMap.entries()).map(([name, s]) => ({
            name,
            event_count: s.count,
            event_types: Array.from(s.types),
            last_event: s.last,
          })),
        };
      },
    },
    {
      name: 'replay',
      description: 'Get full details of a specific event by ID',
      inputSchema: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: 'Event ID (e.g. evt_abc123)' },
        },
        required: ['eventId'],
      },
      handler: async (input) => {
        const { eventId } = input as any;
        const event = events.find(e => e.id === eventId);

        if (!event) {
          return { error: `Event ${eventId} not found (may have been evicted from buffer)` };
        }

        return {
          id: event.id,
          source: event.source,
          type: event.type,
          timestamp: event.timestamp,
          ip: event.ip,
          headers: event.headers,
          body: event.body,
        };
      },
    },
    {
      name: 'health',
      description: 'Relay health: events per minute, buffer usage, source count',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        const now = Date.now();
        eventsPerMinute = eventsPerMinute.filter(t => t > now - 60000);

        const last1h = events.filter(e => new Date(e.timestamp).getTime() > now - 3600000);

        return {
          status: 'healthy',
          events_per_minute: eventsPerMinute.length,
          buffer: {
            used: events.length,
            max: MAX_EVENTS,
            usage_pct: parseFloat((events.length / MAX_EVENTS * 100).toFixed(1)),
          },
          last_hour: {
            total_events: last1h.length,
            unique_sources: new Set(last1h.map(e => e.source)).size,
            unique_types: new Set(last1h.map(e => e.type)).size,
          },
          subscriptions: subscriptions.length,
          webhook_endpoint: `http://${PUBLIC_HOST}:${WEBHOOK_PORT}/webhook/:source`,
          uptime_seconds: Math.floor(process.uptime()),
        };
      },
    },
  ],
});

// ── Lifecycle ────────────────────────────────────────────────

agent.on('started', ({ name, port }) => {
  console.log(`\n📡 agent://webhook-relay started on port ${port}`);
  console.log(`   Webhook listener: http://0.0.0.0:${WEBHOOK_PORT}/webhook/:source`);
  console.log(`   Buffer: ${MAX_EVENTS} events max`);
  console.log(`   Tools: events, subscribe, sources, replay, health`);
});

agent.on('connection', ({ sessionId, remoteAgent }) => {
  console.log(`🔗 Connection: ${remoteAgent?.name ?? 'unknown'} (${sessionId})`);
});

agent.on('registered', ({ domain, tools }) => {
  console.log(`✅ DNS registered: ${domain} (${tools} tools)`);
});

agent.on('error', (err) => {
  console.error('❌ Error:', err.message);
});

// ── Start ────────────────────────────────────────────────────

(async () => {
  // Start webhook HTTP listener
  webhookServer.listen(WEBHOOK_PORT, '0.0.0.0', () => {
    console.log(`🌐 Webhook listener on http://0.0.0.0:${WEBHOOK_PORT}`);
  });

  // Start agent
  await agent.start();

  if (DNS_API_KEY) {
    const result = await agent.register(DNS_API_KEY, PUBLIC_HOST);
    if (!result.success) console.warn(`⚠️  DNS registration failed: ${result.error}`);
  } else {
    console.log('ℹ️  No DNS_API_KEY — local-only mode');
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      console.log(`\n🛑 ${sig} — shutting down...`);
      webhookServer.close();
      await agent.stop();
      process.exit(0);
    });
  }
})();

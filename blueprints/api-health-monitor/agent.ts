#!/usr/bin/env npx tsx
/**
 * agent://api-health — API Health Monitor Agent
 *
 * Blueprint 2: Monitors HTTP endpoints for uptime, latency, and errors.
 * Exposes results via AGENIUM protocol so other agents can query health status.
 *
 * Tools:
 *   check({url})                       → instant health probe
 *   status({})                         → all monitored endpoints
 *   history({url, period?})            → latency/uptime history
 *   add({url, name?, interval?})       → add endpoint to monitor
 *   remove({url})                      → remove endpoint
 */

import { createAgent } from '../../dist/index.js';

const PORT = parseInt(process.env.PORT ?? '9011');
const DNS_API_KEY = process.env.DNS_API_KEY ?? '';
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? 'localhost';
const DNS_SERVER = process.env.DNS_SERVER ?? '185.204.169.26:3000';
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL ?? '60') * 1000;
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS ?? '10000');
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY ?? '1440');

// ── Types ────────────────────────────────────────────────────

interface CheckResult {
  timestamp: string;
  status: number | null;
  latencyMs: number;
  ok: boolean;
  error?: string;
}

interface Endpoint {
  url: string;
  name: string;
  interval: number;
  history: CheckResult[];
  lastCheck: CheckResult | null;
  timer: ReturnType<typeof setInterval> | null;
}

const endpoints = new Map<string, Endpoint>();

// ── Default demo endpoints ───────────────────────────────────

const DEFAULT_ENDPOINTS = process.env.ENDPOINTS
  ? process.env.ENDPOINTS.split(',').map(u => u.trim())
  : [
      'https://httpstat.us/200',
      'https://httpstat.us/503',
      'https://jsonplaceholder.typicode.com/posts/1',
    ];

// ── Health Check Logic ───────────────────────────────────────

async function probeUrl(url: string): Promise<CheckResult> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': 'agenium-api-health/1.0' },
      redirect: 'follow',
    });

    clearTimeout(timeout);
    const latencyMs = Date.now() - start;

    return {
      timestamp: new Date().toISOString(),
      status: res.status,
      latencyMs,
      ok: res.status >= 200 && res.status < 400,
    };
  } catch (err: any) {
    return {
      timestamp: new Date().toISOString(),
      status: null,
      latencyMs: Date.now() - start,
      ok: false,
      error: err.name === 'AbortError' ? 'timeout' : err.message,
    };
  }
}

function addHistory(ep: Endpoint, result: CheckResult) {
  ep.history.push(result);
  if (ep.history.length > MAX_HISTORY) {
    ep.history = ep.history.slice(-MAX_HISTORY);
  }
  ep.lastCheck = result;
}

function startMonitoring(ep: Endpoint) {
  if (ep.timer) clearInterval(ep.timer);

  // Initial check
  probeUrl(ep.url).then(r => addHistory(ep, r));

  ep.timer = setInterval(async () => {
    const result = await probeUrl(ep.url);
    addHistory(ep, result);

    if (!result.ok) {
      console.log(`⚠️  ${ep.name} (${ep.url}): ${result.error ?? `HTTP ${result.status}`}`);
    }
  }, ep.interval);
}

function stopMonitoring(ep: Endpoint) {
  if (ep.timer) {
    clearInterval(ep.timer);
    ep.timer = null;
  }
}

function calcUptime(history: CheckResult[]): number {
  if (history.length === 0) return 100;
  const ok = history.filter(h => h.ok).length;
  return parseFloat((ok / history.length * 100).toFixed(2));
}

function calcAvgLatency(history: CheckResult[]): number {
  const valid = history.filter(h => h.ok);
  if (valid.length === 0) return 0;
  const sum = valid.reduce((acc, h) => acc + h.latencyMs, 0);
  return Math.round(sum / valid.length);
}

function parseTimeRange(period: string): number {
  const m = period.match(/^(\d+)(m|h|d)$/);
  if (!m) return 24 * 3600000;
  const val = parseInt(m[1]);
  const unit = m[2];
  return unit === 'm' ? val * 60000 : unit === 'h' ? val * 3600000 : val * 86400000;
}

// ── Agent ────────────────────────────────────────────────────

const agent = createAgent('api-health', {
  listenPort: PORT,
  dnsServer: DNS_SERVER,
  persistence: true,
  tools: [
    {
      name: 'check',
      description: 'Run an immediate health check against a URL',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to check' },
        },
        required: ['url'],
      },
      handler: async (input) => {
        const { url } = input as any;
        const result = await probeUrl(url);

        // If this URL is monitored, add to history
        const ep = endpoints.get(url);
        if (ep) addHistory(ep, result);

        return {
          url,
          ...result,
          monitored: !!ep,
        };
      },
    },
    {
      name: 'status',
      description: 'Get current status of all monitored endpoints',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        const results = [];
        for (const [url, ep] of endpoints) {
          results.push({
            url,
            name: ep.name,
            status: ep.lastCheck?.ok ? 'up' : ep.lastCheck ? 'down' : 'pending',
            last_status_code: ep.lastCheck?.status ?? null,
            last_latency_ms: ep.lastCheck?.latencyMs ?? null,
            last_check: ep.lastCheck?.timestamp ?? null,
            last_error: ep.lastCheck?.error ?? null,
            uptime_pct: calcUptime(ep.history),
            avg_latency_ms: calcAvgLatency(ep.history),
            checks_total: ep.history.length,
          });
        }

        const allUp = results.every(r => r.status === 'up');
        const anyDown = results.some(r => r.status === 'down');

        return {
          overall: anyDown ? 'degraded' : allUp ? 'healthy' : 'unknown',
          endpoints_count: results.length,
          endpoints: results,
          checked_at: new Date().toISOString(),
        };
      },
    },
    {
      name: 'history',
      description: 'Get uptime and latency history for an endpoint',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Endpoint URL' },
          period: { type: 'string', description: 'Time period: "1h", "6h", "24h" (default "24h")' },
        },
        required: ['url'],
      },
      handler: async (input) => {
        const { url, period = '24h' } = input as any;
        const ep = endpoints.get(url);
        if (!ep) {
          return { error: `Not monitoring ${url}. Use 'add' to start monitoring.` };
        }

        const cutoff = Date.now() - parseTimeRange(period);
        const filtered = ep.history.filter(
          h => new Date(h.timestamp).getTime() > cutoff
        );

        return {
          url,
          name: ep.name,
          period,
          uptime_pct: calcUptime(filtered),
          avg_latency_ms: calcAvgLatency(filtered),
          min_latency_ms: filtered.length
            ? Math.min(...filtered.filter(h => h.ok).map(h => h.latencyMs))
            : null,
          max_latency_ms: filtered.length
            ? Math.max(...filtered.filter(h => h.ok).map(h => h.latencyMs))
            : null,
          total_checks: filtered.length,
          failures: filtered.filter(h => !h.ok).length,
          entries: filtered.slice(-100).map(h => ({
            time: h.timestamp,
            ok: h.ok,
            status: h.status,
            ms: h.latencyMs,
            ...(h.error && { error: h.error }),
          })),
        };
      },
    },
    {
      name: 'add',
      description: 'Add a new endpoint to monitor',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to monitor' },
          name: { type: 'string', description: 'Human-friendly name (defaults to hostname)' },
          interval: { type: 'number', description: 'Check interval in seconds (default 60)' },
        },
        required: ['url'],
      },
      handler: async (input) => {
        const { url, name, interval = 60 } = input as any;

        if (endpoints.has(url)) {
          return { error: `Already monitoring ${url}` };
        }

        const hostname = new URL(url).hostname;
        const ep: Endpoint = {
          url,
          name: name ?? hostname,
          interval: interval * 1000,
          history: [],
          lastCheck: null,
          timer: null,
        };

        endpoints.set(url, ep);
        startMonitoring(ep);

        console.log(`➕ Monitoring: ${ep.name} (${url}) every ${interval}s`);

        return {
          added: true,
          url,
          name: ep.name,
          interval_seconds: interval,
          total_monitored: endpoints.size,
        };
      },
    },
    {
      name: 'remove',
      description: 'Remove an endpoint from monitoring',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to stop monitoring' },
        },
        required: ['url'],
      },
      handler: async (input) => {
        const { url } = input as any;
        const ep = endpoints.get(url);

        if (!ep) {
          return { error: `Not monitoring ${url}` };
        }

        stopMonitoring(ep);
        endpoints.delete(url);

        console.log(`➖ Removed: ${ep.name} (${url})`);

        return {
          removed: true,
          url,
          name: ep.name,
          total_monitored: endpoints.size,
        };
      },
    },
  ],
});

// ── Lifecycle ────────────────────────────────────────────────

agent.on('started', ({ name, port }) => {
  console.log(`\n🏥 agent://api-health started on port ${port}`);
  console.log(`   Monitoring ${endpoints.size} endpoints`);
  console.log(`   Check interval: ${CHECK_INTERVAL / 1000}s`);
  console.log(`   Tools: check, status, history, add, remove`);
});

agent.on('connection', ({ sessionId, remoteAgent }) => {
  console.log(`📡 Connection: ${remoteAgent?.name ?? 'unknown'} (${sessionId})`);
});

agent.on('registered', ({ domain, tools }) => {
  console.log(`✅ DNS registered: ${domain} (${tools} tools)`);
});

agent.on('error', (err) => {
  console.error('❌ Error:', err.message);
});

// ── Start ────────────────────────────────────────────────────

// Initialize default endpoints
for (const url of DEFAULT_ENDPOINTS) {
  try {
    const hostname = new URL(url).hostname;
    const ep: Endpoint = {
      url,
      name: hostname,
      interval: CHECK_INTERVAL,
      history: [],
      lastCheck: null,
      timer: null,
    };
    endpoints.set(url, ep);
    startMonitoring(ep);
  } catch (err: any) {
    console.warn(`⚠️  Skipping invalid URL: ${url} — ${err.message}`);
  }
}

(async () => {
  await agent.start();

  if (DNS_API_KEY) {
    const result = await agent.register(DNS_API_KEY, PUBLIC_HOST);
    if (!result.success) console.warn(`⚠️  DNS registration failed: ${result.error}`);
  } else {
    console.log('ℹ️  No DNS_API_KEY — local-only mode');
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      console.log(`\n🛑 ${sig} — stopping monitors...`);
      for (const ep of endpoints.values()) stopMonitoring(ep);
      await agent.stop();
      process.exit(0);
    });
  }
})();

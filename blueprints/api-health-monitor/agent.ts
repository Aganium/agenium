#!/usr/bin/env npx tsx
/**
 * agent://api-monitor — API Health Monitor Agent
 *
 * Blueprint 2: A practical agent that monitors HTTP endpoints,
 * tracks response times, detects outages, and exposes health
 * data via the AGENIUM protocol.
 *
 * Tools:
 *   status({})                          → current status of all endpoints
 *   history({endpoint, period?})        → response time & uptime history
 *   incidents({active?})                → detected outages and slow responses
 *   add({name, url, method?, ...})      → add endpoint to monitor
 *   remove({name})                      → remove endpoint from monitoring
 */

import { createAgent } from '../../dist/index.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const PORT = parseInt(process.env.PORT ?? '9011');
const DNS_API_KEY = process.env.DNS_API_KEY ?? '';
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? 'localhost';
const DNS_SERVER = process.env.DNS_SERVER ?? '185.204.169.26:3000';
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL ?? '60') * 1000;
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS ?? '10000');
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY ?? '1440');
const INCIDENT_THRESHOLD = parseInt(process.env.INCIDENT_THRESHOLD ?? '3');
const ENDPOINTS_FILE = process.env.ENDPOINTS_FILE
  ?? new URL('./endpoints.json', import.meta.url).pathname;

// ── Types ────────────────────────────────────────────────────

interface EndpointConfig {
  name: string;
  url: string;
  method?: string;
  expectedStatus?: number;
  headers?: Record<string, string>;
  body?: string;
}

interface CheckResult {
  timestamp: number;
  status: number | null;
  responseMs: number;
  ok: boolean;
  error?: string;
}

interface Incident {
  id: string;
  endpoint: string;
  startedAt: number;
  resolvedAt: number | null;
  failureCount: number;
  lastError: string;
}

interface EndpointState {
  config: EndpointConfig;
  history: CheckResult[];
  consecutiveFailures: number;
  currentIncident: Incident | null;
}

// ── State ────────────────────────────────────────────────────

const endpoints = new Map<string, EndpointState>();
const closedIncidents: Incident[] = [];
let checkTimer: ReturnType<typeof setInterval> | null = null;

// ── Load Endpoints ───────────────────────────────────────────

function loadEndpoints(): void {
  try {
    const raw = readFileSync(ENDPOINTS_FILE, 'utf-8');
    const configs: EndpointConfig[] = JSON.parse(raw);
    for (const cfg of configs) {
      if (!endpoints.has(cfg.name)) {
        endpoints.set(cfg.name, {
          config: cfg,
          history: [],
          consecutiveFailures: 0,
          currentIncident: null,
        });
      }
    }
    console.log(`📋 Loaded ${configs.length} endpoints from ${ENDPOINTS_FILE}`);
  } catch (err: any) {
    console.warn(`⚠️  Could not load ${ENDPOINTS_FILE}: ${err.message}`);
  }
}

function saveEndpoints(): void {
  try {
    const configs = [...endpoints.values()].map(s => s.config);
    writeFileSync(ENDPOINTS_FILE, JSON.stringify(configs, null, 2));
  } catch { /* best effort */ }
}

// ── HTTP Probe ───────────────────────────────────────────────

async function probeEndpoint(cfg: EndpointConfig): Promise<CheckResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(cfg.url, {
      method: cfg.method ?? 'GET',
      headers: cfg.headers,
      body: cfg.body,
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    const responseMs = Date.now() - start;
    const expected = cfg.expectedStatus ?? 200;
    const ok = resp.status === expected;
    return {
      timestamp: start,
      status: resp.status,
      responseMs,
      ok,
      ...(!ok && { error: `Expected ${expected}, got ${resp.status}` }),
    };
  } catch (err: any) {
    clearTimeout(timer);
    return {
      timestamp: start,
      status: null,
      responseMs: Date.now() - start,
      ok: false,
      error: err.name === 'AbortError' ? `Timeout (${TIMEOUT_MS}ms)` : err.message,
    };
  }
}

// ── Check Cycle ──────────────────────────────────────────────

async function runChecks(): Promise<void> {
  const promises = [...endpoints.entries()].map(async ([name, state]) => {
    const result = await probeEndpoint(state.config);
    state.history.push(result);
    if (state.history.length > MAX_HISTORY) {
      state.history = state.history.slice(-MAX_HISTORY);
    }

    if (result.ok) {
      if (state.consecutiveFailures > 0) {
        console.log(`✅ ${name} — recovered (was down for ${state.consecutiveFailures} checks)`);
      }
      if (state.currentIncident) {
        state.currentIncident.resolvedAt = Date.now();
        closedIncidents.push(state.currentIncident);
        if (closedIncidents.length > 100) closedIncidents.shift();
        state.currentIncident = null;
      }
      state.consecutiveFailures = 0;
    } else {
      state.consecutiveFailures++;
      if (state.consecutiveFailures >= INCIDENT_THRESHOLD && !state.currentIncident) {
        state.currentIncident = {
          id: `inc_${Date.now().toString(36)}`,
          endpoint: name,
          startedAt: Date.now(),
          resolvedAt: null,
          failureCount: state.consecutiveFailures,
          lastError: result.error ?? 'Unknown',
        };
        console.log(`🚨 INCIDENT: ${name} — ${result.error} (${state.consecutiveFailures} consecutive failures)`);
      } else if (state.currentIncident) {
        state.currentIncident.failureCount = state.consecutiveFailures;
        state.currentIncident.lastError = result.error ?? 'Unknown';
      }
      if (state.consecutiveFailures <= INCIDENT_THRESHOLD) {
        console.log(`⚠️  ${name} — ${result.error} (${state.consecutiveFailures}/${INCIDENT_THRESHOLD})`);
      }
    }
  });
  await Promise.allSettled(promises);
}

// ── Helpers ──────────────────────────────────────────────────

function parseTimeRange(period: string): number {
  const match = period.match(/^(\d+)(m|h|d)$/);
  if (!match) return 3600000; // default 1h
  const val = parseInt(match[1]);
  const unit = match[2];
  return unit === 'm' ? val * 60000 : unit === 'h' ? val * 3600000 : val * 86400000;
}

function calcUptime(history: CheckResult[]): number {
  if (history.length === 0) return 100;
  const ok = history.filter(h => h.ok).length;
  return parseFloat((ok / history.length * 100).toFixed(2));
}

function calcAvgResponse(history: CheckResult[]): number {
  const successful = history.filter(h => h.ok);
  if (successful.length === 0) return 0;
  const sum = successful.reduce((acc, h) => acc + h.responseMs, 0);
  return Math.round(sum / successful.length);
}

function calcP95Response(history: CheckResult[]): number {
  const times = history.filter(h => h.ok).map(h => h.responseMs).sort((a, b) => a - b);
  if (times.length === 0) return 0;
  const idx = Math.floor(times.length * 0.95);
  return times[Math.min(idx, times.length - 1)];
}

// ── Agent ────────────────────────────────────────────────────

const agent = createAgent('api-monitor', {
  listenPort: PORT,
  dnsServer: DNS_SERVER,
  persistence: true,
  tools: [
    {
      name: 'status',
      description: 'Get current status of all monitored endpoints',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        const results = [...endpoints.entries()].map(([name, state]) => {
          const last = state.history[state.history.length - 1];
          const recent = state.history.slice(-60); // last ~1h at 1min interval
          return {
            name,
            url: state.config.url,
            status: state.currentIncident ? 'down' : last?.ok ? 'up' : 'degraded',
            last_check: last ? {
              timestamp: new Date(last.timestamp).toISOString(),
              status_code: last.status,
              response_ms: last.responseMs,
              ok: last.ok,
              error: last.error,
            } : null,
            uptime_1h_pct: calcUptime(recent),
            avg_response_ms: calcAvgResponse(recent),
            consecutive_failures: state.consecutiveFailures,
            incident: state.currentIncident ? {
              id: state.currentIncident.id,
              started: new Date(state.currentIncident.startedAt).toISOString(),
              failures: state.currentIncident.failureCount,
              last_error: state.currentIncident.lastError,
            } : null,
          };
        });

        const allUp = results.every(r => r.status === 'up');
        const anyDown = results.some(r => r.status === 'down');

        return {
          overall: anyDown ? 'incident' : allUp ? 'healthy' : 'degraded',
          endpoints_count: results.length,
          endpoints: results,
          checked_at: new Date().toISOString(),
        };
      },
    },
    {
      name: 'history',
      description: 'Get response time and availability history for an endpoint',
      inputSchema: {
        type: 'object',
        properties: {
          endpoint: { type: 'string', description: 'Endpoint name' },
          period: { type: 'string', description: 'Time period: "30m", "6h", "24h" (default "1h")' },
        },
        required: ['endpoint'],
      },
      handler: async (input) => {
        const { endpoint, period = '1h' } = input as any;
        const state = endpoints.get(endpoint);
        if (!state) {
          return { error: `Endpoint "${endpoint}" not found`, available: [...endpoints.keys()] };
        }

        const rangeMs = parseTimeRange(period);
        const cutoff = Date.now() - rangeMs;
        const filtered = state.history.filter(h => h.timestamp > cutoff);

        return {
          endpoint,
          period,
          data_points: filtered.length,
          uptime_pct: calcUptime(filtered),
          avg_response_ms: calcAvgResponse(filtered),
          p95_response_ms: calcP95Response(filtered),
          min_response_ms: filtered.length > 0
            ? Math.min(...filtered.filter(h => h.ok).map(h => h.responseMs)) : 0,
          max_response_ms: filtered.length > 0
            ? Math.max(...filtered.filter(h => h.ok).map(h => h.responseMs)) : 0,
          errors: filtered.filter(h => !h.ok).length,
          checks: filtered.map(h => ({
            time: new Date(h.timestamp).toISOString(),
            status: h.status,
            ms: h.responseMs,
            ok: h.ok,
            ...(h.error && { error: h.error }),
          })),
        };
      },
    },
    {
      name: 'incidents',
      description: 'List detected incidents (outages, failures)',
      inputSchema: {
        type: 'object',
        properties: {
          active: { type: 'boolean', description: 'Only show active (unresolved) incidents' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
      },
      handler: async (input) => {
        const { active = false, limit = 20 } = input as any;
        const activeIncidents = [...endpoints.values()]
          .filter(s => s.currentIncident)
          .map(s => ({
            ...s.currentIncident!,
            startedAt: new Date(s.currentIncident!.startedAt).toISOString(),
            duration_min: Math.round((Date.now() - s.currentIncident!.startedAt) / 60000),
          }));

        if (active) {
          return {
            active_count: activeIncidents.length,
            incidents: activeIncidents.slice(0, limit),
          };
        }

        const resolved = closedIncidents.map(inc => ({
          ...inc,
          startedAt: new Date(inc.startedAt).toISOString(),
          resolvedAt: inc.resolvedAt ? new Date(inc.resolvedAt).toISOString() : null,
          duration_min: inc.resolvedAt
            ? Math.round((inc.resolvedAt - (typeof inc.startedAt === 'number' ? inc.startedAt : new Date(inc.startedAt).getTime())) / 60000)
            : null,
        }));

        const all = [...activeIncidents, ...resolved]
          .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
          .slice(0, limit);

        return {
          total: all.length,
          active: activeIncidents.length,
          resolved: resolved.length,
          incidents: all,
        };
      },
    },
    {
      name: 'add',
      description: 'Add a new endpoint to monitor',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Unique endpoint name' },
          url: { type: 'string', description: 'HTTP(S) URL to monitor' },
          method: { type: 'string', description: 'HTTP method (default GET)' },
          expectedStatus: { type: 'number', description: 'Expected status code (default 200)' },
          headers: { type: 'object', description: 'Request headers' },
        },
        required: ['name', 'url'],
      },
      handler: async (input) => {
        const { name, url, method, expectedStatus, headers } = input as any;
        if (endpoints.has(name)) {
          return { error: `Endpoint "${name}" already exists` };
        }
        const config: EndpointConfig = { name, url, method, expectedStatus, headers };
        endpoints.set(name, {
          config,
          history: [],
          consecutiveFailures: 0,
          currentIncident: null,
        });
        saveEndpoints();

        // Run an immediate check
        const state = endpoints.get(name)!;
        const result = await probeEndpoint(config);
        state.history.push(result);

        return {
          added: true,
          name,
          url,
          first_check: {
            status: result.status,
            response_ms: result.responseMs,
            ok: result.ok,
            error: result.error,
          },
        };
      },
    },
    {
      name: 'remove',
      description: 'Remove an endpoint from monitoring',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Endpoint name to remove' },
        },
        required: ['name'],
      },
      handler: async (input) => {
        const { name } = input as any;
        if (!endpoints.has(name)) {
          return { error: `Endpoint "${name}" not found`, available: [...endpoints.keys()] };
        }
        endpoints.delete(name);
        saveEndpoints();
        return { removed: true, name, remaining: [...endpoints.keys()] };
      },
    },
  ],
});

// ── Lifecycle ────────────────────────────────────────────────

agent.on('started', ({ name, port }) => {
  console.log(`\n📡 agent://api-monitor started on port ${port}`);
  console.log(`   Endpoints: ${endpoints.size}`);
  console.log(`   Check interval: ${CHECK_INTERVAL / 1000}s`);
  console.log(`   Incident threshold: ${INCIDENT_THRESHOLD} consecutive failures`);
  console.log(`   Tools: status, history, incidents, add, remove`);
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

loadEndpoints();

(async () => {
  await agent.start();

  // Initial check
  console.log('🔄 Running initial health checks...');
  await runChecks();
  for (const [name, state] of endpoints) {
    const last = state.history[state.history.length - 1];
    const icon = last?.ok ? '✅' : '❌';
    console.log(`   ${icon} ${name}: ${last?.status ?? 'ERR'} (${last?.responseMs}ms)`);
  }

  // Schedule periodic checks
  checkTimer = setInterval(runChecks, CHECK_INTERVAL);

  if (DNS_API_KEY) {
    const result = await agent.register(DNS_API_KEY, PUBLIC_HOST);
    if (!result.success) console.warn(`⚠️  DNS registration failed: ${result.error}`);
  } else {
    console.log('ℹ️  No DNS_API_KEY — local-only mode');
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      console.log(`\n🛑 ${sig} — shutting down...`);
      if (checkTimer) clearInterval(checkTimer);
      await agent.stop();
      process.exit(0);
    });
  }
})();

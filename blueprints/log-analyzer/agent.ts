#!/usr/bin/env npx tsx
/**
 * agent://log-analyzer — Server Log Analysis Agent
 *
 * Blueprint 1: A practical agent that parses, searches, and
 * summarizes server logs via the AGENIUM protocol.
 *
 * Tools:
 *   search({pattern, since?, severity?}) → matching log entries
 *   stats({period?})                     → error rates, top IPs, status codes
 *   tail({lines?})                       → recent log entries
 *   health({})                           → anomaly detection summary
 */

import { createAgent } from '../../dist/index.js';
import { readFileSync, statSync, watchFile } from 'fs';

const PORT = parseInt(process.env.PORT ?? '9010');
const DNS_API_KEY = process.env.DNS_API_KEY ?? '';
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? 'localhost';
const DNS_SERVER = process.env.DNS_SERVER ?? '185.204.169.26:3000';
const LOG_PATH = process.env.LOG_PATH ?? new URL('./sample.log', import.meta.url).pathname;
const LOG_FORMAT = process.env.LOG_FORMAT ?? 'auto';
const MAX_LINES = parseInt(process.env.MAX_LINES ?? '10000');

// ── Log Storage ──────────────────────────────────────────────

interface LogEntry {
  raw: string;
  timestamp: Date;
  severity: 'info' | 'warn' | 'error' | 'debug' | 'unknown';
  ip?: string;
  status?: number;
  method?: string;
  path?: string;
  message: string;
}

let entries: LogEntry[] = [];
let lastSize = 0;

// ── Parsers ──────────────────────────────────────────────────

const NGINX_RE = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+) [^"]*" (\d{3}) (\d+)/;
const SYSLOG_RE = /^(\w{3}\s+\d+\s+[\d:]+)\s+\S+\s+(\S+?)(?:\[\d+\])?: (.+)/;
const JSON_LINE_RE = /^\s*\{/;

function detectFormat(line: string): string {
  if (LOG_FORMAT !== 'auto') return LOG_FORMAT;
  if (NGINX_RE.test(line)) return 'nginx';
  if (JSON_LINE_RE.test(line)) return 'json';
  if (SYSLOG_RE.test(line)) return 'syslog';
  return 'plain';
}

function parseLine(line: string): LogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const format = detectFormat(trimmed);

  if (format === 'nginx') {
    const m = trimmed.match(NGINX_RE);
    if (m) {
      const status = parseInt(m[5]);
      return {
        raw: trimmed,
        timestamp: new Date(m[2].replace(':', ' ')),
        severity: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
        ip: m[1],
        status,
        method: m[3],
        path: m[4],
        message: trimmed,
      };
    }
  }

  if (format === 'json') {
    try {
      const obj = JSON.parse(trimmed);
      return {
        raw: trimmed,
        timestamp: obj.timestamp ? new Date(obj.timestamp) : new Date(),
        severity: normalizeSeverity(obj.level ?? obj.severity ?? 'info'),
        ip: obj.ip ?? obj.remote_addr,
        status: obj.status ? parseInt(obj.status) : undefined,
        method: obj.method,
        path: obj.path ?? obj.url,
        message: obj.message ?? obj.msg ?? trimmed,
      };
    } catch { /* fall through to plain */ }
  }

  if (format === 'syslog') {
    const m = trimmed.match(SYSLOG_RE);
    if (m) {
      const msg = m[3];
      return {
        raw: trimmed,
        timestamp: new Date(m[1] + ' ' + new Date().getFullYear()),
        severity: msg.toLowerCase().includes('error') ? 'error'
          : msg.toLowerCase().includes('warn') ? 'warn' : 'info',
        message: msg,
      };
    }
  }

  // Plain text fallback
  return {
    raw: trimmed,
    timestamp: new Date(),
    severity: /error|fail|crit/i.test(trimmed) ? 'error'
      : /warn/i.test(trimmed) ? 'warn' : 'info',
    message: trimmed,
  };
}

function normalizeSeverity(s: string): LogEntry['severity'] {
  const lower = s.toLowerCase();
  if (['error', 'err', 'crit', 'critical', 'fatal', 'emerg'].includes(lower)) return 'error';
  if (['warn', 'warning'].includes(lower)) return 'warn';
  if (['debug', 'trace'].includes(lower)) return 'debug';
  if (['info', 'notice'].includes(lower)) return 'info';
  return 'unknown';
}

// ── File Loading ─────────────────────────────────────────────

function loadLogFile() {
  try {
    const stat = statSync(LOG_PATH);
    const content = readFileSync(LOG_PATH, 'utf-8');
    const lines = content.split('\n');
    entries = [];
    for (const line of lines.slice(-MAX_LINES)) {
      const entry = parseLine(line);
      if (entry) entries.push(entry);
    }
    lastSize = stat.size;
    console.log(`📄 Loaded ${entries.length} log entries from ${LOG_PATH}`);
  } catch (err: any) {
    console.warn(`⚠️  Could not read ${LOG_PATH}: ${err.message}`);
  }
}

function reloadIfChanged() {
  try {
    const stat = statSync(LOG_PATH);
    if (stat.size !== lastSize) loadLogFile();
  } catch { /* ignore */ }
}

// ── Helpers ──────────────────────────────────────────────────

function parseTimeRange(since: string): Date {
  const now = Date.now();
  const match = since.match(/^(\d+)(m|h|d)$/);
  if (!match) return new Date(since); // try ISO parse
  const val = parseInt(match[1]);
  const unit = match[2];
  const ms = unit === 'm' ? val * 60000 : unit === 'h' ? val * 3600000 : val * 86400000;
  return new Date(now - ms);
}

function filterEntries(opts: { pattern?: string; since?: string; severity?: string }): LogEntry[] {
  reloadIfChanged();
  let result = [...entries];

  if (opts.since) {
    const cutoff = parseTimeRange(opts.since);
    result = result.filter(e => e.timestamp >= cutoff);
  }

  if (opts.severity) {
    const sev = normalizeSeverity(opts.severity);
    result = result.filter(e => e.severity === sev);
  }

  if (opts.pattern) {
    try {
      const re = new RegExp(opts.pattern, 'i');
      result = result.filter(e => re.test(e.raw));
    } catch {
      const lower = opts.pattern.toLowerCase();
      result = result.filter(e => e.raw.toLowerCase().includes(lower));
    }
  }

  return result;
}

// ── Agent ────────────────────────────────────────────────────

const agent = createAgent('log-analyzer', {
  listenPort: PORT,
  dnsServer: DNS_SERVER,
  persistence: true,
  tools: [
    {
      name: 'search',
      description: 'Search log entries by pattern, time range, or severity',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex or text pattern to search for' },
          since: { type: 'string', description: 'Time range: "30m", "2h", "1d", or ISO date' },
          severity: { type: 'string', enum: ['info', 'warn', 'error', 'debug'], description: 'Filter by severity' },
          limit: { type: 'number', description: 'Max results (default 50)' },
        },
      },
      handler: async (input) => {
        const { pattern, since, severity, limit = 50 } = input as any;
        const results = filterEntries({ pattern, since, severity });
        const limited = results.slice(-limit);
        return {
          total_matches: results.length,
          returned: limited.length,
          entries: limited.map(e => ({
            timestamp: e.timestamp.toISOString(),
            severity: e.severity,
            message: e.message,
            ...(e.ip && { ip: e.ip }),
            ...(e.status && { status: e.status }),
            ...(e.path && { path: e.path }),
          })),
        };
      },
    },
    {
      name: 'stats',
      description: 'Get log statistics: error rates, top IPs, status code distribution',
      inputSchema: {
        type: 'object',
        properties: {
          period: { type: 'string', description: 'Time period: "1h", "24h", "7d" (default "24h")' },
        },
      },
      handler: async (input) => {
        const { period = '24h' } = input as any;
        const filtered = filterEntries({ since: period });
        const total = filtered.length;
        if (total === 0) return { period, total: 0, message: 'No log entries in this period' };

        // Severity breakdown
        const severity: Record<string, number> = {};
        const statusCodes: Record<string, number> = {};
        const ipCounts: Record<string, number> = {};
        const pathCounts: Record<string, number> = {};

        for (const e of filtered) {
          severity[e.severity] = (severity[e.severity] ?? 0) + 1;
          if (e.status) statusCodes[e.status] = (statusCodes[e.status] ?? 0) + 1;
          if (e.ip) ipCounts[e.ip] = (ipCounts[e.ip] ?? 0) + 1;
          if (e.path) pathCounts[e.path] = (pathCounts[e.path] ?? 0) + 1;
        }

        const topIPs = Object.entries(ipCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([ip, count]) => ({ ip, count }));

        const topPaths = Object.entries(pathCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([path, count]) => ({ path, count }));

        const errorRate = total > 0 ? ((severity['error'] ?? 0) / total * 100).toFixed(1) : '0';

        return {
          period,
          total,
          severity,
          error_rate_pct: parseFloat(errorRate),
          status_codes: statusCodes,
          top_ips: topIPs,
          top_paths: topPaths,
          time_range: {
            oldest: filtered[0]?.timestamp.toISOString(),
            newest: filtered[filtered.length - 1]?.timestamp.toISOString(),
          },
        };
      },
    },
    {
      name: 'tail',
      description: 'Get the most recent log entries',
      inputSchema: {
        type: 'object',
        properties: {
          lines: { type: 'number', description: 'Number of lines (default 20, max 200)' },
          severity: { type: 'string', description: 'Filter by severity' },
        },
      },
      handler: async (input) => {
        const { lines = 20, severity } = input as any;
        reloadIfChanged();
        const count = Math.min(lines, 200);
        let result = severity
          ? entries.filter(e => e.severity === normalizeSeverity(severity))
          : entries;
        result = result.slice(-count);
        return {
          count: result.length,
          entries: result.map(e => ({
            timestamp: e.timestamp.toISOString(),
            severity: e.severity,
            message: e.message,
            ...(e.status && { status: e.status }),
          })),
        };
      },
    },
    {
      name: 'health',
      description: 'Quick health summary with anomaly detection',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        reloadIfChanged();
        const now = Date.now();
        const last1h = entries.filter(e => e.timestamp.getTime() > now - 3600000);
        const last5m = entries.filter(e => e.timestamp.getTime() > now - 300000);
        const prev1h = entries.filter(e => {
          const t = e.timestamp.getTime();
          return t > now - 7200000 && t <= now - 3600000;
        });

        const errors1h = last1h.filter(e => e.severity === 'error').length;
        const errorsPrev = prev1h.filter(e => e.severity === 'error').length;
        const errors5m = last5m.filter(e => e.severity === 'error').length;

        const anomalies: string[] = [];
        if (errorsPrev > 0 && errors1h > errorsPrev * 2) {
          anomalies.push(`Error spike: ${errors1h} errors in last hour (was ${errorsPrev} prev hour)`);
        }
        if (errors5m > 10) {
          anomalies.push(`High error rate: ${errors5m} errors in last 5 minutes`);
        }
        if (last1h.length === 0 && entries.length > 0) {
          anomalies.push('No new log entries in the last hour — possible logging failure');
        }

        const status5xx = last1h.filter(e => e.status && e.status >= 500).length;
        if (status5xx > 5) {
          anomalies.push(`${status5xx} server errors (5xx) in last hour`);
        }

        return {
          status: anomalies.length === 0 ? 'healthy' : 'warning',
          log_file: LOG_PATH,
          total_entries: entries.length,
          last_hour: {
            total: last1h.length,
            errors: errors1h,
            warnings: last1h.filter(e => e.severity === 'warn').length,
          },
          last_5min: {
            total: last5m.length,
            errors: errors5m,
          },
          anomalies,
          last_entry: entries.length > 0
            ? entries[entries.length - 1].timestamp.toISOString()
            : null,
        };
      },
    },
  ],
});

// ── Lifecycle ────────────────────────────────────────────────

agent.on('started', ({ name, port }) => {
  console.log(`\n🔍 agent://log-analyzer started on port ${port}`);
  console.log(`   Log file: ${LOG_PATH}`);
  console.log(`   Format: ${LOG_FORMAT}`);
  console.log(`   Tools: search, stats, tail, health`);
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

loadLogFile();

// Watch for file changes
watchFile(LOG_PATH, { interval: 5000 }, () => {
  reloadIfChanged();
});

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
      console.log(`\n🛑 ${sig} — shutting down...`);
      await agent.stop();
      process.exit(0);
    });
  }
})();

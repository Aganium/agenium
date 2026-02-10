/**
 * Bug Report Server - Prometheus Metrics
 * Lightweight metrics collection (no external deps)
 */

// ============================================================================
// Counter Class
// ============================================================================

class Counter {
  private value = 0;
  
  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labels: string[] = []
  ) {}

  inc(labels: Record<string, string> = {}, delta = 1): void {
    this.value += delta;
  }

  get(): number {
    return this.value;
  }

  toPrometheus(): string {
    return `# HELP ${this.name} ${this.help}
# TYPE ${this.name} counter
${this.name} ${this.value}`;
  }
}

class LabeledCounter {
  private values = new Map<string, number>();
  
  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: string[]
  ) {}

  inc(labels: Record<string, string>, delta = 1): void {
    const key = this.labelNames.map(l => labels[l] ?? '').join('|');
    this.values.set(key, (this.values.get(key) ?? 0) + delta);
  }

  toPrometheus(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.values) {
      const labelValues = key.split('|');
      const labelStr = this.labelNames.map((n, i) => `${n}="${labelValues[i]}"`).join(',');
      lines.push(`${this.name}{${labelStr}} ${value}`);
    }
    return lines.join('\n');
  }
}

// ============================================================================
// Gauge Class
// ============================================================================

class Gauge {
  private value = 0;
  
  constructor(
    public readonly name: string,
    public readonly help: string
  ) {}

  set(value: number): void {
    this.value = value;
  }

  inc(delta = 1): void {
    this.value += delta;
  }

  dec(delta = 1): void {
    this.value -= delta;
  }

  get(): number {
    return this.value;
  }

  toPrometheus(): string {
    return `# HELP ${this.name} ${this.help}
# TYPE ${this.name} gauge
${this.name} ${this.value}`;
  }
}

// ============================================================================
// Server Metrics
// ============================================================================

export const serverMetrics = {
  // Counters
  reportsIngested: new Counter(
    'bug_reports_ingested_total',
    'Total number of bug reports ingested'
  ),
  reportsDeduplicated: new Counter(
    'bug_reports_dedup_total',
    'Total number of deduplicated reports (not new)'
  ),
  rateLimited: new Counter(
    'bug_reports_rate_limited_total',
    'Total number of rate-limited requests'
  ),
  authFailed: new Counter(
    'bug_reports_auth_failed_total',
    'Total number of authentication failures'
  ),
  dbWriteFailed: new Counter(
    'bug_reports_db_write_fail_total',
    'Total number of database write failures'
  ),
  requestsTotal: new LabeledCounter(
    'bug_reports_http_requests_total',
    'Total HTTP requests',
    ['method', 'path', 'status']
  ),

  // Gauges
  uniqueFingerprints: new Gauge(
    'bug_reports_unique_fingerprints',
    'Current number of unique fingerprints in database'
  ),
  activeAgents: new Gauge(
    'bug_reports_active_agents',
    'Number of agents seen in last 24h'
  ),
  uptimeSeconds: new Gauge(
    'bug_reports_server_uptime_seconds',
    'Server uptime in seconds'
  ),
};

const startTime = Date.now();

export function getMetricsText(): string {
  // Update uptime
  serverMetrics.uptimeSeconds.set(Math.floor((Date.now() - startTime) / 1000));

  const metrics = [
    serverMetrics.reportsIngested,
    serverMetrics.reportsDeduplicated,
    serverMetrics.rateLimited,
    serverMetrics.authFailed,
    serverMetrics.dbWriteFailed,
    serverMetrics.requestsTotal,
    serverMetrics.uniqueFingerprints,
    serverMetrics.activeAgents,
    serverMetrics.uptimeSeconds,
  ];

  return metrics.map(m => m.toPrometheus()).join('\n\n') + '\n';
}

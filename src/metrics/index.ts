/**
 * Agenium Runtime Metrics
 * Prometheus-format metrics collection (non-blocking)
 */

import { now } from '../core/types.js';

// ============================================================================
// Metric Types
// ============================================================================

class Counter {
  private value = 0;
  
  constructor(
    public readonly name: string,
    public readonly help: string
  ) {}

  inc(delta = 1): void {
    this.value += delta;
  }

  get(): number {
    return this.value;
  }

  toPrometheus(): string {
    return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} counter\n${this.name} ${this.value}`;
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

  get(labels: Record<string, string>): number {
    const key = this.labelNames.map(l => labels[l] ?? '').join('|');
    return this.values.get(key) ?? 0;
  }

  toPrometheus(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.values) {
      const labelValues = key.split('|');
      const labelStr = this.labelNames.map((n, i) => `${n}="${labelValues[i]}"`).join(',');
      lines.push(`${this.name}{${labelStr}} ${value}`);
    }
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    }
    return lines.join('\n');
  }
}

class Gauge {
  private value = 0;
  private provider: (() => number) | null = null;
  
  constructor(
    public readonly name: string,
    public readonly help: string
  ) {}

  set(value: number): void {
    this.value = value;
  }

  setProvider(fn: () => number): void {
    this.provider = fn;
  }

  inc(delta = 1): void {
    this.value += delta;
  }

  dec(delta = 1): void {
    this.value -= delta;
  }

  get(): number {
    return this.provider ? this.provider() : this.value;
  }

  toPrometheus(): string {
    const val = this.get();
    return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} gauge\n${this.name} ${val}`;
  }
}

// ============================================================================
// Agenium Metrics Registry
// ============================================================================

export const metrics = {
  // Session metrics
  sessionsActive: new Gauge(
    'agenium_sessions_active',
    'Number of active sessions'
  ),
  sessionsSuspended: new Gauge(
    'agenium_sessions_suspended',
    'Number of suspended sessions'
  ),
  sessionsResumeFailTotal: new Counter(
    'agenium_sessions_resume_fail_total',
    'Total number of session resume failures'
  ),
  sessionsCreatedTotal: new Counter(
    'agenium_sessions_created_total',
    'Total number of sessions created'
  ),

  // Outbox metrics
  outboxPending: new Gauge(
    'agenium_outbox_pending',
    'Number of messages pending in outbox'
  ),
  outboxInflight: new Gauge(
    'agenium_outbox_inflight',
    'Number of messages currently being sent'
  ),
  outboxOldestAgeMs: new Gauge(
    'agenium_outbox_oldest_age_ms',
    'Age of oldest pending message in milliseconds'
  ),
  outboxRetryTotal: new Counter(
    'agenium_outbox_retry_total',
    'Total number of message retries'
  ),
  outboxSentTotal: new Counter(
    'agenium_outbox_sent_total',
    'Total number of messages successfully sent'
  ),
  outboxDroppedTotal: new Counter(
    'agenium_outbox_dropped_total',
    'Total number of messages dropped after max retries'
  ),

  // DNS metrics
  dnsLookupTotal: new LabeledCounter(
    'agenium_dns_lookup_total',
    'Total DNS lookups',
    ['result']
  ),
  dnsCacheHits: new Counter(
    'agenium_dns_cache_hits_total',
    'Total DNS cache hits'
  ),
  dnsCacheMisses: new Counter(
    'agenium_dns_cache_misses_total',
    'Total DNS cache misses'
  ),
  dnsCacheSize: new Gauge(
    'agenium_dns_cache_size',
    'Current DNS cache size'
  ),

  // Bug reporter metrics
  bugReportsSentTotal: new LabeledCounter(
    'agenium_bug_reports_sent_total',
    'Total bug reports sent',
    ['result']
  ),
  bugReportsQueueDepth: new Gauge(
    'agenium_bug_reports_queue_depth',
    'Current bug report queue depth'
  ),
  bugReportsLastUploadAt: new Gauge(
    'agenium_bug_reports_last_upload_timestamp',
    'Timestamp of last successful upload'
  ),

  // Transport metrics
  connectionsActive: new Gauge(
    'agenium_connections_active',
    'Number of active connections'
  ),
  handshakesTotal: new LabeledCounter(
    'agenium_handshakes_total',
    'Total handshakes attempted',
    ['result']
  ),

  // General
  uptimeSeconds: new Gauge(
    'agenium_uptime_seconds',
    'Agent uptime in seconds'
  ),
};

const startTime = now();

// ============================================================================
// Health Status
// ============================================================================

export interface HealthStatus {
  ok: boolean;
  version: string;
  uptime: number;
  timestamp: number;
  sessions: {
    active: number;
    suspended: number;
  };
  outbox: {
    pending: number;
    inflight: number;
    oldestPendingAgeMs: number;
  };
  dnsCache: {
    hits: number;
    misses: number;
    size: number;
  };
  bugReporter: {
    queueDepth: number;
    lastUploadAt: number;
    failedUploads: number;
  };
}

let healthProvider: (() => Partial<HealthStatus>) | null = null;

export function setHealthProvider(provider: () => Partial<HealthStatus>): void {
  healthProvider = provider;
}

export function getHealth(version: string): HealthStatus {
  const custom = healthProvider?.() ?? {};
  
  return {
    ok: true,
    version,
    uptime: Math.floor((now() - startTime) / 1000),
    timestamp: now(),
    sessions: {
      active: metrics.sessionsActive.get(),
      suspended: metrics.sessionsSuspended.get(),
      ...custom.sessions,
    },
    outbox: {
      pending: metrics.outboxPending.get(),
      inflight: metrics.outboxInflight.get(),
      oldestPendingAgeMs: metrics.outboxOldestAgeMs.get(),
      ...custom.outbox,
    },
    dnsCache: {
      hits: metrics.dnsCacheHits.get(),
      misses: metrics.dnsCacheMisses.get(),
      size: metrics.dnsCacheSize.get(),
      ...custom.dnsCache,
    },
    bugReporter: {
      queueDepth: metrics.bugReportsQueueDepth.get(),
      lastUploadAt: metrics.bugReportsLastUploadAt.get(),
      failedUploads: metrics.bugReportsSentTotal.get({ result: 'failure' }),
      ...custom.bugReporter,
    },
  };
}

// ============================================================================
// Prometheus Export
// ============================================================================

export function getMetricsText(): string {
  // Update uptime
  metrics.uptimeSeconds.set(Math.floor((now() - startTime) / 1000));

  const allMetrics = [
    metrics.sessionsActive,
    metrics.sessionsSuspended,
    metrics.sessionsResumeFailTotal,
    metrics.sessionsCreatedTotal,
    metrics.outboxPending,
    metrics.outboxInflight,
    metrics.outboxOldestAgeMs,
    metrics.outboxRetryTotal,
    metrics.outboxSentTotal,
    metrics.outboxDroppedTotal,
    metrics.dnsLookupTotal,
    metrics.dnsCacheHits,
    metrics.dnsCacheMisses,
    metrics.dnsCacheSize,
    metrics.bugReportsSentTotal,
    metrics.bugReportsQueueDepth,
    metrics.bugReportsLastUploadAt,
    metrics.connectionsActive,
    metrics.handshakesTotal,
    metrics.uptimeSeconds,
  ];

  return allMetrics.map(m => m.toPrometheus()).join('\n\n') + '\n';
}

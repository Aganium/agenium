/**
 * Agenium Configuration
 * Centralized timeout and limit settings
 */

export interface TimeoutConfig {
  /** DNS lookup timeout (ms) */
  dnsLookupMs: number;
  /** TLS handshake timeout (ms) */
  handshakeMs: number;
  /** Request/response timeout (ms) */
  requestMs: number;
  /** Bug report upload timeout (ms) */
  bugReportUploadMs: number;
  /** Connection idle timeout (ms) */
  connectionIdleMs: number;
}

export interface PoolConfig {
  /** Max connections per remote agent */
  maxConnectionsPerAgent: number;
  /** Max concurrent streams per connection (HTTP/2) */
  maxStreamsPerConnection: number;
}

export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit */
  failureThreshold: number;
  /** Time to wait before half-open retry (ms) */
  resetTimeoutMs: number;
  /** Number of successes in half-open to close circuit */
  successThreshold: number;
}

export interface AgeniumConfig {
  timeouts: TimeoutConfig;
  pool: PoolConfig;
  circuitBreaker: CircuitBreakerConfig;
}

export const DEFAULT_CONFIG: AgeniumConfig = {
  timeouts: {
    dnsLookupMs: 10_000,
    handshakeMs: 10_000,
    requestMs: 30_000,
    bugReportUploadMs: 5_000,
    connectionIdleMs: 60_000,
  },
  pool: {
    maxConnectionsPerAgent: 4,
    maxStreamsPerConnection: 100,
  },
  circuitBreaker: {
    failureThreshold: 5,
    resetTimeoutMs: 30_000,
    successThreshold: 2,
  },
};

// Environment variable overrides
function loadFromEnv(): Partial<AgeniumConfig> {
  const config: Partial<AgeniumConfig> = {};

  if (process.env.AGENIUM_DNS_TIMEOUT_MS) {
    config.timeouts = { ...DEFAULT_CONFIG.timeouts, dnsLookupMs: parseInt(process.env.AGENIUM_DNS_TIMEOUT_MS) };
  }
  if (process.env.AGENIUM_HANDSHAKE_TIMEOUT_MS) {
    config.timeouts = { ...config.timeouts ?? DEFAULT_CONFIG.timeouts, handshakeMs: parseInt(process.env.AGENIUM_HANDSHAKE_TIMEOUT_MS) };
  }
  if (process.env.AGENIUM_REQUEST_TIMEOUT_MS) {
    config.timeouts = { ...config.timeouts ?? DEFAULT_CONFIG.timeouts, requestMs: parseInt(process.env.AGENIUM_REQUEST_TIMEOUT_MS) };
  }
  if (process.env.AGENIUM_MAX_CONNECTIONS_PER_AGENT) {
    config.pool = { ...DEFAULT_CONFIG.pool, maxConnectionsPerAgent: parseInt(process.env.AGENIUM_MAX_CONNECTIONS_PER_AGENT) };
  }
  if (process.env.AGENIUM_CIRCUIT_BREAKER_THRESHOLD) {
    config.circuitBreaker = { ...DEFAULT_CONFIG.circuitBreaker, failureThreshold: parseInt(process.env.AGENIUM_CIRCUIT_BREAKER_THRESHOLD) };
  }

  return config;
}

let config: AgeniumConfig = { ...DEFAULT_CONFIG, ...loadFromEnv() };

export function getConfig(): AgeniumConfig {
  return config;
}

export function setConfig(newConfig: Partial<AgeniumConfig>): void {
  config = {
    timeouts: { ...config.timeouts, ...newConfig.timeouts },
    pool: { ...config.pool, ...newConfig.pool },
    circuitBreaker: { ...config.circuitBreaker, ...newConfig.circuitBreaker },
  };
}

/**
 * Simple Circuit Breaker implementation
 */
export class CircuitBreaker {
  private failures = 0;
  private successes = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private lastFailureTime = 0;
  private config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG.circuitBreaker, ...config };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > this.config.resetTimeoutMs) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is open');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.successes++;
      if (this.successes >= this.config.successThreshold) {
        this.state = 'closed';
        this.failures = 0;
        this.successes = 0;
      }
    } else {
      this.failures = 0;
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.config.failureThreshold) {
      this.state = 'open';
    }
  }

  getState(): 'closed' | 'open' | 'half-open' {
    return this.state;
  }

  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.successes = 0;
  }
}

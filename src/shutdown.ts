/**
 * Agenium Shutdown Manager
 * Coordinates graceful shutdown of all components
 */

import { getBugReporter } from './bug-report/reporter.js';
import { MetricsServer } from './metrics/server.js';

export interface ShutdownConfig {
  /** Max time to wait for bug report queue flush (ms) */
  bugReportFlushTimeoutMs: number;
  /** Max time to wait for outbox flush (ms) */
  outboxFlushTimeoutMs: number;
  /** Max time to wait for connections to close (ms) */
  connectionCloseTimeoutMs: number;
}

const DEFAULT_CONFIG: ShutdownConfig = {
  bugReportFlushTimeoutMs: 2000,
  outboxFlushTimeoutMs: 3000,
  connectionCloseTimeoutMs: 5000,
};

type ShutdownHook = () => Promise<void>;

class ShutdownManager {
  private hooks: Array<{ name: string; fn: ShutdownHook; priority: number }> = [];
  private isShuttingDown = false;
  private config: ShutdownConfig;

  constructor(config: Partial<ShutdownConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register a shutdown hook
   * Lower priority = runs first (0-100)
   */
  register(name: string, fn: ShutdownHook, priority: number = 50): void {
    this.hooks.push({ name, fn, priority });
    this.hooks.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Execute graceful shutdown
   */
  async shutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) {
      console.log('[Shutdown] Already in progress, forcing exit...');
      process.exit(1);
    }
    this.isShuttingDown = true;

    console.log(`\n[Shutdown] Received ${signal}, starting graceful shutdown...`);
    const startTime = Date.now();

    for (const hook of this.hooks) {
      try {
        console.log(`[Shutdown] Running: ${hook.name}...`);
        await Promise.race([
          hook.fn(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout')), this.config.connectionCloseTimeoutMs)
          ),
        ]);
        console.log(`[Shutdown] Done: ${hook.name}`);
      } catch (err) {
        console.error(`[Shutdown] Error in ${hook.name}:`, err);
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(`[Shutdown] Complete in ${elapsed}ms`);
  }

  /**
   * Install signal handlers
   */
  installHandlers(): void {
    const handler = (signal: string) => {
      this.shutdown(signal).then(() => process.exit(0)).catch(() => process.exit(1));
    };

    process.on('SIGINT', () => handler('SIGINT'));
    process.on('SIGTERM', () => handler('SIGTERM'));
  }

  get isInProgress(): boolean {
    return this.isShuttingDown;
  }
}

// Singleton instance
let instance: ShutdownManager | null = null;

export function getShutdownManager(config?: Partial<ShutdownConfig>): ShutdownManager {
  if (!instance) {
    instance = new ShutdownManager(config);
  }
  return instance;
}

/**
 * Register standard Agenium shutdown hooks
 */
export function registerStandardHooks(options: {
  metricsServer?: MetricsServer;
  onFlushOutbox?: () => Promise<void>;
  onCloseConnections?: () => Promise<void>;
  onCloseDatabase?: () => Promise<void>;
}): void {
  const manager = getShutdownManager();

  // Priority 10: Stop accepting new work
  if (options.metricsServer) {
    manager.register('metrics-server', () => options.metricsServer!.stop(), 10);
  }

  // Priority 20: Flush bug reports (bounded)
  manager.register('bug-reporter', async () => {
    const reporter = getBugReporter();
    const stats = reporter.getStats();
    if (stats.queueSize > 0) {
      console.log(`[Shutdown] Flushing ${stats.queueSize} bug reports...`);
      // The reporter's processBatch is already called, we just wait a bit
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    reporter.stop();
  }, 20);

  // Priority 30: Flush outbox
  if (options.onFlushOutbox) {
    manager.register('outbox', options.onFlushOutbox, 30);
  }

  // Priority 40: Close connections
  if (options.onCloseConnections) {
    manager.register('connections', options.onCloseConnections, 40);
  }

  // Priority 50: Close database
  if (options.onCloseDatabase) {
    manager.register('database', options.onCloseDatabase, 50);
  }
}

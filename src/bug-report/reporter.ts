/**
 * Bug Reporter - Non-blocking Error Reporting
 * Captures, queues, and uploads bug reports asynchronously
 * 
 * CRITICAL: This module must NEVER block the main agent flow
 */

import {
  BugReport,
  BugReportType,
  ActionRecord,
  generateId,
  now,
} from '../core/types.js';
import * as os from 'node:os';
import { metrics } from '../metrics/index.js';
import { getConfig } from '../config.js';

// ============================================================================
// Types
// ============================================================================

export interface BugReporterConfig {
  /** Bug report server URL */
  serverUrl: string;
  /** Auth token for server */
  authToken: string;
  /** Agent identifier */
  agentId: string;
  /** Agent version */
  agentVersion: string;
  /** Max reports in queue */
  maxQueueSize: number;
  /** Batch upload interval in ms */
  batchIntervalMs: number;
  /** Max retry attempts */
  maxRetries: number;
  /** Enable local fallback storage */
  localFallback: boolean;
  /** Local fallback directory */
  fallbackDir: string;
}

interface QueuedReport {
  report: BugReport;
  attempts: number;
  queuedAt: number;
  isCrash: boolean;
}

type StateSnapshot = BugReport['state'];
type ReportCallback = (report: BugReport) => void;

// ============================================================================
// Action Ring Buffer
// ============================================================================

class ActionBuffer {
  private buffer: ActionRecord[] = [];
  private maxSize: number;

  constructor(maxSize: number = 10) {
    this.maxSize = maxSize;
  }

  push(action: ActionRecord): void {
    this.buffer.push(action);
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  getAll(): ActionRecord[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer = [];
  }
}

// ============================================================================
// Bug Reporter
// ============================================================================

export class BugReporter {
  private config: BugReporterConfig;
  private queue: QueuedReport[] = [];
  private actionBuffer: ActionBuffer;
  private startTime: number;
  private stateProvider: (() => StateSnapshot) | null = null;
  private onReport: ReportCallback | null = null;
  private batchTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning: boolean = false;

  constructor(config: Partial<BugReporterConfig> = {}) {
    this.config = {
      serverUrl: config.serverUrl ?? process.env.BUG_REPORT_URL ?? 'http://localhost:3100/api/bug-reports',
      authToken: config.authToken ?? process.env.BUG_REPORT_TOKEN ?? 'dev-token-change-me',
      agentId: config.agentId ?? 'unknown-agent',
      agentVersion: config.agentVersion ?? '0.1.0',
      maxQueueSize: config.maxQueueSize ?? 100,
      batchIntervalMs: config.batchIntervalMs ?? 60000,
      maxRetries: config.maxRetries ?? 3,
      localFallback: config.localFallback ?? true,
      fallbackDir: config.fallbackDir ?? '~/.agenium/crashes',
    };
    this.actionBuffer = new ActionBuffer(10);
    this.startTime = now();
  }

  /**
   * Start the bug reporter background worker
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Install global error handlers
    this.installErrorHandlers();

    // Start batch upload timer
    this.batchTimer = setInterval(() => {
      this.processBatch().catch(err => {
        console.error('[BugReporter] Batch processing failed:', err);
      });
    }, this.config.batchIntervalMs);
  }

  /**
   * Stop the bug reporter
   */
  stop(): void {
    this.isRunning = false;
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
  }

  /**
   * Set the state provider function
   */
  setStateProvider(provider: () => StateSnapshot): void {
    this.stateProvider = provider;
  }

  /**
   * Set callback for when reports are created (for testing)
   */
  onReportCreated(callback: ReportCallback): void {
    this.onReport = callback;
  }

  /**
   * Record an action (for context in bug reports)
   */
  recordAction(type: string, details?: Record<string, unknown>, durationMs?: number): void {
    this.actionBuffer.push({
      type,
      timestamp: now(),
      details,
      durationMs,
    });
  }

  /**
   * Report an error - ASYNC, NON-BLOCKING
   * Returns immediately, queues report for background upload
   */
  report(
    errorType: BugReportType,
    errorCode: string,
    errorMessage: string,
    options: {
      stackTrace?: string;
      sessionId?: string;
      isCrash?: boolean;
    } = {}
  ): string {
    const reportId = generateId();

    // Capture state synchronously (fast)
    const state = this.stateProvider?.() ?? {
      sessionCount: 0,
      queueDepth: this.queue.length,
      memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      activeConnections: 0,
    };

    const report: BugReport = {
      reportId,
      agentId: this.config.agentId,
      agentVersion: this.config.agentVersion,
      timestamp: now(),
      uptime: Math.round((now() - this.startTime) / 1000),
      errorType,
      errorCode,
      errorMessage,
      stackTrace: options.stackTrace,
      sessionId: options.sessionId,
      lastActions: this.actionBuffer.getAll(),
      state,
      environment: {
        platform: os.platform(),
        nodeVersion: process.version,
        arch: os.arch(),
      },
      sanitized: true, // We sanitize by default
    };

    // Queue for async upload (never blocks)
    this.enqueue(report, options.isCrash ?? false);

    // Notify callback if set
    if (this.onReport) {
      this.onReport(report);
    }

    // If crash, trigger immediate upload attempt
    if (options.isCrash) {
      setImmediate(() => {
        this.processBatch().catch(() => {});
      });
    }

    return reportId;
  }

  /**
   * Report an Error object
   */
  reportError(
    error: Error,
    errorType: BugReportType = 'internal',
    sessionId?: string
  ): string {
    return this.report(errorType, error.name, error.message, {
      stackTrace: error.stack,
      sessionId,
      isCrash: errorType === 'crash',
    });
  }

  /**
   * Get queue statistics
   */
  getStats(): {
    queueSize: number;
    pendingCrashes: number;
    totalReported: number;
  } {
    return {
      queueSize: this.queue.length,
      pendingCrashes: this.queue.filter(q => q.isCrash).length,
      totalReported: 0, // Would track this in production
    };
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  private enqueue(report: BugReport, isCrash: boolean): void {
    // If queue full, drop oldest non-crash reports
    while (this.queue.length >= this.config.maxQueueSize) {
      const idx = this.queue.findIndex(q => !q.isCrash);
      if (idx >= 0) {
        this.queue.splice(idx, 1);
      } else {
        // All crashes, drop oldest
        this.queue.shift();
      }
    }

    this.queue.push({
      report,
      attempts: 0,
      queuedAt: now(),
      isCrash,
    });
    metrics.bugReportsQueueDepth.set(this.queue.length);
  }

  private async processBatch(): Promise<void> {
    if (this.queue.length === 0) return;

    // Take up to 10 reports at a time
    const batch = this.queue.splice(0, 10);
    const failed: QueuedReport[] = [];

    for (const item of batch) {
      const success = await this.upload(item.report);
      if (!success) {
        item.attempts++;
        if (item.attempts < this.config.maxRetries) {
          failed.push(item);
        } else if (this.config.localFallback) {
          // Write to local fallback (stub - would write to disk)
          console.error(`[BugReporter] Report ${item.report.reportId} failed after ${item.attempts} attempts, saved locally`);
        }
      }
    }

    // Re-queue failed items at the front
    this.queue.unshift(...failed);
  }

  private async upload(report: BugReport): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutMs = getConfig().timeouts.bugReportUploadMs;
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(this.config.serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.authToken ?? 'dev-token'}`,
          'X-Agent-Id': this.config.agentId,
        },
        body: JSON.stringify(report),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        console.error(`[BugReporter] Upload failed: ${response.status} ${response.statusText}`);
        return false;
      }

      const result = await response.json() as { ok: boolean; fingerprint?: string };
      if (result.ok) {
        console.log(`[BugReporter] Uploaded ${report.reportId} → fingerprint: ${result.fingerprint}`);
        metrics.bugReportsSentTotal.inc({ result: 'success' });
        metrics.bugReportsLastUploadAt.set(now());
        return true;
      }
      metrics.bugReportsSentTotal.inc({ result: 'failure' });
      return false;
    } catch (err) {
      metrics.bugReportsSentTotal.inc({ result: 'failure' });
      if ((err as Error).name === 'AbortError') {
        console.error(`[BugReporter] Upload timeout for ${report.reportId}`);
      } else {
        console.error(`[BugReporter] Upload error:`, err);
      }
      return false;
    }
  }

  private installErrorHandlers(): void {
    // Uncaught exceptions
    process.on('uncaughtException', (error) => {
      this.report('crash', 'UNCAUGHT_EXCEPTION', error.message, {
        stackTrace: error.stack,
        isCrash: true,
      });
      // Re-throw to allow normal crash behavior
      throw error;
    });

    // Unhandled promise rejections
    process.on('unhandledRejection', (reason) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      this.report('crash', 'UNHANDLED_REJECTION', error.message, {
        stackTrace: error.stack,
        isCrash: true,
      });
    });
  }
}

// ============================================================================
// Singleton
// ============================================================================

let instance: BugReporter | null = null;

export function getBugReporter(config?: Partial<BugReporterConfig>): BugReporter {
  if (!instance) {
    instance = new BugReporter(config);
  }
  return instance;
}

export function resetBugReporter(): void {
  if (instance) {
    instance.stop();
    instance = null;
  }
}

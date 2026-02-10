/**
 * Outbox Manager - Reliable Message Delivery
 * At-least-once delivery with exponential backoff
 */

import { EventEmitter } from 'node:events';
import { DatabaseManager, OutboxMessage } from './database.js';
import { getBugReporter } from '../bug-report/reporter.js';
import { now, generateId } from '../core/types.js';
import { AnyFrame, MessageType } from '../protocol/types.js';

// ============================================================================
// Types
// ============================================================================

export interface OutboxConfig {
  /** Max in-flight messages per session */
  maxInFlight: number;
  /** Max retry attempts */
  maxAttempts: number;
  /** Retry delays: [1s, 5s, 20s] */
  retryDelaysMs: number[];
  /** Process interval */
  processIntervalMs: number;
}

export type SendFunction = (sessionId: string, frame: AnyFrame) => Promise<{
  success: boolean;
  error?: string;
  isRetryable?: boolean;
}>;

// Retryable error patterns
const RETRYABLE_ERRORS = [
  'TIMEOUT',
  'NETWORK',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  '5',  // 5xx errors
];

const NON_RETRYABLE_ERRORS = [
  'UNKNOWN_METHOD',
  'HANDLER_ERROR',
  'INVALID_FRAME',
  'INVALID_PARAMS',
  '4',  // 4xx errors (except timeout)
];

// ============================================================================
// Outbox Manager
// ============================================================================

export class OutboxManager extends EventEmitter {
  private db: DatabaseManager;
  private config: OutboxConfig;
  private sendFn: SendFunction | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning: boolean = false;
  private processing: Set<string> = new Set();  // msgIds currently being processed

  constructor(db: DatabaseManager, config: Partial<OutboxConfig> = {}) {
    super();
    this.db = db;
    this.config = {
      maxInFlight: config.maxInFlight ?? 10,
      maxAttempts: config.maxAttempts ?? 3,
      retryDelaysMs: config.retryDelaysMs ?? [1000, 5000, 20000],
      processIntervalMs: config.processIntervalMs ?? 1000,
    };
  }

  /**
   * Set the send function
   */
  setSendFunction(fn: SendFunction): void {
    this.sendFn = fn;
  }

  /**
   * Start processing outbox
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.timer = setInterval(() => {
      this.processOutbox().catch(err => {
        getBugReporter().reportError(err as Error, 'internal');
      });
    }, this.config.processIntervalMs);
  }

  /**
   * Stop processing
   */
  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Enqueue a message for reliable delivery
   */
  enqueue(sessionId: string, frame: AnyFrame): { 
    success: boolean; 
    msgId?: string; 
    error?: string 
  } {
    // Check in-flight limit
    const inFlight = this.db.getInFlightCount(sessionId);
    if (inFlight >= this.config.maxInFlight) {
      getBugReporter().report('protocol', 'QUEUE_FULL', 
        `Max in-flight (${this.config.maxInFlight}) exceeded for session ${sessionId}`);
      return { success: false, error: 'QUEUE_FULL' };
    }

    const msgId = frame.messageId;

    // Persist to outbox
    this.db.enqueueMessage({
      msgId,
      sessionId,
      type: frame.type,
      frameJson: JSON.stringify(frame),
      priority: frame.type === MessageType.REQUEST ? 0 : 1,  // Requests higher priority
      createdAt: now(),
    });

    getBugReporter().recordAction('outbox_enqueue', {
      msgId,
      sessionId,
      type: frame.type,
    });

    // Trigger immediate processing
    setImmediate(() => this.processOutbox().catch(() => {}));

    return { success: true, msgId };
  }

  /**
   * Handle ACK for a message
   */
  ack(msgId: string): void {
    this.db.ackMessage(msgId);
    this.emit('acked', { msgId });
    
    getBugReporter().recordAction('outbox_ack', { msgId });
  }

  /**
   * Process pending messages
   */
  private async processOutbox(): Promise<void> {
    if (!this.sendFn || !this.isRunning) return;

    const pending = this.db.getPendingMessages(20);

    for (const msg of pending) {
      // Skip if already being processed
      if (this.processing.has(msg.msgId)) continue;

      this.processing.add(msg.msgId);

      try {
        await this.processMessage(msg);
      } finally {
        this.processing.delete(msg.msgId);
      }
    }
  }

  /**
   * Process a single message
   */
  private async processMessage(msg: OutboxMessage): Promise<void> {
    const traceId = generateId().slice(0, 8);
    
    getBugReporter().recordAction('outbox_send', {
      msgId: msg.msgId,
      sessionId: msg.sessionId,
      type: msg.type,
      attempt: msg.attempts + 1,
      traceId,
    });

    try {
      const frame = JSON.parse(msg.frameJson) as AnyFrame;
      const result = await this.sendFn!(msg.sessionId, frame);

      if (result.success) {
        // Mark as SENT (awaiting ACK for EVENTs, or done for implicit ACK)
        if (msg.type === MessageType.REQUEST) {
          // REQUEST is implicitly ACKed by RESPONSE
          this.db.updateMessageStatus(msg.msgId, 'SENT');
        } else if (msg.type === MessageType.EVENT) {
          // EVENT needs explicit ACK
          this.db.updateMessageStatus(msg.msgId, 'SENT');
        } else {
          // RESPONSE/ERROR are fire-and-forget from outbox perspective
          this.db.updateMessageStatus(msg.msgId, 'ACKED');
        }

        this.emit('sent', { msgId: msg.msgId, sessionId: msg.sessionId });
      } else {
        throw new Error(result.error ?? 'Send failed');
      }
    } catch (err) {
      const error = err as Error;
      const isRetryable = this.isRetryableError(error.message);
      const attemptsMade = msg.attempts + 1;

      if (isRetryable && attemptsMade < this.config.maxAttempts) {
        // Schedule retry
        const delayIndex = Math.min(attemptsMade - 1, this.config.retryDelaysMs.length - 1);
        const delay = this.config.retryDelaysMs[delayIndex];
        const jitter = delay * 0.2 * Math.random();
        const nextAttempt = now() + delay + jitter;

        this.db.updateMessageStatus(msg.msgId, 'PENDING', nextAttempt, error.message);

        this.emit('retry_scheduled', {
          msgId: msg.msgId,
          attempt: attemptsMade,
          nextAttemptAt: nextAttempt,
          error: error.message,
          traceId,
        });
      } else {
        // Mark as failed
        this.db.updateMessageStatus(msg.msgId, 'FAILED', now(), error.message);

        // Report delivery failure
        getBugReporter().report('connection', 'DELIVERY_FAILED', 
          `Message ${msg.msgId} failed after ${attemptsMade} attempts: ${error.message}`, {
            sessionId: msg.sessionId,
          });

        this.emit('failed', {
          msgId: msg.msgId,
          sessionId: msg.sessionId,
          attempts: attemptsMade,
          error: error.message,
          traceId,
        });
      }
    }
  }

  /**
   * Check if an error is retryable
   */
  private isRetryableError(errorMessage: string): boolean {
    const upper = errorMessage.toUpperCase();
    
    // Check non-retryable first
    for (const pattern of NON_RETRYABLE_ERRORS) {
      if (upper.includes(pattern)) {
        return false;
      }
    }

    // Check retryable patterns
    for (const pattern of RETRYABLE_ERRORS) {
      if (upper.includes(pattern)) {
        return true;
      }
    }

    // Default to retryable for unknown errors
    return true;
  }

  /**
   * Get outbox stats
   */
  getStats(): {
    pending: number;
    inProgress: number;
    failed: number;
  } {
    const dbStats = this.db.getStats();
    return {
      pending: dbStats.outboxPending,
      inProgress: this.processing.size,
      failed: dbStats.outboxFailed,
    };
  }

  /**
   * Prune old messages
   */
  prune(): number {
    return this.db.pruneOutbox();
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createOutboxManager(
  db: DatabaseManager,
  config?: Partial<OutboxConfig>
): OutboxManager {
  return new OutboxManager(db, config);
}

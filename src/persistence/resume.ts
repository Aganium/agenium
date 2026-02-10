/**
 * Session Resume Manager
 * Handles automatic session resumption on startup
 */

import { EventEmitter } from 'node:events';
import { DatabaseManager, PersistedSession } from './database.js';
import { getBugReporter } from '../bug-report/reporter.js';
import { now, generateId } from '../core/types.js';

// ============================================================================
// Types
// ============================================================================

export interface ResumeConfig {
  /** Maximum concurrent resume attempts */
  maxConcurrent: number;
  /** Initial backoff delay in ms */
  initialBackoffMs: number;
  /** Maximum backoff delay in ms */
  maxBackoffMs: number;
  /** Backoff multiplier */
  backoffMultiplier: number;
  /** Jitter factor (0-1) */
  jitterFactor: number;
}

export interface ResumeAttempt {
  sessionId: string;
  remoteAgentName: string;
  attempts: number;
  lastAttemptAt: number;
  nextAttemptAt: number;
  lastError?: string;
}

export type ResumeFunction = (session: PersistedSession) => Promise<boolean>;

// ============================================================================
// Resume Manager
// ============================================================================

export class ResumeManager extends EventEmitter {
  private db: DatabaseManager;
  private config: ResumeConfig;
  private pendingResumes: Map<string, ResumeAttempt> = new Map();
  private resumeFn: ResumeFunction | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning: boolean = false;

  constructor(db: DatabaseManager, config: Partial<ResumeConfig> = {}) {
    super();
    this.db = db;
    this.config = {
      maxConcurrent: config.maxConcurrent ?? 3,
      initialBackoffMs: config.initialBackoffMs ?? 1000,
      maxBackoffMs: config.maxBackoffMs ?? 60000,
      backoffMultiplier: config.backoffMultiplier ?? 2,
      jitterFactor: config.jitterFactor ?? 0.2,
    };
  }

  /**
   * Set the resume function
   */
  setResumeFunction(fn: ResumeFunction): void {
    this.resumeFn = fn;
  }

  /**
   * Start the resume manager
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Initial resume on startup
    this.loadAndQueueSessions();

    // Periodic retry check
    this.timer = setInterval(() => {
      this.processRetries().catch(err => {
        getBugReporter().reportError(err as Error, 'internal');
      });
    }, 5000);  // Check every 5 seconds
  }

  /**
   * Stop the resume manager
   */
  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Load sessions and queue for resume
   */
  private loadAndQueueSessions(): void {
    try {
      const sessions = this.db.loadResumableSessions();
      
      for (const session of sessions) {
        // Mark as SUSPENDED in DB
        this.db.updateSessionState(session.sessionId, 'SUSPENDED');
        
        // Queue for resume
        this.pendingResumes.set(session.sessionId, {
          sessionId: session.sessionId,
          remoteAgentName: session.remoteAgentName,
          attempts: 0,
          lastAttemptAt: 0,
          nextAttemptAt: now(),  // Immediate first attempt
        });
      }

      if (sessions.length > 0) {
        getBugReporter().recordAction('resume_queued', { count: sessions.length });
        this.emit('queued', { count: sessions.length });
        
        // Trigger immediate processing
        this.processRetries().catch(() => {});
      }
    } catch (err) {
      getBugReporter().reportError(err as Error, 'internal');
    }
  }

  /**
   * Process pending resume attempts
   */
  private async processRetries(): Promise<void> {
    if (!this.resumeFn || !this.isRunning) return;

    const currentTime = now();
    const ready: ResumeAttempt[] = [];

    // Find sessions ready to retry
    for (const attempt of this.pendingResumes.values()) {
      if (attempt.nextAttemptAt <= currentTime) {
        ready.push(attempt);
      }
    }

    // Limit concurrent attempts
    const toProcess = ready.slice(0, this.config.maxConcurrent);

    // Process in parallel (limited)
    await Promise.all(toProcess.map(attempt => this.attemptResume(attempt)));
  }

  /**
   * Attempt to resume a single session
   */
  private async attemptResume(attempt: ResumeAttempt): Promise<void> {
    const traceId = generateId().slice(0, 8);
    
    getBugReporter().recordAction('resume_attempt', {
      sessionId: attempt.sessionId,
      remoteAgent: attempt.remoteAgentName,
      attempt: attempt.attempts + 1,
      traceId,
    });

    try {
      // Get session from DB
      const session = this.db.getSession(attempt.sessionId);
      if (!session) {
        this.pendingResumes.delete(attempt.sessionId);
        return;
      }

      // Attempt resume
      const success = await this.resumeFn!(session);

      if (success) {
        // Success - remove from pending
        this.pendingResumes.delete(attempt.sessionId);
        this.db.updateSessionState(attempt.sessionId, 'ACTIVE');
        
        this.emit('resumed', {
          sessionId: attempt.sessionId,
          remoteAgent: attempt.remoteAgentName,
          attempts: attempt.attempts + 1,
        });

        getBugReporter().recordAction('resume_success', {
          sessionId: attempt.sessionId,
          attempts: attempt.attempts + 1,
          traceId,
        });
      } else {
        throw new Error('Resume returned false');
      }
    } catch (err) {
      const error = err as Error;
      
      // Update attempt info
      attempt.attempts++;
      attempt.lastAttemptAt = now();
      attempt.lastError = error.message;
      attempt.nextAttemptAt = this.calculateNextAttempt(attempt.attempts);

      // Update DB
      this.db.updateSessionState(
        attempt.sessionId, 
        'SUSPENDED', 
        error.message.slice(0, 100)
      );

      // Report failure
      getBugReporter().report('connection', 'RESUME_FAILED', error.message, {
        sessionId: attempt.sessionId,
      });

      this.emit('resume_failed', {
        sessionId: attempt.sessionId,
        remoteAgent: attempt.remoteAgentName,
        attempts: attempt.attempts,
        error: error.message,
        nextAttemptAt: attempt.nextAttemptAt,
        traceId,
      });
    }
  }

  /**
   * Calculate next attempt time with exponential backoff + jitter
   */
  private calculateNextAttempt(attempts: number): number {
    const baseDelay = this.config.initialBackoffMs * 
                      Math.pow(this.config.backoffMultiplier, attempts - 1);
    const delay = Math.min(baseDelay, this.config.maxBackoffMs);
    
    // Add jitter
    const jitter = delay * this.config.jitterFactor * (Math.random() * 2 - 1);
    
    return now() + Math.max(0, delay + jitter);
  }

  /**
   * Manually trigger resume for a session
   */
  queueResume(sessionId: string, remoteAgentName: string): void {
    if (!this.pendingResumes.has(sessionId)) {
      this.pendingResumes.set(sessionId, {
        sessionId,
        remoteAgentName,
        attempts: 0,
        lastAttemptAt: 0,
        nextAttemptAt: now(),
      });
    }
  }

  /**
   * Cancel resume attempts for a session
   */
  cancelResume(sessionId: string): void {
    this.pendingResumes.delete(sessionId);
  }

  /**
   * Get pending resume attempts
   */
  getPendingResumes(): ResumeAttempt[] {
    return Array.from(this.pendingResumes.values());
  }

  /**
   * Get stats
   */
  getStats(): {
    pending: number;
    inProgress: number;
  } {
    const currentTime = now();
    let inProgress = 0;
    
    for (const attempt of this.pendingResumes.values()) {
      if (attempt.lastAttemptAt > currentTime - 10000) {
        inProgress++;
      }
    }

    return {
      pending: this.pendingResumes.size,
      inProgress,
    };
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createResumeManager(
  db: DatabaseManager, 
  config?: Partial<ResumeConfig>
): ResumeManager {
  return new ResumeManager(db, config);
}

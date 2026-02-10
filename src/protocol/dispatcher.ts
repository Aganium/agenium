/**
 * Message Dispatcher
 * Handles message routing, queuing, backpressure, and retries
 */

import { EventEmitter } from 'node:events';
import {
  AnyFrame,
  RequestFrame,
  ResponseFrame,
  EventFrame,
  ErrorFrame,
  MessageType,
  createResponseFrame,
  createErrorFrame,
  validateFrame,
  ErrorCodes,
  DEFAULT_TIMEOUT_MS,
  MAX_RETRIES,
} from './types.js';
import { getBugReporter } from '../bug-report/reporter.js';
import { generateId, now } from '../core/types.js';

// ============================================================================
// Types
// ============================================================================

export interface DispatcherConfig {
  /** Max pending requests per session */
  maxPendingPerSession: number;
  /** Max total pending requests */
  maxPendingTotal: number;
  /** Max queued outbound messages per session */
  maxQueuePerSession: number;
  /** Default request timeout */
  defaultTimeoutMs: number;
  /** Max retries for failed requests */
  maxRetries: number;
}

export interface PendingRequest {
  frame: RequestFrame;
  resolve: (response: ResponseFrame) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
  attempts: number;
  createdAt: number;
}

export interface QueuedMessage {
  frame: AnyFrame;
  attempts: number;
  createdAt: number;
}

/** Handler for incoming requests */
export type RequestHandler = (
  method: string,
  params: Record<string, unknown> | undefined,
  sessionId: string
) => Promise<unknown>;

/** Handler for incoming events */
export type EventHandler = (
  event: string,
  data: unknown,
  sessionId: string
) => void;

/** Function to send a frame over the network */
export type SendFunction = (
  sessionId: string,
  frame: AnyFrame
) => Promise<boolean>;

// ============================================================================
// Message Dispatcher
// ============================================================================

export class MessageDispatcher extends EventEmitter {
  private config: DispatcherConfig;
  private pending: Map<string, PendingRequest> = new Map();
  private queues: Map<string, QueuedMessage[]> = new Map();
  private requestHandlers: Map<string, RequestHandler> = new Map();
  private eventHandlers: Map<string, EventHandler> = new Map();
  private sendFn: SendFunction | null = null;
  private processingQueues: Set<string> = new Set();

  constructor(config: Partial<DispatcherConfig> = {}) {
    super();
    this.config = {
      maxPendingPerSession: config.maxPendingPerSession ?? 10,
      maxPendingTotal: config.maxPendingTotal ?? 100,
      maxQueuePerSession: config.maxQueuePerSession ?? 50,
      defaultTimeoutMs: config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: config.maxRetries ?? MAX_RETRIES,
    };
  }

  /**
   * Set the send function for outbound messages
   */
  setSendFunction(fn: SendFunction): void {
    this.sendFn = fn;
  }

  /**
   * Register a handler for a request method
   */
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /**
   * Register a handler for an event type
   */
  onEvent(event: string, handler: EventHandler): void {
    this.eventHandlers.set(event, handler);
  }

  // ============================================================================
  // Outbound Messages
  // ============================================================================

  /**
   * Send a request and wait for response
   */
  async request(
    sessionId: string,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<unknown> {
    // Check backpressure
    const sessionPending = this.getPendingCount(sessionId);
    if (sessionPending >= this.config.maxPendingPerSession) {
      throw new Error(`Too many pending requests for session ${sessionId}`);
    }
    if (this.pending.size >= this.config.maxPendingTotal) {
      throw new Error('Too many pending requests globally');
    }

    const frame: RequestFrame = {
      version: '1.0',
      messageId: generateId(),
      type: MessageType.REQUEST,
      sessionId,
      timestamp: now(),
      timeoutMs: timeoutMs ?? this.config.defaultTimeoutMs,
      payload: { method, params },
    };

    return this.sendRequest(frame);
  }

  /**
   * Send an event (fire-and-forget)
   */
  async event(
    sessionId: string,
    event: string,
    data?: unknown
  ): Promise<boolean> {
    const frame: EventFrame = {
      version: '1.0',
      messageId: generateId(),
      type: MessageType.EVENT,
      sessionId,
      timestamp: now(),
      payload: { event, data },
    };

    return this.queueAndSend(sessionId, frame);
  }

  // ============================================================================
  // Inbound Messages
  // ============================================================================

  /**
   * Handle an incoming frame
   */
  async handleIncoming(raw: unknown): Promise<AnyFrame | null> {
    // Validate frame
    const validation = validateFrame(raw);
    if (!validation.valid) {
      getBugReporter().report('protocol', 'INVALID_FRAME', validation.error!);
      return null;
    }

    const frame = raw as AnyFrame;
    getBugReporter().recordAction('message_received', {
      type: frame.type,
      sessionId: frame.sessionId,
      messageId: frame.messageId,
    });

    switch (frame.type) {
      case MessageType.REQUEST:
        return this.handleRequest(frame);
      case MessageType.RESPONSE:
        this.handleResponse(frame);
        return null;
      case MessageType.EVENT:
        this.handleEvent(frame);
        return null;
      case MessageType.ERROR:
        this.handleError(frame);
        return null;
      default:
        getBugReporter().report('protocol', 'UNKNOWN_TYPE', `Unknown message type`);
        return null;
    }
  }

  private async handleRequest(frame: RequestFrame): Promise<ResponseFrame | ErrorFrame> {
    const { method, params } = frame.payload;
    const handler = this.requestHandlers.get(method);

    if (!handler) {
      getBugReporter().report('protocol', 'UNKNOWN_METHOD', `Unknown method: ${method}`);
      return createErrorFrame(
        frame.sessionId,
        ErrorCodes.UNKNOWN_METHOD,
        `Unknown method: ${method}`,
        frame.messageId
      );
    }

    try {
      const result = await handler(method, params, frame.sessionId);
      return createResponseFrame(frame.sessionId, frame.messageId, true, result);
    } catch (err) {
      const error = err as Error;
      getBugReporter().report('protocol', 'HANDLER_ERROR', error.message, {
        sessionId: frame.sessionId,
      });
      return createResponseFrame(frame.sessionId, frame.messageId, false, {
        code: ErrorCodes.HANDLER_ERROR,
        message: error.message,
      });
    }
  }

  private handleResponse(frame: ResponseFrame): void {
    const pending = this.pending.get(frame.replyTo);
    if (!pending) {
      // Late response (already timed out) - ignore
      return;
    }

    clearTimeout(pending.timeoutHandle);
    this.pending.delete(frame.replyTo);

    if (frame.payload.success) {
      pending.resolve(frame);
    } else {
      const error = new Error(frame.payload.error?.message ?? 'Request failed');
      (error as any).code = frame.payload.error?.code;
      pending.reject(error);
    }
  }

  private handleEvent(frame: EventFrame): void {
    const { event, data } = frame.payload;
    const handler = this.eventHandlers.get(event);

    if (handler) {
      try {
        handler(event, data, frame.sessionId);
      } catch (err) {
        getBugReporter().reportError(err as Error, 'internal');
      }
    }

    // Emit for generic listeners
    this.emit('event', frame);
  }

  private handleError(frame: ErrorFrame): void {
    // If this is a reply to a pending request, reject it
    if (frame.replyTo) {
      const pending = this.pending.get(frame.replyTo);
      if (pending) {
        clearTimeout(pending.timeoutHandle);
        this.pending.delete(frame.replyTo);
        
        const error = new Error(frame.payload.message);
        (error as any).code = frame.payload.code;
        pending.reject(error);
        return;
      }
    }

    // Otherwise emit as error event
    this.emit('error', frame);
    getBugReporter().report('protocol', frame.payload.code, frame.payload.message, {
      sessionId: frame.sessionId,
    });
  }

  // ============================================================================
  // Queue Management
  // ============================================================================

  private async sendRequest(frame: RequestFrame): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = frame.timeoutMs ?? this.config.defaultTimeoutMs;
      
      const timeoutHandle = setTimeout(() => {
        const pending = this.pending.get(frame.messageId);
        if (pending) {
          this.pending.delete(frame.messageId);
          
          // Retry logic
          if (pending.attempts < this.config.maxRetries) {
            pending.attempts++;
            this.sendRequest(frame).then(resolve).catch(reject);
            return;
          }

          getBugReporter().report('timeout', 'REQUEST_TIMEOUT', 
            `Request ${frame.payload.method} timed out after ${timeout}ms`, {
              sessionId: frame.sessionId,
            });
          reject(new Error(`Request timed out after ${timeout}ms`));
        }
      }, timeout);

      const pendingReq: PendingRequest = {
        frame,
        resolve: (response) => resolve(response.payload.result),
        reject,
        timeoutHandle,
        attempts: 1,
        createdAt: now(),
      };

      this.pending.set(frame.messageId, pendingReq);

      // Send immediately
      this.queueAndSend(frame.sessionId, frame).catch(err => {
        clearTimeout(timeoutHandle);
        this.pending.delete(frame.messageId);
        reject(err);
      });
    });
  }

  private async queueAndSend(sessionId: string, frame: AnyFrame): Promise<boolean> {
    if (!this.sendFn) {
      throw new Error('Send function not configured');
    }

    // Get or create queue
    let queue = this.queues.get(sessionId);
    if (!queue) {
      queue = [];
      this.queues.set(sessionId, queue);
    }

    // Check queue limit
    if (queue.length >= this.config.maxQueuePerSession) {
      throw new Error(`Queue full for session ${sessionId}`);
    }

    // Add to queue
    queue.push({
      frame,
      attempts: 0,
      createdAt: now(),
    });

    // Process queue
    await this.processQueue(sessionId);
    return true;
  }

  private async processQueue(sessionId: string): Promise<void> {
    // Prevent concurrent processing
    if (this.processingQueues.has(sessionId)) {
      return;
    }
    this.processingQueues.add(sessionId);

    try {
      const queue = this.queues.get(sessionId);
      if (!queue || queue.length === 0) {
        return;
      }

      while (queue.length > 0) {
        const item = queue[0];
        
        try {
          const success = await this.sendFn!(sessionId, item.frame);
          if (success) {
            queue.shift(); // Remove from queue
            getBugReporter().recordAction('message_sent', {
              type: item.frame.type,
              sessionId,
              messageId: item.frame.messageId,
            });
          } else {
            // Retry later
            item.attempts++;
            if (item.attempts >= this.config.maxRetries) {
              queue.shift();
              getBugReporter().report('connection', 'SEND_FAILED',
                `Failed to send message after ${item.attempts} attempts`);
            }
            break; // Stop processing, will retry later
          }
        } catch (err) {
          item.attempts++;
          if (item.attempts >= this.config.maxRetries) {
            queue.shift();
            getBugReporter().reportError(err as Error, 'connection');
          }
          break;
        }
      }
    } finally {
      this.processingQueues.delete(sessionId);
    }
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  private getPendingCount(sessionId: string): number {
    let count = 0;
    for (const pending of this.pending.values()) {
      if (pending.frame.sessionId === sessionId) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get dispatcher statistics
   */
  getStats(): {
    pendingRequests: number;
    queuedMessages: number;
    registeredMethods: string[];
    registeredEvents: string[];
  } {
    let queuedTotal = 0;
    for (const queue of this.queues.values()) {
      queuedTotal += queue.length;
    }

    return {
      pendingRequests: this.pending.size,
      queuedMessages: queuedTotal,
      registeredMethods: Array.from(this.requestHandlers.keys()),
      registeredEvents: Array.from(this.eventHandlers.keys()),
    };
  }

  /**
   * Clear pending requests for a session
   */
  clearSession(sessionId: string): void {
    // Clear pending requests
    for (const [messageId, pending] of this.pending) {
      if (pending.frame.sessionId === sessionId) {
        clearTimeout(pending.timeoutHandle);
        pending.reject(new Error('Session closed'));
        this.pending.delete(messageId);
      }
    }

    // Clear queue
    this.queues.delete(sessionId);
  }

  /**
   * Shutdown dispatcher
   */
  shutdown(): void {
    // Reject all pending requests
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(new Error('Dispatcher shutdown'));
    }
    this.pending.clear();
    this.queues.clear();
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createDispatcher(config?: Partial<DispatcherConfig>): MessageDispatcher {
  return new MessageDispatcher(config);
}

/**
 * AGENIUM Protocol - Message Types and Frames
 */

import { generateId, now } from '../core/types.js';

// ============================================================================
// Protocol Constants
// ============================================================================

export const PROTOCOL_MESSAGE_VERSION = '1.0';
export const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB
export const DEFAULT_TIMEOUT_MS = 30000;
export const MAX_RETRIES = 3;

// ============================================================================
// Message Types
// ============================================================================

export enum MessageType {
  /** Request expecting a response */
  REQUEST = 'REQUEST',
  /** Response to a request */
  RESPONSE = 'RESPONSE',
  /** Fire-and-forget event */
  EVENT = 'EVENT',
  /** Error message */
  ERROR = 'ERROR',
}

// ============================================================================
// Protocol Frame
// ============================================================================

/**
 * Base frame structure for all messages
 */
export interface ProtocolFrame {
  /** Protocol version */
  version: string;
  /** Unique message ID */
  messageId: string;
  /** Message type */
  type: MessageType;
  /** Session this message belongs to */
  sessionId: string;
  /** Timestamp when created */
  timestamp: number;
  /** For responses/errors: the request this is replying to */
  replyTo?: string;
  /** The actual message content */
  payload: unknown;
}

// ============================================================================
// Request Frame
// ============================================================================

export interface RequestPayload {
  /** Method/action to invoke */
  method: string;
  /** Method parameters */
  params?: Record<string, unknown>;
}

export interface RequestFrame extends ProtocolFrame {
  type: MessageType.REQUEST;
  payload: RequestPayload;
  /** Request timeout in ms */
  timeoutMs?: number;
}

// ============================================================================
// Response Frame
// ============================================================================

export interface ResponsePayload {
  /** Whether the request succeeded */
  success: boolean;
  /** Result data (if success) */
  result?: unknown;
  /** Error info (if !success) */
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface ResponseFrame extends ProtocolFrame {
  type: MessageType.RESPONSE;
  replyTo: string; // Required for responses
  payload: ResponsePayload;
}

// ============================================================================
// Event Frame
// ============================================================================

export interface EventPayload {
  /** Event type/name */
  event: string;
  /** Event data */
  data?: unknown;
}

export interface EventFrame extends ProtocolFrame {
  type: MessageType.EVENT;
  payload: EventPayload;
}

// ============================================================================
// Error Frame
// ============================================================================

export interface ErrorPayload {
  /** Error code */
  code: string;
  /** Human-readable message */
  message: string;
  /** Additional details */
  details?: unknown;
}

export interface ErrorFrame extends ProtocolFrame {
  type: MessageType.ERROR;
  payload: ErrorPayload;
}

// ============================================================================
// Union Type
// ============================================================================

export type AnyFrame = RequestFrame | ResponseFrame | EventFrame | ErrorFrame;

// ============================================================================
// Frame Builders
// ============================================================================

export function createRequestFrame(
  sessionId: string,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number
): RequestFrame {
  return {
    version: PROTOCOL_MESSAGE_VERSION,
    messageId: generateId(),
    type: MessageType.REQUEST,
    sessionId,
    timestamp: now(),
    timeoutMs,
    payload: { method, params },
  };
}

export function createResponseFrame(
  sessionId: string,
  replyTo: string,
  success: boolean,
  resultOrError: unknown
): ResponseFrame {
  const payload: ResponsePayload = success
    ? { success: true, result: resultOrError }
    : { success: false, error: resultOrError as ResponsePayload['error'] };

  return {
    version: PROTOCOL_MESSAGE_VERSION,
    messageId: generateId(),
    type: MessageType.RESPONSE,
    sessionId,
    timestamp: now(),
    replyTo,
    payload,
  };
}

export function createEventFrame(
  sessionId: string,
  event: string,
  data?: unknown
): EventFrame {
  return {
    version: PROTOCOL_MESSAGE_VERSION,
    messageId: generateId(),
    type: MessageType.EVENT,
    sessionId,
    timestamp: now(),
    payload: { event, data },
  };
}

export function createErrorFrame(
  sessionId: string,
  code: string,
  message: string,
  replyTo?: string,
  details?: unknown
): ErrorFrame {
  return {
    version: PROTOCOL_MESSAGE_VERSION,
    messageId: generateId(),
    type: MessageType.ERROR,
    sessionId,
    timestamp: now(),
    replyTo,
    payload: { code, message, details },
  };
}

// ============================================================================
// Frame Validation
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateFrame(frame: unknown): ValidationResult {
  if (!frame || typeof frame !== 'object') {
    return { valid: false, error: 'Frame must be an object' };
  }

  const f = frame as Record<string, unknown>;

  // Check required fields
  if (typeof f.version !== 'string') {
    return { valid: false, error: 'Missing or invalid version' };
  }
  if (typeof f.messageId !== 'string') {
    return { valid: false, error: 'Missing or invalid messageId' };
  }
  if (!Object.values(MessageType).includes(f.type as MessageType)) {
    return { valid: false, error: `Invalid message type: ${f.type}` };
  }
  if (typeof f.sessionId !== 'string') {
    return { valid: false, error: 'Missing or invalid sessionId' };
  }
  if (typeof f.timestamp !== 'number') {
    return { valid: false, error: 'Missing or invalid timestamp' };
  }
  if (f.payload === undefined) {
    return { valid: false, error: 'Missing payload' };
  }

  // Type-specific validation
  switch (f.type) {
    case MessageType.REQUEST: {
      const p = f.payload as Record<string, unknown>;
      if (typeof p.method !== 'string') {
        return { valid: false, error: 'Request payload missing method' };
      }
      break;
    }
    case MessageType.RESPONSE: {
      if (typeof f.replyTo !== 'string') {
        return { valid: false, error: 'Response missing replyTo' };
      }
      const p = f.payload as Record<string, unknown>;
      if (typeof p.success !== 'boolean') {
        return { valid: false, error: 'Response payload missing success' };
      }
      break;
    }
    case MessageType.EVENT: {
      const p = f.payload as Record<string, unknown>;
      if (typeof p.event !== 'string') {
        return { valid: false, error: 'Event payload missing event name' };
      }
      break;
    }
    case MessageType.ERROR: {
      const p = f.payload as Record<string, unknown>;
      if (typeof p.code !== 'string' || typeof p.message !== 'string') {
        return { valid: false, error: 'Error payload missing code or message' };
      }
      break;
    }
  }

  return { valid: true };
}

// ============================================================================
// Error Codes
// ============================================================================

export const ErrorCodes = {
  // Protocol errors
  INVALID_FRAME: 'INVALID_FRAME',
  UNKNOWN_METHOD: 'UNKNOWN_METHOD',
  INVALID_PARAMS: 'INVALID_PARAMS',
  
  // Session errors
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_NOT_ACTIVE: 'SESSION_NOT_ACTIVE',
  
  // Transport errors
  TIMEOUT: 'TIMEOUT',
  CONNECTION_LOST: 'CONNECTION_LOST',
  
  // Backpressure
  QUEUE_FULL: 'QUEUE_FULL',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  
  // Internal
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  HANDLER_ERROR: 'HANDLER_ERROR',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

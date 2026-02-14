/**
 * Tool System Types
 *
 * Extends AgentTool (from dns/types) with runtime handler support.
 */

import type { AgentTool } from '../dns/types.js';

// Re-export the wire type
export type { AgentTool } from '../dns/types.js';

/**
 * Context passed to every tool handler invocation.
 */
export interface ToolContext {
  /** Session ID of the caller */
  sessionId: string;
  /** Remote agent identity (if known) */
  caller?: { name: string; publicKey: string };
  /** Arbitrary metadata sent with the invocation */
  meta?: Record<string, unknown>;
}

/**
 * A tool handler function.
 * Receives validated input + context, returns JSON-serialisable output.
 */
export type ToolHandler = (
  input: Record<string, unknown>,
  ctx: ToolContext,
) => unknown | Promise<unknown>;

/**
 * Options for registering a tool (everything except the handler).
 */
export interface ToolDefinition {
  /** Human-readable description */
  description?: string;
  /** JSON Schema for accepted input */
  inputSchema?: Record<string, unknown>;
  /** JSON Schema for output */
  outputSchema?: Record<string, unknown>;
}

/**
 * Full runtime tool = wire definition + handler.
 */
export interface RegisteredTool {
  /** Wire-format definition (sent to DNS / exposed via tool.list) */
  definition: AgentTool;
  /** Runtime handler */
  handler: ToolHandler;
}

/**
 * Result of a tool.invoke call.
 */
export interface ToolInvokeResult {
  /** Tool name that was invoked */
  tool: string;
  /** Handler return value */
  output: unknown;
}

/**
 * Error codes specific to the tool subsystem.
 */
export enum ToolErrorCode {
  NOT_FOUND = 'TOOL_NOT_FOUND',
  DUPLICATE = 'TOOL_DUPLICATE',
  INVALID_INPUT = 'TOOL_INVALID_INPUT',
  HANDLER_ERROR = 'TOOL_HANDLER_ERROR',
  /** Remote agent returned an error during tool.invoke */
  REMOTE_ERROR = 'TOOL_REMOTE_ERROR',
  /** Session not active — cannot invoke remote tool */
  SESSION_NOT_ACTIVE = 'TOOL_SESSION_NOT_ACTIVE',
  /** Connection or resolution failed for remote call */
  REMOTE_UNREACHABLE = 'TOOL_REMOTE_UNREACHABLE',
}

/**
 * Result of listing tools on a remote agent.
 */
export interface RemoteToolListResult {
  /** Tools exposed by the remote agent */
  tools: AgentTool[];
  /** Session used for the query */
  sessionId: string;
}

/**
 * Result of invoking a tool on a remote agent.
 */
export interface RemoteToolInvokeResult {
  /** Tool name that was invoked */
  tool: string;
  /** Return value from the remote handler */
  output: unknown;
  /** Session used for the invocation */
  sessionId: string;
}

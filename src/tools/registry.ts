/**
 * Tool Registry
 *
 * Manages tool definitions and handlers for an agent.
 * Integrates with the protocol dispatcher for tool.invoke / tool.list.
 */

import type { AgentTool } from '../dns/types.js';
import {
  RegisteredTool,
  ToolHandler,
  ToolDefinition,
  ToolContext,
  ToolInvokeResult,
  ToolErrorCode,
} from './types.js';

// ============================================================================
// Registry
// ============================================================================

export class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();

  /**
   * Register a tool with definition + handler.
   * Throws if a tool with the same name already exists.
   */
  register(name: string, opts: ToolDefinition, handler: ToolHandler): AgentTool {
    if (this.tools.has(name)) {
      throw new Error(`${ToolErrorCode.DUPLICATE}: Tool "${name}" already registered`);
    }

    const definition: AgentTool = {
      name,
      description: opts.description,
      inputSchema: opts.inputSchema,
      outputSchema: opts.outputSchema,
    };

    this.tools.set(name, { definition, handler });
    return definition;
  }

  /**
   * Remove a tool by name. Returns true if it existed.
   */
  remove(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Check if a tool is registered.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get wire-format definitions for all registered tools.
   * This is what gets sent to DNS and returned by tool.list.
   */
  definitions(): AgentTool[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /**
   * Get a single tool's definition (or undefined).
   */
  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Number of registered tools.
   */
  get size(): number {
    return this.tools.size;
  }

  /**
   * Invoke a tool by name.
   * Throws descriptive errors for missing tools or handler failures.
   */
  async invoke(
    name: string,
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolInvokeResult> {
    const entry = this.tools.get(name);
    if (!entry) {
      throw Object.assign(
        new Error(`${ToolErrorCode.NOT_FOUND}: Tool "${name}" not found`),
        { code: ToolErrorCode.NOT_FOUND },
      );
    }

    try {
      const output = await entry.handler(input, ctx);
      return { tool: name, output };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Object.assign(
        new Error(`${ToolErrorCode.HANDLER_ERROR}: ${msg}`),
        { code: ToolErrorCode.HANDLER_ERROR, cause: err },
      );
    }
  }

  /**
   * Clear all tools.
   */
  clear(): void {
    this.tools.clear();
  }
}

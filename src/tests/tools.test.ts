/**
 * Tool Registry + Agent Tool Integration Tests
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ToolRegistry } from '../tools/registry.js';
import { ToolErrorCode } from '../tools/types.js';
import type { ToolContext, AgentTool } from '../tools/types.js';

// ============================================================================
// ToolRegistry unit tests
// ============================================================================

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('registers a tool and returns its definition', () => {
    const def = registry.register('greet', {
      description: 'Say hello',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    }, async (input) => ({ message: `Hi ${input.name}` }));

    assert.equal(def.name, 'greet');
    assert.equal(def.description, 'Say hello');
    assert.equal(registry.size, 1);
    assert.ok(registry.has('greet'));
  });

  it('rejects duplicate tool names', () => {
    registry.register('dup', {}, async () => null);
    assert.throws(
      () => registry.register('dup', {}, async () => null),
      /TOOL_DUPLICATE/,
    );
  });

  it('removes a tool', () => {
    registry.register('temp', {}, async () => null);
    assert.ok(registry.remove('temp'));
    assert.equal(registry.has('temp'), false);
    assert.equal(registry.remove('temp'), false);
  });

  it('returns definitions array', () => {
    registry.register('a', { description: 'A' }, async () => 'a');
    registry.register('b', { description: 'B' }, async () => 'b');

    const defs = registry.definitions();
    assert.equal(defs.length, 2);
    assert.deepEqual(defs.map((d) => d.name).sort(), ['a', 'b']);
  });

  it('invokes a tool with input and context', async () => {
    registry.register('add', {
      inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
    }, async (input, ctx) => ({
      sum: (input.a as number) + (input.b as number),
      caller: ctx.sessionId,
    }));

    const ctx: ToolContext = { sessionId: 'sess-1' };
    const result = await registry.invoke('add', { a: 3, b: 7 }, ctx);

    assert.equal(result.tool, 'add');
    assert.deepEqual(result.output, { sum: 10, caller: 'sess-1' });
  });

  it('throws TOOL_NOT_FOUND on invoke of missing tool', async () => {
    const ctx: ToolContext = { sessionId: 'x' };
    await assert.rejects(
      () => registry.invoke('nope', {}, ctx),
      (err: Error & { code?: string }) => {
        assert.ok(err.message.includes(ToolErrorCode.NOT_FOUND));
        assert.equal(err.code, ToolErrorCode.NOT_FOUND);
        return true;
      },
    );
  });

  it('wraps handler errors in TOOL_HANDLER_ERROR', async () => {
    registry.register('boom', {}, async () => {
      throw new Error('kaboom');
    });

    const ctx: ToolContext = { sessionId: 'x' };
    await assert.rejects(
      () => registry.invoke('boom', {}, ctx),
      (err: Error & { code?: string }) => {
        assert.ok(err.message.includes('kaboom'));
        assert.equal(err.code, ToolErrorCode.HANDLER_ERROR);
        return true;
      },
    );
  });

  it('handles sync handlers', async () => {
    registry.register('sync', {}, (input) => ({ echo: input.val }));

    const ctx: ToolContext = { sessionId: 'x' };
    const result = await registry.invoke('sync', { val: 42 }, ctx);
    assert.deepEqual(result.output, { echo: 42 });
  });

  it('clears all tools', () => {
    registry.register('a', {}, async () => null);
    registry.register('b', {}, async () => null);
    registry.clear();
    assert.equal(registry.size, 0);
  });
});

// ============================================================================
// Agent tool integration tests
// ============================================================================

describe('Agent.tool()', () => {
  // We test the Agent class tool API without starting transport
  // by importing and constructing with persistence=false

  it('registers tools via config and .tool() method', async () => {
    // Dynamic import to avoid loading heavy deps at module level
    const { createAgent } = await import('../agent.js');

    const agent = createAgent('test-tools', {
      persistence: false,
      tools: [
        {
          name: 'echo',
          description: 'Echo input',
          handler: async (input) => input,
        },
      ],
    });

    // Config-based tool
    assert.ok(agent.hasTool('echo'));

    // Method-based tool (chainable)
    agent
      .tool('upper', { description: 'Uppercase' }, (input) => ({
        text: String(input.text).toUpperCase(),
      }))
      .tool('lower', { description: 'Lowercase' }, (input) => ({
        text: String(input.text).toLowerCase(),
      }));

    const tools = agent.getTools();
    assert.equal(tools.length, 3);
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['echo', 'lower', 'upper'],
    );

    // Remove
    assert.ok(agent.removeTool('lower'));
    assert.equal(agent.getTools().length, 2);
    assert.equal(agent.hasTool('lower'), false);
  });

  it('includes tools in stats', async () => {
    const { createAgent } = await import('../agent.js');
    const agent = createAgent('test-stats', { persistence: false });
    agent.tool('ping', {}, () => 'pong');

    const stats = agent.getStats();
    assert.equal(stats.tools.count, 1);
    assert.deepEqual(stats.tools.names, ['ping']);
  });
});

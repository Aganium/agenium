/**
 * @agenium/mcp-server — Bridge Tests
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { MCPBridge, BridgeState, MCPTransportManager } from '../src/index.js';

// Mock the MCP transport
jest.unstable_mockModule('../src/mcp-transport.js', () => ({
  MCPTransportManager: jest.fn().mockImplementation(() => ({
    connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(true),
    listTools: jest.fn<() => Promise<any[]>>().mockResolvedValue([
      { name: 'echo', description: 'Echo input back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
    ]),
    listResources: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
    listPrompts: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
    callTool: jest.fn<(name: string, args?: any) => Promise<any>>().mockImplementation(async (name: string, args?: any) => {
      if (name === 'echo') {
        return { content: [{ type: 'text', text: args?.text ?? '' }] };
      }
      if (name === 'add') {
        return { content: [{ type: 'text', text: String((args?.a ?? 0) + (args?.b ?? 0)) }] };
      }
      return { content: [], isError: true };
    }),
    getServerInfo: jest.fn().mockReturnValue({ name: 'test-server', version: '1.0.0' }),
  })),
}));

describe('MCPBridge', () => {
  describe('constructor', () => {
    it('creates bridge with valid config', () => {
      const bridge = new MCPBridge({
        name: 'test-bridge',
        mcp: { transport: 'stdio', command: 'echo', args: ['hello'] },
      });

      expect(bridge).toBeInstanceOf(MCPBridge);
      expect(bridge.getState()).toBe(BridgeState.IDLE);
      expect(bridge.getURI()).toBe('agent://test-bridge');
    });

    it('starts in IDLE state', () => {
      const bridge = new MCPBridge({
        name: 'idle-test',
        mcp: { transport: 'stdio', command: 'true' },
      });

      expect(bridge.getState()).toBe(BridgeState.IDLE);
      expect(bridge.getTools()).toEqual([]);
      expect(bridge.getResources()).toEqual([]);
      expect(bridge.getPrompts()).toEqual([]);
    });
  });

  describe('BridgeState enum', () => {
    it('has all expected states', () => {
      expect(BridgeState.IDLE).toBe('IDLE');
      expect(BridgeState.CONNECTING).toBe('CONNECTING');
      expect(BridgeState.READY).toBe('READY');
      expect(BridgeState.REGISTERED).toBe('REGISTERED');
      expect(BridgeState.ERROR).toBe('ERROR');
      expect(BridgeState.STOPPED).toBe('STOPPED');
    });
  });

  describe('getStats', () => {
    it('returns initial stats', () => {
      const bridge = new MCPBridge({
        name: 'stats-test',
        mcp: { transport: 'stdio', command: 'true' },
      });

      const stats = bridge.getStats();
      expect(stats.state).toBe(BridgeState.IDLE);
      expect(stats.tools).toBe(0);
      expect(stats.toolCalls).toBe(0);
      expect(stats.toolErrors).toBe(0);
    });
  });

  describe('input validation', () => {
    it('validates tool args via validateToolArgs (private, tested through reflection)', () => {
      const bridge = new MCPBridge({
        name: 'validation-test',
        mcp: { transport: 'stdio', command: 'true' },
      });

      // Access private method via prototype for testing
      const tool = {
        name: 'add',
        description: 'Add two numbers',
        inputSchema: {
          type: 'object',
          properties: {
            a: { type: 'number' },
            b: { type: 'number' },
          },
          required: ['a', 'b'],
        },
      };

      // Valid args - should return null
      const validResult = (bridge as any).validateToolArgs(tool, { a: 1, b: 2 });
      expect(validResult).toBeNull();

      // Invalid args - missing required 'b'
      const invalidResult = (bridge as any).validateToolArgs(tool, { a: 1 });
      expect(invalidResult).not.toBeNull();
      expect(invalidResult).toContain('Invalid arguments');

      // Wrong type
      const wrongType = (bridge as any).validateToolArgs(tool, { a: 'not-a-number', b: 2 });
      expect(wrongType).not.toBeNull();
      expect(wrongType).toContain('Invalid arguments');
    });

    it('accepts valid string args', () => {
      const bridge = new MCPBridge({
        name: 'string-validation',
        mcp: { transport: 'stdio', command: 'true' },
      });

      const tool = {
        name: 'echo',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      };

      expect((bridge as any).validateToolArgs(tool, { text: 'hello' })).toBeNull();
      expect((bridge as any).validateToolArgs(tool, {})).not.toBeNull();
    });

    it('handles enum validation', () => {
      const bridge = new MCPBridge({
        name: 'enum-validation',
        mcp: { transport: 'stdio', command: 'true' },
      });

      const tool = {
        name: 'lang',
        inputSchema: {
          type: 'object',
          properties: {
            language: { type: 'string', enum: ['en', 'fa', 'de'] },
          },
          required: ['language'],
        },
      };

      expect((bridge as any).validateToolArgs(tool, { language: 'en' })).toBeNull();
      expect((bridge as any).validateToolArgs(tool, { language: 'xx' })).not.toBeNull();
    });

    it('allows additional properties by default', () => {
      const bridge = new MCPBridge({
        name: 'extra-props',
        mcp: { transport: 'stdio', command: 'true' },
      });

      const tool = {
        name: 'flexible',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      };

      // Extra properties should be allowed
      expect((bridge as any).validateToolArgs(tool, { name: 'test', extra: true })).toBeNull();
    });

    it('validates nested arrays', () => {
      const bridge = new MCPBridge({
        name: 'array-validation',
        mcp: { transport: 'stdio', command: 'true' },
      });

      const tool = {
        name: 'batch',
        inputSchema: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'string' } },
          },
          required: ['items'],
        },
      };

      expect((bridge as any).validateToolArgs(tool, { items: ['a', 'b'] })).toBeNull();
      expect((bridge as any).validateToolArgs(tool, { items: [1, 2] })).not.toBeNull();
    });

    it('handles empty/missing schema gracefully', () => {
      const bridge = new MCPBridge({
        name: 'no-schema',
        mcp: { transport: 'stdio', command: 'true' },
      });

      // Tool with no real schema — should accept anything
      const tool = {
        name: 'any',
        inputSchema: {},
      };

      expect((bridge as any).validateToolArgs(tool, { foo: 'bar' })).toBeNull();
      expect((bridge as any).validateToolArgs(tool, undefined)).toBeNull();
    });
  });
});

describe('MCPTransportManager', () => {
  it('exports the class', () => {
    expect(MCPTransportManager).toBeDefined();
  });
});

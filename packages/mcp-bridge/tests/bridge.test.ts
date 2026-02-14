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
      { name: 'echo', description: 'Echo input back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
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
});

describe('MCPTransportManager', () => {
  it('exports the class', () => {
    expect(MCPTransportManager).toBeDefined();
  });
});

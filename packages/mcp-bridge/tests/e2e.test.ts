/**
 * @agenium/mcp-server — E2E Tests
 *
 * Tests the full MCPBridge lifecycle with a REAL MCP server
 * (@modelcontextprotocol/server-everything via stdio transport).
 *
 * What's tested:
 * - Bridge lifecycle: start → READY → stop → STOPPED
 * - Tool discovery from real MCP server
 * - Tool invocation (echo, get-sum) with real I/O
 * - Resource and prompt discovery
 * - Protocol handlers (health, capabilities, ping)
 * - Input validation against real tool schemas
 * - Error paths (nonexistent tool, missing args)
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { MCPBridge, BridgeState } from '../src/index.js';
import { createRequestFrame } from 'agenium';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// ============================================================================
// Shared bridge instance (one MCP server for all tests)
// ============================================================================

let bridge: MCPBridge;
let dispatcher: any;
let dataDir: string;
const SESSION = 'e2e-test-session';

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'mcp-e2e-'));
  bridge = new MCPBridge({
    name: `e2e-${Date.now()}`,
    mcp: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything'],
    },
    agent: { autoRegister: false, port: 0, dataDir },
    bridge: { logLevel: 'silent' },
  });
  await bridge.start();
  dispatcher = (bridge.getAgent() as any).dispatcher;
}, 30_000);

afterAll(async () => {
  await bridge.stop();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
}, 10_000);

/** Helper: send a protocol request through the dispatcher */
async function req(method: string, params: any = {}): Promise<any> {
  const frame = createRequestFrame(SESSION, method, params);
  const resp = await dispatcher.handleIncoming(frame);
  return resp?.payload;
}

// ============================================================================
// Lifecycle
// ============================================================================

describe('Bridge Lifecycle', () => {
  it('reaches READY state after start', () => {
    expect(bridge.getState()).toBe(BridgeState.READY);
  });

  it('has a valid agent:// URI', () => {
    expect(bridge.getURI()).toMatch(/^agent:\/\/e2e-/);
  });

  it('exposes a running agent', () => {
    const agent = bridge.getAgent();
    expect(agent).not.toBeNull();
    expect(agent!.getStats().isRunning).toBe(true);
  });
});

// ============================================================================
// Tool Discovery
// ============================================================================

describe('Tool Discovery', () => {
  it('discovers tools from real MCP server', () => {
    const tools = bridge.getTools();
    expect(tools.length).toBeGreaterThanOrEqual(5);
    const names = tools.map((t) => t.name);
    expect(names).toContain('echo');
    expect(names).toContain('get-sum');
  });

  it('tools have inputSchema', () => {
    const echo = bridge.getTools().find((t) => t.name === 'echo')!;
    expect(echo.inputSchema).toBeDefined();
    expect(echo.inputSchema.type).toBe('object');
    expect((echo.inputSchema.properties as any).message).toBeDefined();
  });

  it('returns tools via tools/list protocol handler', async () => {
    const resp = await req('tools/list');
    expect(resp.success).toBe(true);
    expect(resp.result.tools.length).toBeGreaterThanOrEqual(5);
    expect(resp.result.tools[0]).toHaveProperty('name');
    expect(resp.result.tools[0]).toHaveProperty('inputSchema');
  });
});

// ============================================================================
// Tool Invocation (real MCP server calls)
// ============================================================================

describe('Tool Invocation', () => {
  it('echo tool returns the message', async () => {
    const resp = await req('tools/call', {
      name: 'echo',
      arguments: { message: 'hello from E2E' },
    });
    expect(resp.success).toBe(true);
    expect(resp.result.content).toBeDefined();
    expect(resp.result.content[0].type).toBe('text');
    expect(resp.result.content[0].text).toContain('hello from E2E');
  });

  it('get-sum tool returns correct sum', async () => {
    const resp = await req('tools/call', {
      name: 'get-sum',
      arguments: { a: 40, b: 2 },
    });
    expect(resp.success).toBe(true);
    const text = resp.result.content[0].text;
    expect(text).toContain('42');
  });

  it('increments toolCalls stat', () => {
    const stats = bridge.getStats();
    expect(stats.toolCalls).toBeGreaterThanOrEqual(2);
    expect(stats.toolErrors).toBe(0);
  });
});

// ============================================================================
// Resource & Prompt Discovery
// ============================================================================

describe('Resource Discovery', () => {
  it('discovers resources from MCP server', () => {
    const resources = bridge.getResources();
    expect(resources.length).toBeGreaterThanOrEqual(1);
  });

  it('returns resources via resources/list handler', async () => {
    const resp = await req('resources/list');
    expect(resp.success).toBe(true);
    expect(resp.result.resources.length).toBeGreaterThanOrEqual(1);
    expect(resp.result.resources[0]).toHaveProperty('uri');
    expect(resp.result.resources[0]).toHaveProperty('name');
  });
});

describe('Prompt Discovery', () => {
  it('discovers prompts from MCP server', () => {
    const prompts = bridge.getPrompts();
    expect(prompts.length).toBeGreaterThanOrEqual(1);
  });

  it('returns prompts via prompts/list handler', async () => {
    const resp = await req('prompts/list');
    expect(resp.success).toBe(true);
    expect(resp.result.prompts.length).toBeGreaterThanOrEqual(1);
    expect(resp.result.prompts[0]).toHaveProperty('name');
  });
});

// ============================================================================
// Protocol Handlers
// ============================================================================

describe('Protocol Handlers', () => {
  it('health returns healthy status', async () => {
    const resp = await req('health');
    expect(resp.success).toBe(true);
    expect(resp.result.status).toBe('healthy');
    expect(resp.result.mcp.connected).toBe(true);
    expect(resp.result.mcp.tools).toBeGreaterThanOrEqual(5);
    expect(resp.result.bridge.state).toBe('READY');
  });

  it('capabilities returns tool/resource/prompt names', async () => {
    const resp = await req('capabilities');
    expect(resp.success).toBe(true);
    expect(resp.result.protocol).toBe('mcp-bridge/1.0');
    expect(resp.result.tools).toContain('echo');
    expect(resp.result.tools).toContain('get-sum');
    expect(resp.result.resources.length).toBeGreaterThanOrEqual(1);
    expect(resp.result.prompts.length).toBeGreaterThanOrEqual(1);
  });

  it('ping returns pong', async () => {
    const resp = await req('ping');
    expect(resp.success).toBe(true);
    expect(resp.result.pong).toBe(true);
    expect(resp.result.timestamp).toBeGreaterThan(0);
  });
});

// ============================================================================
// Error Handling
// ============================================================================

describe('Error Handling', () => {
  it('rejects nonexistent tool', async () => {
    const resp = await req('tools/call', {
      name: 'nonexistent-tool',
      arguments: {},
    });
    expect(resp.success).toBe(true);
    expect(resp.result.error).toBeDefined();
    expect(resp.result.error.code).toBe('TOOL_NOT_FOUND');
  });

  it('rejects missing tool name', async () => {
    const resp = await req('tools/call', { arguments: {} });
    expect(resp.success).toBe(true);
    expect(resp.result.error).toBeDefined();
    expect(resp.result.error.code).toBe('INVALID_PARAMS');
  });

  it('rejects invalid arguments (missing required field)', async () => {
    const resp = await req('tools/call', {
      name: 'echo',
      arguments: {},
    });
    expect(resp.success).toBe(true);
    expect(resp.result.error).toBeDefined();
    expect(resp.result.error.code).toBe('INVALID_ARGS');
    expect(resp.result.error.message).toContain('message');
  });

  it('rejects wrong argument type', async () => {
    const resp = await req('tools/call', {
      name: 'get-sum',
      arguments: { a: 'not-a-number', b: 2 },
    });
    expect(resp.success).toBe(true);
    expect(resp.result.error).toBeDefined();
    expect(resp.result.error.code).toBe('INVALID_ARGS');
  });
});

// ============================================================================
// Stats
// ============================================================================

describe('Stats & Metrics', () => {
  it('tracks tool calls and errors accurately', () => {
    const stats = bridge.getStats();
    expect(stats.state).toBe(BridgeState.READY);
    expect(stats.tools).toBeGreaterThanOrEqual(5);
    expect(stats.resources).toBeGreaterThanOrEqual(1);
    expect(stats.prompts).toBeGreaterThanOrEqual(1);
    expect(stats.toolCalls).toBeGreaterThanOrEqual(2);
    expect(stats.uptimeMs).toBeGreaterThan(0);
  });
});

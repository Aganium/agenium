/**
 * Remote Tool Invocation Tests — Cycle 3
 *
 * Tests the client-side API for discovering and invoking tools on remote agents:
 *   agent.listRemoteTools(sessionId)
 *   agent.callTool(sessionId, toolName, input)
 *   agent.callToolOnAgent(target, toolName, input)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createAgent, Agent } from '../agent.js';
import { ToolErrorCode, ToolContext } from '../tools/types.js';
import { SessionState } from '../core/types.js';

// ============================================================================
// Helpers
// ============================================================================

let portCounter = 19400;
let nameCounter = 0;
function nextPort(): number {
  return portCounter++;
}
function nextName(prefix: string): string {
  return `${prefix}-${++nameCounter}`;
}

/**
 * Create a pair of connected agents.
 * Server agent has tools registered; client connects to it.
 */
async function createConnectedPair(opts?: {
  serverTools?: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    handler: (input: Record<string, unknown>, ctx: ToolContext) => unknown | Promise<unknown>;
  }>;
}): Promise<{ server: Agent; client: Agent; sessionId: string; cleanup: () => Promise<void> }> {
  const serverPort = nextPort();
  const clientPort = nextPort();

  const server = createAgent(nextName('rsrv'), {
    listenPort: serverPort,
    persistence: false,
    tools: opts?.serverTools?.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      handler: t.handler,
    })),
  });

  const client = createAgent(nextName('rcli'), {
    listenPort: clientPort,
    persistence: false,
  });

  await server.start();
  await client.start();

  const connectResult = await client.connect({ host: '127.0.0.1', port: serverPort });
  if (!connectResult.success || !connectResult.session) {
    throw new Error(`Setup failed: ${connectResult.error}`);
  }

  return {
    server,
    client,
    sessionId: connectResult.session.id,
    cleanup: async () => {
      await client.stop();
      await server.stop();
    },
  };
}

// ============================================================================
// listRemoteTools
// ============================================================================

describe('agent.listRemoteTools()', () => {
  let server: Agent;
  let client: Agent;
  let sessionId: string;
  let cleanup: () => Promise<void>;

  afterEach(async () => {
    if (cleanup) await cleanup();
  });

  it('returns empty list when remote has no tools', async () => {
    ({ server, client, sessionId, cleanup } = await createConnectedPair());

    const result = await client.listRemoteTools(sessionId);
    assert.deepEqual(result.tools, []);
    assert.equal(result.sessionId, sessionId);
  });

  it('returns tool definitions from remote agent', async () => {
    ({ server, client, sessionId, cleanup } = await createConnectedPair({
      serverTools: [
        {
          name: 'greet',
          description: 'Say hello',
          inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
          handler: async (input) => ({ message: `Hello, ${input.name}!` }),
        },
        {
          name: 'add',
          description: 'Add two numbers',
          handler: async (input) => ({ sum: (input.a as number) + (input.b as number) }),
        },
      ],
    }));

    const result = await client.listRemoteTools(sessionId);
    assert.equal(result.tools.length, 2);

    const names = result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['add', 'greet']);

    const greet = result.tools.find((t) => t.name === 'greet')!;
    assert.equal(greet.description, 'Say hello');
    assert.ok(greet.inputSchema);
  });

  it('throws SESSION_NOT_ACTIVE for invalid session', async () => {
    ({ server, client, sessionId, cleanup } = await createConnectedPair());

    await assert.rejects(
      () => client.listRemoteTools('nonexistent-session'),
      (err: Error & { code?: string }) => {
        assert.ok(err.message.includes(ToolErrorCode.SESSION_NOT_ACTIVE));
        assert.equal(err.code, ToolErrorCode.SESSION_NOT_ACTIVE);
        return true;
      },
    );
  });
});

// ============================================================================
// callTool
// ============================================================================

describe('agent.callTool()', () => {
  let server: Agent;
  let client: Agent;
  let sessionId: string;
  let cleanup: () => Promise<void>;

  afterEach(async () => {
    if (cleanup) await cleanup();
  });

  it('invokes a simple tool and returns output', async () => {
    ({ server, client, sessionId, cleanup } = await createConnectedPair({
      serverTools: [
        {
          name: 'echo',
          description: 'Echo input',
          handler: async (input) => input,
        },
      ],
    }));

    const result = await client.callTool(sessionId, 'echo', { msg: 'ping' });
    assert.equal(result.tool, 'echo');
    assert.deepEqual(result.output, { msg: 'ping' });
    assert.equal(result.sessionId, sessionId);
  });

  it('invokes a tool that does computation', async () => {
    ({ server, client, sessionId, cleanup } = await createConnectedPair({
      serverTools: [
        {
          name: 'multiply',
          handler: async (input) => ({
            product: (input.a as number) * (input.b as number),
          }),
        },
      ],
    }));

    const result = await client.callTool(sessionId, 'multiply', { a: 7, b: 6 });
    assert.deepEqual(result.output, { product: 42 });
  });

  it('passes metadata to remote handler', async () => {
    let receivedMeta: Record<string, unknown> | undefined;

    ({ server, client, sessionId, cleanup } = await createConnectedPair({
      serverTools: [
        {
          name: 'inspect',
          handler: async (input: Record<string, unknown>, ctx: ToolContext) => {
            receivedMeta = ctx.meta;
            return { ok: true };
          },
        },
      ],
    }));

    await client.callTool(sessionId, 'inspect', {}, { traceId: 'abc-123' });
    assert.deepEqual(receivedMeta, { traceId: 'abc-123' });
  });

  it('throws REMOTE_ERROR when remote tool not found', async () => {
    ({ server, client, sessionId, cleanup } = await createConnectedPair());

    await assert.rejects(
      () => client.callTool(sessionId, 'nonexistent', {}),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, ToolErrorCode.REMOTE_ERROR);
        assert.ok(err.message.includes('TOOL_REMOTE_ERROR'));
        return true;
      },
    );
  });

  it('throws REMOTE_ERROR when remote handler crashes', async () => {
    ({ server, client, sessionId, cleanup } = await createConnectedPair({
      serverTools: [
        {
          name: 'crash',
          handler: async () => {
            throw new Error('intentional boom');
          },
        },
      ],
    }));

    await assert.rejects(
      () => client.callTool(sessionId, 'crash', {}),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, ToolErrorCode.REMOTE_ERROR);
        assert.ok(err.message.includes('intentional boom'));
        return true;
      },
    );
  });

  it('throws SESSION_NOT_ACTIVE for bad session', async () => {
    // Reuse the pair from a previous test to avoid rapid TLS key generation
    ({ server, client, sessionId, cleanup } = await createConnectedPair({
      serverTools: [{ name: 'noop', handler: async () => null }],
    }));

    await assert.rejects(
      () => client.callTool('fake-session', 'noop', {}),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, ToolErrorCode.SESSION_NOT_ACTIVE);
        return true;
      },
    );
  });

  it('handles sync (non-async) remote handlers', async () => {
    ({ server, client, sessionId, cleanup } = await createConnectedPair({
      serverTools: [
        {
          name: 'sync-tool',
          handler: (input) => ({ doubled: (input.n as number) * 2 }),
        },
      ],
    }));

    const result = await client.callTool(sessionId, 'sync-tool', { n: 21 });
    assert.deepEqual(result.output, { doubled: 42 });
  });
});

// ============================================================================
// callToolOnAgent (one-shot convenience)
// ============================================================================

describe('agent.callToolOnAgent()', () => {
  let server: Agent;
  let client: Agent;
  let cleanup: () => Promise<void>;
  let serverPort: number;

  afterEach(async () => {
    if (cleanup) await cleanup();
  });

  it('resolves, connects, and invokes in one call', async () => {
    serverPort = nextPort();
    const clientPort = nextPort();

    server = createAgent(nextName('osrv'), {
      listenPort: serverPort,
      persistence: false,
      tools: [
        {
          name: 'hello',
          description: 'Hello world',
          handler: async () => ({ greeting: 'world' }),
        },
      ],
    });

    client = createAgent(nextName('ocli'), {
      listenPort: clientPort,
      persistence: false,
    });

    await server.start();
    await client.start();
    cleanup = async () => {
      await client.stop();
      await server.stop();
    };

    const result = await client.callToolOnAgent(
      { host: '127.0.0.1', port: serverPort },
      'hello',
      {},
    );

    assert.equal(result.tool, 'hello');
    assert.deepEqual(result.output, { greeting: 'world' });
    assert.ok(result.sessionId);
  });

  it('reuses existing session on second call', async () => {
    serverPort = nextPort();
    const clientPort = nextPort();

    server = createAgent(nextName('rsrv'), {
      listenPort: serverPort,
      persistence: false,
      tools: [
        {
          name: 'counter',
          handler: (() => {
            let count = 0;
            return async () => ({ count: ++count });
          })(),
        },
      ],
    });

    client = createAgent(nextName('rcli'), {
      listenPort: clientPort,
      persistence: false,
    });

    await server.start();
    await client.start();
    cleanup = async () => {
      await client.stop();
      await server.stop();
    };

    const target = { host: '127.0.0.1', port: serverPort };

    const r1 = await client.callToolOnAgent(target, 'counter');
    const r2 = await client.callToolOnAgent(target, 'counter');

    assert.deepEqual(r1.output, { count: 1 });
    assert.deepEqual(r2.output, { count: 2 });
    // Same session reused
    assert.equal(r1.sessionId, r2.sessionId);
  });

  it('throws REMOTE_UNREACHABLE for bad target', async () => {
    const clientPort = nextPort();
    client = createAgent(nextName('ucli'), {
      listenPort: clientPort,
      persistence: false,
    });
    await client.start();
    cleanup = async () => {
      await client.stop();
    };

    await assert.rejects(
      () => client.callToolOnAgent({ host: '127.0.0.1', port: 1 }, 'anything', {}),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, ToolErrorCode.REMOTE_UNREACHABLE);
        return true;
      },
    );
  });
});

// ============================================================================
// Dynamic tool registration + remote discovery
// ============================================================================

describe('Dynamic tool registration visible to remote', () => {
  let server: Agent;
  let client: Agent;
  let sessionId: string;
  let cleanup: () => Promise<void>;

  afterEach(async () => {
    if (cleanup) await cleanup();
  });

  it('tools added after start are immediately callable', async () => {
    ({ server, client, sessionId, cleanup } = await createConnectedPair());

    // No tools initially
    let list = await client.listRemoteTools(sessionId);
    assert.equal(list.tools.length, 0);

    // Dynamically add a tool on the server
    server.tool('dynamic', { description: 'Added at runtime' }, async (input) => ({
      runtime: true,
      input,
    }));

    // Now list again
    list = await client.listRemoteTools(sessionId);
    assert.equal(list.tools.length, 1);
    assert.equal(list.tools[0].name, 'dynamic');

    // And invoke it
    const result = await client.callTool(sessionId, 'dynamic', { x: 1 });
    assert.deepEqual(result.output, { runtime: true, input: { x: 1 } });
  });

  it('removed tools return NOT_FOUND remotely', async () => {
    ({ server, client, sessionId, cleanup } = await createConnectedPair({
      serverTools: [{ name: 'ephemeral', handler: async () => 'bye' }],
    }));

    // Works initially
    const r1 = await client.callTool(sessionId, 'ephemeral', {});
    assert.equal(r1.output, 'bye');

    // Remove it
    server.removeTool('ephemeral');

    // Now it should fail
    await assert.rejects(
      () => client.callTool(sessionId, 'ephemeral', {}),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, ToolErrorCode.REMOTE_ERROR);
        return true;
      },
    );
  });
});

# @agenium/mcp-server

> 🔍 **Need to find MCP servers?** [Search 2,000+ MCP servers instantly →](https://agenium.net/search)

Bridge [MCP](https://modelcontextprotocol.io/) (Model Context Protocol) servers to the [AGENIUM](https://agenium.net) `agent://` network.

Any MCP server → discoverable, callable agent on the AGENIUM network.

## Install

```bash
npm install @agenium/mcp-server
```

## Quick Start

### Expose an MCP server as an AGENIUM agent

```typescript
import { MCPBridge } from '@agenium/mcp-server';

const bridge = new MCPBridge({
  name: 'weather-tools',
  mcp: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-weather'],
  },
  agent: {
    publicHost: '203.0.113.1', // Your server's public IP
  },
});

await bridge.start();
// ✅ MCP server connected
// ✅ Found 2 tools: get_forecast, get_alerts
// ✅ AGENIUM agent "weather-tools" started
// ✅ Registered on AGENIUM DNS as agent://weather-tools

console.log(bridge.getTools());
// [{ name: 'get_forecast', description: '...', inputSchema: {...} }, ...]
```

### Call tools on a remote MCP-bridged agent

```typescript
import { MCPAgentClient } from '@agenium/mcp-server';

const client = new MCPAgentClient('my-agent');
await client.start();

// Discover what tools an agent has
const info = await client.discover('agent://weather-tools');
console.log(info.tools);

// Call a tool
const result = await client.callTool('agent://weather-tools', 'get_forecast', {
  city: 'Tehran',
  days: 3,
});
console.log(result.content);

await client.stop();
```

## Configuration

### MCPBridgeConfig

```typescript
{
  // Agent name on the AGENIUM network
  name: string;

  // MCP server configuration
  mcp: {
    // stdio: spawn a child process
    transport: 'stdio';
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  } | {
    // SSE: connect to running server
    transport: 'sse';
    url: string;
    headers?: Record<string, string>;
  } | {
    // Streamable HTTP (MCP v2)
    transport: 'streamable-http';
    url: string;
    headers?: Record<string, string>;
  };

  // AGENIUM agent options
  agent?: {
    port?: number;           // Listen port (default: auto)
    dnsServer?: string;      // DNS server (default: 185.204.169.26)
    dnsPort?: number;        // DNS port (default: 3000)
    autoRegister?: boolean;  // Register on DNS (default: true)
    publicHost?: string;     // Public IP for registration
    dataDir?: string;        // State directory
  };

  // Bridge behavior
  bridge?: {
    toolCallTimeoutMs?: number;  // Tool call timeout (default: 30s)
    exposeResources?: boolean;   // Expose MCP resources (default: true)
    exposePrompts?: boolean;     // Expose MCP prompts (default: true)
    logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  };
}
```

## Protocol

When an MCP server is bridged, it exposes these `agent://` request methods:

| Method | Description | Params |
|--------|-------------|--------|
| `tools/list` | List available tools | — |
| `tools/call` | Call a tool | `{ name, arguments? }` |
| `resources/list` | List available resources | — |
| `resources/read` | Read a resource | `{ uri }` |
| `prompts/list` | List available prompts | — |
| `prompts/get` | Get a prompt | `{ name, arguments? }` |
| `capabilities` | Get full capability manifest | — |
| `ping` | Health check | — |

## Events

```typescript
bridge.on('ready', ({ tools, resources, prompts }) => { ... });
bridge.on('registered', ({ name, endpoint }) => { ... });
bridge.on('tool:call', ({ tool, sessionId }) => { ... });
bridge.on('tool:result', ({ tool, sessionId, durationMs }) => { ... });
bridge.on('tool:error', ({ tool, sessionId, error }) => { ... });
bridge.on('error', (err) => { ... });
bridge.on('stopped', () => { ... });
```

## How It Works

```
┌─────────────┐     agent://      ┌──────────────┐     JSON-RPC      ┌────────────┐
│ Agent Client │ ──────────────▶  │  MCP Bridge   │ ──────────────▶  │ MCP Server │
│              │                  │  (@agenium/   │                  │ (any tool) │
│ Any AGENIUM  │  ◀──────────────  │  mcp-server)  │  ◀──────────────  │            │
│ agent        │     response     │               │    tool result   │            │
└─────────────┘                  └──────────────┘                  └────────────┘
                                       │
                                       │ registers
                                       ▼
                                 ┌──────────────┐
                                 │ AGENIUM DNS  │
                                 │ 185.204.169.26│
                                 └──────────────┘
```

## Python SDK

A Python version (`agenium-mcp-server`) is planned. For now, use the npm package.

## 🔍 Find MCP Servers

**[Search 2,000+ MCP servers →](https://agenium.net/search)** — Find tools, APIs, and services to bridge to the agent:// network.

## License

MIT

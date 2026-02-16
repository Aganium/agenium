<p align="center">
  <b>@agenium/mcp-server</b>
</p>

<h2 align="center">Bridge Any MCP Server to the Agent Network</h2>

<p align="center">
  Turn your <a href="https://modelcontextprotocol.io/">MCP</a> servers into discoverable, callable agents on the <a href="https://agenium.net?utm_source=npm&utm_medium=readme&utm_campaign=mcp-server">AGENIUM</a> <code>agent://</code> network.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@agenium/mcp-server"><img src="https://img.shields.io/npm/v/@agenium/mcp-server.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@agenium/mcp-server"><img src="https://img.shields.io/npm/dm/@agenium/mcp-server.svg" alt="npm downloads" /></a>
  <a href="https://github.com/Aganium/agenium/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@agenium/mcp-server.svg" alt="license" /></a>
</p>

<p align="center">
  <a href="https://docs.agenium.net?utm_source=npm&utm_medium=readme&utm_campaign=mcp-server">Docs</a> •
  <a href="https://demo.agenium.net?utm_source=npm&utm_medium=readme&utm_campaign=mcp-server">Live Demo</a> •
  <a href="https://agenium.net/search?utm_source=npm&utm_medium=readme&utm_campaign=mcp-server">Find MCP Servers</a> •
  <a href="https://discord.gg/agenium">Discord</a>
</p>

---

## What It Does

**MCP gives agents tools. AGENIUM gives agents identity.**

This package bridges the gap: take any MCP server and make it discoverable on the `agent://` network. Other agents can find it by name, see its capabilities, and call its tools — no manual configuration.

```
MCP Server (local tools) → @agenium/mcp-server → agent://weather-tools (network-discoverable)
```

## Install

```bash
npm install @agenium/mcp-server
```

## Quick Start — 5 Lines of Code

```typescript
import { MCPBridge } from '@agenium/mcp-server';

const bridge = new MCPBridge({
  name: 'weather-tools',
  mcp: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-weather'],
  },
});

await bridge.start();
// ✅ MCP server connected — found 2 tools
// ✅ Registered as agent://weather-tools
// ✅ Any agent can now discover and call your tools
```

## Call Remote MCP Tools

```typescript
import { MCPAgentClient } from '@agenium/mcp-server';

const client = new MCPAgentClient('my-agent');
await client.start();

// Discover what tools an agent has
const info = await client.discover('agent://weather-tools');
console.log(info.tools);
// → [{ name: 'get_forecast', ... }, { name: 'get_alerts', ... }]

// Call a tool remotely
const result = await client.callTool('agent://weather-tools', 'get_forecast', {
  city: 'San Francisco',
  days: 3,
});
```

## Supported Transports

| Transport | Use Case |
|-----------|----------|
| `stdio` | Spawn MCP server as child process (most common) |
| `sse` | Connect to running MCP server via SSE |
| `streamable-http` | MCP v2 streamable HTTP transport |

## Protocol — What Gets Exposed

When bridged, your MCP server's capabilities are available as `agent://` methods:

| Method | Description |
|--------|-------------|
| `tools/list` | List available tools |
| `tools/call` | Call a tool |
| `resources/list` | List available resources |
| `resources/read` | Read a resource |
| `prompts/list` | List available prompts |
| `prompts/get` | Get a prompt |
| `capabilities` | Full capability manifest |
| `ping` | Health check |

## Events

```typescript
bridge.on('ready', ({ tools, resources, prompts }) => { /* MCP connected */ });
bridge.on('registered', ({ name, endpoint }) => { /* On agent:// network */ });
bridge.on('tool:call', ({ tool, sessionId }) => { /* Tool invoked */ });
bridge.on('tool:result', ({ tool, durationMs }) => { /* Tool completed */ });
bridge.on('error', (err) => { /* Handle errors */ });
```

## Configuration

```typescript
const bridge = new MCPBridge({
  name: string;                    // Agent name on the network

  mcp: {
    transport: 'stdio' | 'sse' | 'streamable-http';
    command?: string;              // For stdio
    args?: string[];               // For stdio
    url?: string;                  // For sse/streamable-http
    headers?: Record<string, string>;
  };

  agent?: {
    port?: number;                 // Listen port (default: auto)
    publicHost?: string;           // Your public IP
    autoRegister?: boolean;        // Register on DNS (default: true)
  };

  bridge?: {
    toolCallTimeoutMs?: number;    // Timeout (default: 30s)
    exposeResources?: boolean;     // Expose resources (default: true)
    exposePrompts?: boolean;       // Expose prompts (default: true)
  };
});
```

## How It Works

```
┌──────────────┐    agent://     ┌──────────────┐    JSON-RPC     ┌────────────┐
│ Any Agent    │ ──────────────► │ MCP Bridge   │ ─────────────► │ MCP Server │
│ on network   │                 │ @agenium/    │                │ (any tool) │
│              │ ◄────────────── │ mcp-server   │ ◄───────────── │            │
└──────────────┘   response      └──────┬───────┘   result       └────────────┘
                                        │ registers
                                        ▼
                                  ┌────────────┐
                                  │ AGENIUM    │
                                  │ DNS Network│
                                  └────────────┘
```

## Part of the AGENIUM Ecosystem

| Package | Description |
|---------|-------------|
| [`agenium`](https://www.npmjs.com/package/agenium?utm_source=npm&utm_medium=readme&utm_campaign=mcp-server) | Core agent SDK |
| [`@agenium/create-agent`](https://www.npmjs.com/package/@agenium/create-agent?utm_source=npm&utm_medium=readme&utm_campaign=mcp-server) | Scaffold agents in 60 seconds |
| **`@agenium/mcp-server`** | **← You are here** |

## 🔍 Find MCP Servers to Bridge

**[Search 2,000+ MCP servers →](https://agenium.net/search?utm_source=npm&utm_medium=readme&utm_campaign=mcp-server)**

Find tools, APIs, and services to bridge to the `agent://` network — searchable by capability, language, and use case.

## Links

- 📖 [Documentation](https://docs.agenium.net?utm_source=npm&utm_medium=readme&utm_campaign=mcp-server)
- 🤖 [Live Demo](https://demo.agenium.net?utm_source=npm&utm_medium=readme&utm_campaign=mcp-server) — 4 working agents
- 💬 [Discord](https://discord.gg/agenium) — Community & support
- 🐦 [Twitter/X](https://x.com/AgeniumPlatform)

## License

MIT © [AGENIUM](https://agenium.net?utm_source=npm&utm_medium=readme&utm_campaign=mcp-server)

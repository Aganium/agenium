# AGENIUM

> 🔍 **Can't find the right MCP server?** [Search 2,000+ MCP servers instantly →](https://agenium.net/search)

Stateful agent-to-agent communication client for the `agent://` protocol.

## What is AGENIUM?

AGENIUM provides identity, discovery, and messaging for AI agents. Think of it as DNS + HTTP for agents — each agent gets a unique `agent://name` URI and can discover and communicate with other agents.

## Quick Start

### Create a New Agent (Recommended)

```bash
npx @agenium/create-agent my-agent
cd my-agent
npm install
npm start
```

Choose from 3 templates: **echo** (hello world), **tools** (tool-calling), **api** (REST gateway).

### Use as a Library

```bash
npm install agenium
```

```typescript
import { AgeniumClient } from 'agenium';

const client = new AgeniumClient({
  apiKey: 'dom_your_api_key_here',  // Get one at marketplace.agenium.net
  agentUri: 'agent://myagent',
});

// Resolve another agent
const target = await client.resolve('agent://search');
console.log(target.endpoint); // https://...

// Connect and send message
const session = await client.connect('agent://search');
await session.send({ query: 'find MCP servers for GitHub' });
const response = await session.receive();
```

## Features

- **`agent://` Protocol** — Unique agent identity via URI scheme
- **DNS Resolution** — Discover agents by name (`agent://name` → endpoint)
- **Stateful Sessions** — SQLite-backed persistent sessions
- **HTTP/2 + mTLS** — Secure transport with mutual TLS
- **At-Least-Once Delivery** — Outbox pattern for reliable messaging
- **Circuit Breakers** — Automatic failure detection and recovery
- **Prometheus Metrics** — Built-in observability

## Getting an API Key

1. Visit [marketplace.agenium.net](https://marketplace.agenium.net)
2. Register a domain name (e.g., `agent://myagent`)
3. Complete purchase (TON payment)
4. Save your API key (shown only once)

## CLI

```bash
# Initialize agent configuration
agenium init

# Resolve an agent
agenium resolve agent://search

# Check connection
agenium status

# End-to-end connectivity test
agenium e2e
```

## Architecture

```
agent://myagent                    agent://search
     │                                  │
     ├── resolve("agent://search") ────►│
     │   (DNS lookup via marketplace)   │
     │◄── endpoint: https://...  ───────┤
     │                                  │
     ├── POST /a2a/message ────────────►│
     │   (HTTP/2 + mTLS)               │
     │◄── response ────────────────────┤
```

## Configuration

```typescript
const client = new AgeniumClient({
  // Required
  apiKey: 'dom_xxx',           // Your marketplace API key
  agentUri: 'agent://myname',  // Your agent URI

  // Optional
  dnsServer: 'https://marketplace.agenium.net',  // DNS resolver
  dataDir: './data',           // SQLite session storage
  timeout: 30000,              // Request timeout (ms)
  retries: 3,                  // Max retry attempts
});
```

## API Reference

### `client.resolve(agentUri)`
Resolve an agent URI to its endpoint and capabilities.

### `client.connect(agentUri)`
Establish a stateful session with another agent.

### `session.send(message)`
Send a message in an active session.

### `session.receive()`
Receive the next message in a session.

### `session.close()`
Gracefully close a session.

## Protocol Services

The AGENIUM ecosystem includes:

| Service | URI | Description |
|---------|-----|-------------|
| Search | `agent://agenium` | Agent & tool discovery engine |
| Marketplace | [marketplace.agenium.net](https://marketplace.agenium.net) | Domain registration & credentials |

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Build
npm run build

# Run E2E tests
npm run e2e
```

## Tests

56 tests passing:
- 22 unit tests
- 24 bug-server integration tests
- 10 end-to-end tests

## License

MIT

## Ecosystem

| Package | Description |
|---------|-------------|
| [`agenium`](https://npm.im/agenium) | Core client SDK |
| [`@agenium/create-agent`](https://github.com/Aganium/create-agenium-agent) | CLI scaffold tool |
| [`@agenium/mcp-server`](https://npm.im/@agenium/mcp-server) | MCP → agent:// bridge |
| [`discord-agenium`](https://npm.im/discord-agenium) | Discord bot gateway |
| [`slack-agenium`](https://npm.im/slack-agenium) | Slack app gateway |
| [`n8n-nodes-agenium`](https://npm.im/n8n-nodes-agenium) | n8n automation nodes |

## 🔍 MCP Server Search

Looking for MCP servers to connect your agents to? **[Search 2,000+ MCP servers →](https://agenium.net/search)**

Find tools, APIs, and services your agents can use — searchable by capability, language, and use case.

## Links

- **MCP Search: [agenium.net/search](https://agenium.net/search)**
- Website: [agenium.net](https://agenium.net)
- Docs: [docs.agenium.net](https://docs.agenium.net)
- Demo: [demo.agenium.net](https://demo.agenium.net)
- Marketplace: [marketplace.agenium.net](https://marketplace.agenium.net)
- Organization: [github.com/Aganium](https://github.com/Aganium)

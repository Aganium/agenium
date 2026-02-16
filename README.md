<p align="center">
  <img src="https://agenium.net/logo.png" alt="AGENIUM" width="120" />
</p>

<h1 align="center">AGENIUM</h1>

<p align="center">
  <b>DNS of the Agent Web</b> — Identity, discovery & communication for AI agents.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/agenium"><img src="https://img.shields.io/npm/v/agenium.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/agenium"><img src="https://img.shields.io/npm/dm/agenium.svg" alt="npm downloads" /></a>
  <a href="https://github.com/Aganium/agenium/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/agenium.svg" alt="license" /></a>
  <a href="https://github.com/Aganium/agenium"><img src="https://img.shields.io/github/stars/Aganium/agenium" alt="GitHub stars" /></a>
</p>

<p align="center">
  <a href="https://docs.agenium.net?utm_source=npm&utm_medium=readme&utm_campaign=agenium-core">Docs</a> •
  <a href="https://demo.agenium.net?utm_source=npm&utm_medium=readme&utm_campaign=agenium-core">Live Demo</a> •
  <a href="https://agenium.net/search?utm_source=npm&utm_medium=readme&utm_campaign=agenium-core">MCP Search</a> •
  <a href="https://discord.gg/agenium">Discord</a>
</p>

---

## The Problem

AI agents can't find each other. MCP gives agents **tools**, but there's no standard way for agents to get **identity**, **discovery**, or **direct communication**. Every integration is point-to-point.

## The Solution

AGENIUM is **DNS for AI agents**. Every agent gets a unique `agent://name` URI. Agents discover each other by name, verify trust, and communicate — just like websites use domain names.

```
agent://weather  →  resolves to endpoint + capabilities + trust score
agent://search   →  find any agent by what it does
agent://my-bot   →  your agent, your identity
```

## Get Started in 60 Seconds

```bash
npx @agenium/create-agent my-agent
cd my-agent
npm start
```

**That's it.** Your agent is live on the `agent://` network.

Or use as a library:

```bash
npm install agenium
```

```typescript
import { AgeniumClient } from 'agenium';

const client = new AgeniumClient({
  apiKey: 'dom_your_key',
  agentUri: 'agent://myagent',
});

// Discover any agent by name
const target = await client.resolve('agent://search');

// Connect and communicate
const session = await client.connect('agent://search');
await session.send({ query: 'find weather tools' });
const response = await session.receive();
```

## Why AGENIUM?

| Feature | Without AGENIUM | With AGENIUM |
|---------|----------------|--------------|
| **Identity** | Hardcoded URLs | `agent://name` URIs |
| **Discovery** | Manual config | DNS-style resolution |
| **Communication** | REST/WebSocket patchwork | Stateful sessions + mTLS |
| **Trust** | None | Capability manifests + trust scores |
| **MCP Integration** | Tools only | Tools → discoverable agents |

## Features

- **`agent://` Protocol** — Unique identity via URI scheme (like `https://` for agents)
- **DNS Resolution** — `agent://name` → endpoint + capabilities
- **MCP Bridge** — Any MCP server → discoverable agent ([`@agenium/mcp-server`](https://www.npmjs.com/package/@agenium/mcp-server?utm_source=npm&utm_medium=readme&utm_campaign=agenium-core))
- **Stateful Sessions** — SQLite-backed persistent conversations
- **HTTP/2 + mTLS** — Secure transport with mutual TLS
- **At-Least-Once Delivery** — Outbox pattern with retries
- **Capability Manifests** — Agents declare what they can do
- **56 Tests** — Unit, integration, and E2E coverage

## Ecosystem

| Package | What it does |
|---------|-------------|
| [`agenium`](https://www.npmjs.com/package/agenium) | Core client SDK |
| [`@agenium/create-agent`](https://www.npmjs.com/package/@agenium/create-agent?utm_source=npm&utm_medium=readme&utm_campaign=agenium-core) | Scaffold agents in 60 seconds |
| [`@agenium/mcp-server`](https://www.npmjs.com/package/@agenium/mcp-server?utm_source=npm&utm_medium=readme&utm_campaign=agenium-core) | Bridge MCP servers → agent:// network |
| [`discord-agenium`](https://www.npmjs.com/package/discord-agenium?utm_source=npm&utm_medium=readme&utm_campaign=agenium-core) | Discord bot gateway |
| [`slack-agenium`](https://www.npmjs.com/package/slack-agenium?utm_source=npm&utm_medium=readme&utm_campaign=agenium-core) | Slack app gateway |
| [`n8n-nodes-agenium`](https://www.npmjs.com/package/n8n-nodes-agenium?utm_source=npm&utm_medium=readme&utm_campaign=agenium-core) | n8n automation nodes |
| [`agenium`](https://pypi.org/project/agenium/?utm_source=npm&utm_medium=readme&utm_campaign=agenium-core) (PyPI) | Python SDK |

## Architecture

```
Your Agent                              Remote Agent
agent://mybot                          agent://weather
     │                                      │
     ├── resolve("agent://weather") ───────►│
     │   (DNS via AGENIUM network)          │
     │◄── endpoint + capabilities ──────────┤
     │                                      │
     ├── connect (HTTP/2 + mTLS) ──────────►│
     │   (stateful session)                 │
     │◄── response ─────────────────────────┤
```

## 🔍 Find MCP Servers

**[Search 2,000+ MCP servers →](https://agenium.net/search?utm_source=npm&utm_medium=readme&utm_campaign=agenium-core)**

Looking for AI tools to connect to? Search by capability, language, or use case.

## Links

- 📖 **[Documentation](https://docs.agenium.net?utm_source=npm&utm_medium=readme&utm_campaign=agenium-core)**
- 🤖 **[Live Demo](https://demo.agenium.net?utm_source=npm&utm_medium=readme&utm_campaign=agenium-core)** — Try 4 working agents
- 🔍 **[MCP Search](https://agenium.net/search?utm_source=npm&utm_medium=readme&utm_campaign=agenium-core)** — Find any MCP server
- 💬 **[Discord](https://discord.gg/agenium)** — Community & support
- 🐦 **[Twitter/X](https://x.com/AgeniumPlatform)**
- 📝 **[Blog](https://dev.to/agenium_platform?utm_source=npm&utm_medium=readme&utm_campaign=agenium-core)**

## License

MIT © [AGENIUM](https://agenium.net?utm_source=npm&utm_medium=readme&utm_campaign=agenium-core)

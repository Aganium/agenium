<p align="center">
  <b>@agenium/create-agent</b>
</p>

<h2 align="center">Create an AI Agent in 60 Seconds</h2>

<p align="center">
  Scaffold a production-ready agent on the <a href="https://agenium.net?utm_source=npm&utm_medium=readme&utm_campaign=create-agent">AGENIUM</a> <code>agent://</code> network — with identity, discovery, and communication built in.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@agenium/create-agent"><img src="https://img.shields.io/npm/v/@agenium/create-agent.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@agenium/create-agent"><img src="https://img.shields.io/npm/dm/@agenium/create-agent.svg" alt="npm downloads" /></a>
  <a href="https://github.com/Aganium/agenium/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@agenium/create-agent.svg" alt="license" /></a>
</p>

<p align="center">
  <a href="https://docs.agenium.net?utm_source=npm&utm_medium=readme&utm_campaign=create-agent">Docs</a> •
  <a href="https://demo.agenium.net?utm_source=npm&utm_medium=readme&utm_campaign=create-agent">Live Demo</a> •
  <a href="https://agenium.net/search?utm_source=npm&utm_medium=readme&utm_campaign=create-agent">Find MCP Servers</a> •
  <a href="https://discord.gg/agenium">Discord</a>
</p>

---

## Quick Start

```bash
npx @agenium/create-agent my-agent
cd my-agent
npm start
```

**Done.** Your agent has an `agent://my-agent` identity and is live on the network.

## Why?

Building an AI agent shouldn't require wiring up HTTP servers, TLS certs, and service discovery from scratch. This scaffold gives you:

- ✅ **Identity** — `agent://name` URI on the AGENIUM network
- ✅ **Discovery** — Other agents find yours by name
- ✅ **Communication** — Stateful sessions with mTLS
- ✅ **Docker** — Production-ready container included
- ✅ **TypeScript** — Full type safety

## Templates

| Template | Best for | What you get |
|----------|----------|-------------|
| `echo` | Hello world | Minimal agent — echo, ping, info |
| `tools` | Custom logic | Add your own tools and handlers |
| `api` | REST wrappers | Expose any REST API as agent tools |

```bash
# Choose a template
npx @agenium/create-agent my-agent --template=tools

# Non-interactive (use defaults)
npx @agenium/create-agent my-agent --yes
```

## What Gets Generated

```
my-agent/
├── src/index.ts      # Your agent (edit this!)
├── package.json      # agenium SDK pre-installed
├── tsconfig.json     # TypeScript ready
├── Dockerfile        # Deploy anywhere
├── .env              # API key goes here
└── README.md         # Project docs
```

## Next Steps

1. **Edit** `src/index.ts` — add your tools and logic
2. **Run** `npm run dev` — test locally
3. **Register** at [marketplace.agenium.net](https://marketplace.agenium.net?utm_source=npm&utm_medium=readme&utm_campaign=create-agent) — get your API key
4. **Deploy** — `npm run docker:build` for production

## Options

| Flag | Description |
|------|-------------|
| `--template=<name>` | `echo`, `tools`, or `api` |
| `--port=<number>` | Listen port (default: 9001) |
| `--yes` / `-y` | Non-interactive mode |
| `--no-install` | Skip npm install |
| `--no-git` | Skip git init |

## Part of the AGENIUM Ecosystem

| Package | Description |
|---------|-------------|
| [`agenium`](https://www.npmjs.com/package/agenium?utm_source=npm&utm_medium=readme&utm_campaign=create-agent) | Core agent SDK |
| **`@agenium/create-agent`** | **← You are here** |
| [`@agenium/mcp-server`](https://www.npmjs.com/package/@agenium/mcp-server?utm_source=npm&utm_medium=readme&utm_campaign=create-agent) | Bridge MCP servers → agent:// |

## 🔍 Find MCP Servers

**[Search 2,000+ MCP servers →](https://agenium.net/search?utm_source=npm&utm_medium=readme&utm_campaign=create-agent)**

## Links

- 📖 [Documentation](https://docs.agenium.net?utm_source=npm&utm_medium=readme&utm_campaign=create-agent)
- 🤖 [Live Demo](https://demo.agenium.net?utm_source=npm&utm_medium=readme&utm_campaign=create-agent)
- 💬 [Discord](https://discord.gg/agenium)
- 🐦 [Twitter/X](https://x.com/AgeniumPlatform)

## License

MIT © [AGENIUM](https://agenium.net?utm_source=npm&utm_medium=readme&utm_campaign=create-agent)

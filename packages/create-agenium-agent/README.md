# @agenium/create-agent

> 🔍 **Looking for MCP servers to connect?** [Search 2,000+ MCP servers →](https://agenium.net/search)

Scaffold an [AGENIUM](https://agenium.net) agent in under 3 minutes.

## Quick Start

```bash
npx @agenium/create-agent my-agent
cd my-agent
npm run dev
```

## Usage

```bash
# Interactive mode (prompts for all options)
npx @agenium/create-agent

# Named project
npx @agenium/create-agent my-agent

# Skip prompts — use defaults
npx @agenium/create-agent my-agent --yes

# Choose a template
npx @agenium/create-agent my-agent --template=tools

# From GitHub (if npm is unavailable)
git clone https://github.com/Aganium/agenium.git
node agenium/packages/create-agenium-agent/dist/index.js my-agent
```

## Templates

| Template | Description |
|----------|-------------|
| `echo`   | Minimal agent — echo, ping, info tools |
| `tools`  | Custom tools starter — add your own logic |
| `api`    | API wrapper — expose a REST API as agent tools |

## What Gets Generated

```
my-agent/
├── src/index.ts      # Agent implementation
├── package.json       # Dependencies (agenium@^0.2.0)
├── tsconfig.json      # TypeScript config
├── Dockerfile         # Production Docker image
├── .env               # Environment variables
├── .env.example       # Template for env vars
├── .gitignore
└── README.md          # Project-specific docs
```

## Next Steps After Scaffolding

1. **Edit** `src/index.ts` — add your own tools
2. **Run** `npm run dev` — starts the agent locally
3. **Register** — get an API key from [marketplace.agenium.net](https://marketplace.agenium.net) to register on the `agent://` network
4. **Deploy** — `npm run docker:build` for production

## Options

| Flag | Description |
|------|-------------|
| `--template=<name>` | Template: `echo`, `tools`, `api` |
| `--port=<number>` | Listen port (default: 9001) |
| `--yes` / `-y` | Non-interactive, use all defaults |
| `--no-install` | Skip `npm install` |
| `--no-git` | Skip `git init` |

## Links

- 📖 [Documentation](https://docs.agenium.net)
- 🤖 [AGENIUM Protocol](https://agenium.net)
- 💬 [Community](https://discord.gg/agenium)

## License

MIT

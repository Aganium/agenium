# Blueprint: Server Log Analyzer Agent

> **`agent://log-analyzer`** — Real-time server log analysis via the AGENIUM protocol

A practical agent that parses, searches, and summarizes server logs (nginx, syslog, application logs). Deploy it on your server and let other agents or clients query your logs in natural language.

## Why?

Every DevOps team spends hours grep-ing through logs. This agent turns any server's logs into a queryable service via `agent://` — accessible to other AI agents, monitoring tools, or your own scripts.

## Tools

| Tool | Description |
|------|-------------|
| `search` | Search logs by pattern (regex or text), time range, severity |
| `stats` | Error rates, request counts, top IPs, status code distribution |
| `tail` | Live tail of recent log entries |
| `health` | Quick health summary: error spike detection, anomaly flags |

## Quick Start

```bash
# Clone and install
git clone https://github.com/Aganium/agenium.git
cd agenium/blueprints/log-analyzer
npm install

# Run locally (analyzes sample logs)
npx tsx agent.ts

# Run with your own logs
LOG_PATH=/var/log/nginx/access.log npx tsx agent.ts

# Run with DNS registration
DNS_API_KEY=dom_xxx PUBLIC_HOST=myserver.com npx tsx agent.ts
```

## Docker

```bash
docker build -t log-analyzer .
docker run -v /var/log:/logs -e LOG_PATH=/logs/nginx/access.log -p 9010:9010 log-analyzer
```

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `LOG_PATH` | `./sample.log` | Path to log file to analyze |
| `LOG_FORMAT` | `auto` | Log format: `auto`, `nginx`, `syslog`, `json` |
| `PORT` | `9010` | Agent listen port |
| `DNS_API_KEY` | — | AGENIUM marketplace API key |
| `PUBLIC_HOST` | `localhost` | Public hostname for DNS |
| `DNS_SERVER` | `185.204.169.26:3000` | DNS server address |
| `MAX_LINES` | `10000` | Max lines to keep in memory |

## Example Usage

### From another AGENIUM agent:

```typescript
import { AgeniumClient } from 'agenium';

const client = new AgeniumClient({ apiKey: 'dom_xxx', agentUri: 'agent://my-monitor' });
const session = await client.connect('agent://log-analyzer');

// Search for errors in the last hour
await session.invoke('search', {
  pattern: 'error|500|503',
  since: '1h',
  severity: 'error'
});

// Get traffic stats
await session.invoke('stats', { period: '24h' });

// Quick health check
await session.invoke('health', {});
```

### From CLI:

```bash
agenium resolve agent://log-analyzer
agenium invoke agent://log-analyzer search '{"pattern": "404", "since": "1h"}'
```

## Architecture

```
┌─────────────────────────┐
│   Your Server            │
│                          │
│  /var/log/nginx/*.log ──►│
│  /var/log/syslog     ──►│──► agent://log-analyzer
│  /app/logs/*.json    ──►│       │
│                          │       ├── search(pattern, since)
│                          │       ├── stats(period)  
│                          │       ├── tail(lines)
│                          │       └── health()
└─────────────────────────┘
         ▲
         │ agent:// protocol
         ▼
┌─────────────────────────┐
│  Other Agents / Clients  │
│  - Monitoring dashboard  │
│  - Alert agent           │
│  - ChatOps bot           │
└─────────────────────────┘
```

## License

MIT — Part of the [AGENIUM](https://github.com/Aganium/agenium) project.

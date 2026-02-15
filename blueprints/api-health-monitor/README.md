# Blueprint: API Health Monitor Agent

> **`agent://api-monitor`** — Endpoint uptime monitoring & alerting via the AGENIUM protocol

A practical agent that continuously monitors HTTP/HTTPS endpoints, tracks response times, detects outages, and exposes health data to other agents or clients via `agent://`.

## Why?

Every team running APIs needs uptime monitoring. Most solutions are SaaS with monthly fees. This agent turns endpoint monitoring into a self-hosted, queryable service — accessible to other AI agents, dashboards, or ChatOps bots via `agent://`.

**Real-world use cases:**
- DevOps team monitoring production APIs
- Microservice health aggregation
- SLA compliance tracking
- Incident detection & alert routing to other agents

## Tools

| Tool | Description |
|------|-------------|
| `status` | Current status of all monitored endpoints |
| `history` | Response time & availability history for an endpoint |
| `incidents` | List of detected incidents (outages, slow responses) |
| `add` | Add a new endpoint to monitor |
| `remove` | Remove an endpoint from monitoring |

## Quick Start

```bash
# Clone and install
git clone https://github.com/Aganium/agenium.git
cd agenium/blueprints/api-health-monitor
npm install

# Run with sample endpoints
npx tsx agent.ts

# Run with your own config
ENDPOINTS_FILE=./my-endpoints.json npx tsx agent.ts

# Run with DNS registration
DNS_API_KEY=dom_xxx PUBLIC_HOST=myserver.com npx tsx agent.ts
```

## Docker

```bash
docker build -t api-monitor .
docker run -v ./endpoints.json:/app/blueprints/api-health-monitor/endpoints.json -p 9011:9011 api-monitor
```

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `ENDPOINTS_FILE` | `./endpoints.json` | Path to endpoints config |
| `CHECK_INTERVAL` | `60` | Seconds between health checks |
| `TIMEOUT_MS` | `10000` | Request timeout in milliseconds |
| `PORT` | `9011` | Agent listen port |
| `DNS_API_KEY` | — | AGENIUM marketplace API key |
| `PUBLIC_HOST` | `localhost` | Public hostname for DNS |
| `DNS_SERVER` | `185.204.169.26:3000` | DNS server address |
| `MAX_HISTORY` | `1440` | Max data points per endpoint (~24h at 1min) |
| `INCIDENT_THRESHOLD` | `3` | Consecutive failures before incident |

### Endpoints File Format

```json
[
  {
    "name": "Production API",
    "url": "https://api.example.com/health",
    "method": "GET",
    "expectedStatus": 200,
    "headers": { "Authorization": "Bearer xxx" }
  },
  {
    "name": "Database Check",
    "url": "https://api.example.com/db/ping",
    "method": "GET",
    "expectedStatus": 200
  }
]
```

## Example Usage

### From another AGENIUM agent:

```typescript
import { AgeniumClient } from 'agenium';

const client = new AgeniumClient({ apiKey: 'dom_xxx', agentUri: 'agent://my-app' });
const session = await client.connect('agent://api-monitor');

// Get current status of all endpoints
await session.invoke('status', {});

// Check history for a specific endpoint
await session.invoke('history', {
  endpoint: 'Production API',
  period: '6h'
});

// List active incidents
await session.invoke('incidents', { active: true });

// Add a new endpoint to monitor
await session.invoke('add', {
  name: 'Staging API',
  url: 'https://staging.example.com/health',
  expectedStatus: 200
});
```

### From CLI:

```bash
agenium invoke agent://api-monitor status '{}'
agenium invoke agent://api-monitor incidents '{"active": true}'
```

## Architecture

```
┌─────────────────────────────────┐
│   api-monitor agent              │
│                                  │
│  ┌──────────┐   ┌────────────┐  │
│  │ Scheduler │──►│ HTTP Probe │──┼──► Endpoint 1 (api.example.com)
│  │ (every N) │   │            │──┼──► Endpoint 2 (db.example.com)
│  └──────────┘   └────────────┘  │──► Endpoint 3 (cdn.example.com)
│       │                          │
│       ▼                          │
│  ┌──────────────────────────┐   │
│  │ History Store (in-memory) │   │
│  │ + Incident Detector       │   │
│  └──────────────────────────┘   │
│       │                          │
│       ▼                          │
│  agent:// tools                  │
│  ├── status()                    │
│  ├── history(endpoint, period)   │
│  ├── incidents(active?)          │
│  ├── add(name, url, ...)         │
│  └── remove(name)                │
└─────────────────────────────────┘
         ▲
         │ agent:// protocol
         ▼
┌─────────────────────────────────┐
│  Consumers                       │
│  - Alert agent (→ Slack/email)   │
│  - Dashboard                     │
│  - ChatOps bot                   │
│  - SLA report generator          │
└─────────────────────────────────┘
```

## License

MIT — Part of the [AGENIUM](https://github.com/Aganium/agenium) project.

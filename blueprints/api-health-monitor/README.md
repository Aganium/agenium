# Blueprint: API Health Monitor Agent

> **`agent://api-health`** — Continuous API endpoint monitoring via the AGENIUM protocol

A practical agent that monitors HTTP/HTTPS endpoints, tracks uptime and latency, detects outages, and exposes results through `agent://`. Other agents, dashboards, or alerting systems can query health status in real time.

## Why?

Every team monitors APIs — but monitoring tools are isolated silos. This agent turns your uptime checks into a queryable service that other AI agents can consume. Chain it with `agent://log-analyzer` to correlate outages with log errors.

## Tools

| Tool | Description |
|------|-------------|
| `check` | Run an immediate health check against a URL |
| `status` | Get current status of all monitored endpoints |
| `history` | Get uptime/latency history for an endpoint |
| `add` | Add a new endpoint to monitor |
| `remove` | Remove an endpoint from monitoring |

## Quick Start

```bash
# Clone and install
git clone https://github.com/Aganium/agenium.git
cd agenium/blueprints/api-health-monitor
npm install

# Run with default demo endpoints
npx tsx agent.ts

# Run with custom endpoints
ENDPOINTS='https://api.example.com,https://myapp.com/health' npx tsx agent.ts

# Run with DNS registration
DNS_API_KEY=dom_xxx PUBLIC_HOST=myserver.com npx tsx agent.ts
```

## Docker

```bash
docker build -t api-health .
docker run -e ENDPOINTS='https://api.example.com' -p 9011:9011 api-health
```

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `ENDPOINTS` | demo URLs | Comma-separated list of URLs to monitor |
| `CHECK_INTERVAL` | `60` | Seconds between checks per endpoint |
| `TIMEOUT_MS` | `10000` | Request timeout in milliseconds |
| `PORT` | `9011` | Agent listen port |
| `DNS_API_KEY` | — | AGENIUM marketplace API key |
| `PUBLIC_HOST` | `localhost` | Public hostname for DNS |
| `DNS_SERVER` | `185.204.169.26:3000` | DNS server address |
| `MAX_HISTORY` | `1440` | Max history entries per endpoint (~24h at 1/min) |

## Example Usage

### From another AGENIUM agent:

```typescript
import { AgeniumClient } from 'agenium';

const client = new AgeniumClient({ apiKey: 'dom_xxx', agentUri: 'agent://my-app' });
const session = await client.connect('agent://api-health');

// Check all endpoints
await session.invoke('status', {});

// Get uptime history for a specific URL
await session.invoke('history', {
  url: 'https://api.example.com',
  period: '24h'
});

// Add a new endpoint to monitor
await session.invoke('add', {
  url: 'https://new-service.com/health',
  name: 'New Service',
  interval: 30
});
```

### From CLI:

```bash
agenium invoke agent://api-health status '{}'
agenium invoke agent://api-health check '{"url": "https://myapi.com/health"}'
```

## Architecture

```
agent://api-health
    │
    ├── Scheduler (runs checks on interval)
    │       │
    │       ├── GET https://api-1.com/health ─── 200 OK (142ms)
    │       ├── GET https://api-2.com/health ─── 503 Error (timeout)
    │       └── GET https://api-3.com/ping   ─── 200 OK (89ms)
    │
    ├── History Store (in-memory ring buffer)
    │
    └── Tools API
            ├── check(url)           → instant probe
            ├── status()             → all endpoints status
            ├── history(url, period) → latency/uptime chart data
            ├── add(url, name)       → start monitoring
            └── remove(url)          → stop monitoring

         ▲ agent:// protocol
         │
    Other Agents / Clients
    ├── agent://log-analyzer (correlate outages with logs)
    ├── Alert pipelines
    └── Status dashboards
```

## License

MIT — Part of the [AGENIUM](https://github.com/Aganium/agenium) project.

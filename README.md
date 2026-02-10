# Agenium

> Local, stateful, agent-to-agent client software with automatic bug reporting.

[![npm version](https://img.shields.io/npm/v/agenium.svg)](https://www.npmjs.com/package/agenium)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Features

- 🔐 **Secure Transport**: HTTP/2 + mTLS encryption
- 🌐 **Agent Discovery**: `agent://` protocol with custom DNS
- 💾 **Stateful Sessions**: Persistent sessions with automatic resume
- 📬 **Reliable Messaging**: At-least-once delivery with outbox pattern
- 🐛 **Bug Reporting**: Non-blocking automatic error collection
- 📊 **Observability**: Prometheus metrics + health checks
- ⚡ **Production Ready**: Graceful shutdown, circuit breakers, timeouts

## Quick Start

### Install

```bash
npm install agenium
```

### Initialize

```bash
npx agenium init
```

### Resolve Agent

```bash
npx agenium resolve agent://alice.agent
```

### Programmatic Usage

```typescript
import { createAgent } from 'agenium';

// Create agent
const agent = await createAgent({
  agentId: 'my-agent',
  dataDir: './.agenium',
});

// Connect to remote agent
const session = await agent.connect('agent://alice.agent');

// Send request
const response = await session.request('hello', { message: 'Hi Alice!' });
console.log('Response:', response);

// Send event (fire-and-forget)
await session.emit('status', { online: true });

// Graceful shutdown
await agent.shutdown();
```

## Two-Agent Demo

### Terminal 1: Alice

```typescript
import { createAgent } from 'agenium';

const alice = await createAgent({ agentId: 'alice' });

// Listen for requests
alice.onRequest('hello', async (payload) => {
  console.log('Received:', payload.message);
  return { reply: 'Hello from Alice!' };
});

// Start server
await alice.listen(8080);
console.log('Alice listening on port 8080');
```

### Terminal 2: Bob

```typescript
import { createAgent } from 'agenium';

const bob = await createAgent({ agentId: 'bob' });

// Connect to Alice
const session = await bob.connect('agent://alice.agent');

// Send request
const response = await session.request('hello', { message: 'Hi from Bob!' });
console.log('Alice replied:', response.reply);
```

## CLI Commands

```bash
agenium init              # Initialize agent in current directory
agenium resolve <uri>     # Resolve agent:// URI
agenium connect <uri>     # Connect to agent
agenium status            # Show agent status
agenium e2e               # Run integration tests
```

## Configuration

### agenium.json

```json
{
  "agentId": "my-agent",
  "dataDir": "./.agenium",
  "dnsServer": "185.204.169.26",
  "metricsPort": 9090,
  "metricsHost": "127.0.0.1",
  "timeouts": {
    "dnsLookupMs": 10000,
    "handshakeMs": 10000,
    "requestMs": 30000
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `METRICS_PORT` | `9090` | Metrics server port |
| `METRICS_HOST` | `127.0.0.1` | Metrics bind address |
| `BUG_REPORT_URL` | - | Bug report server URL |
| `BUG_REPORT_TOKEN` | - | Bug report auth token |

## Bug Report Server

Agenium includes a separate bug report aggregation server.

```bash
cd bug-report-server
docker compose up -d
```

Or manually:

```bash
npm install
npm run build
BUG_REPORT_TOKEN=your-token npm start
```

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/bug-reports` | POST | Ingest report |
| `/api/bug-reports/recent` | GET | Recent reports |
| `/api/bug-reports/top` | GET | Top by occurrence |
| `/metrics` | GET | Prometheus metrics |
| `/health` | GET | Health check |

## Observability

### Prometheus Metrics

```promql
# Active sessions
agenium_sessions_active

# Outbox pending
agenium_outbox_pending

# DNS lookups
rate(agenium_dns_lookup_total[5m])

# Bug reports
agenium_bug_reports_sent_total{result="success"}
```

### Health Check

```bash
curl http://localhost:9090/health
```

```json
{
  "ok": true,
  "version": "0.1.0",
  "uptime": 3600,
  "sessions": { "active": 2, "suspended": 0 },
  "outbox": { "pending": 0 }
}
```

## Troubleshooting

### DNS Resolution Fails

Check DNS server reachability:
```bash
agenium resolve agent://test.agent
```

Increase timeout:
```bash
AGENIUM_DNS_TIMEOUT_MS=30000 agenium resolve agent://slow.agent
```

### Session Resume Fails

Clear local state and reconnect:
```bash
rm -rf .agenium/sessions.db
agenium connect agent://target.agent
```

### Outbox Growing

Check circuit breaker and remote agent connectivity:
```bash
curl http://localhost:9090/metrics | grep outbox
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      AGENIUM                            │
├─────────────────────────────────────────────────────────┤
│  CLI                                                    │
│  ├── init / resolve / connect / status / e2e           │
├─────────────────────────────────────────────────────────┤
│  Agent API                                              │
│  ├── createAgent() → Agent                             │
│  ├── agent.connect() → Session                         │
│  ├── session.request() / emit()                        │
├─────────────────────────────────────────────────────────┤
│  Protocol Layer                                         │
│  ├── REQUEST / RESPONSE / EVENT / ERROR                │
│  ├── Message dispatcher                                │
├─────────────────────────────────────────────────────────┤
│  Transport Layer                                        │
│  ├── HTTP/2 + mTLS                                     │
│  ├── Handshake (Ed25519 challenge/response)            │
├─────────────────────────────────────────────────────────┤
│  Persistence Layer                                      │
│  ├── SQLite (sessions.db)                              │
│  ├── Outbox (at-least-once)                            │
│  ├── Resume manager                                    │
├─────────────────────────────────────────────────────────┤
│  Observability                                          │
│  ├── Bug reporter (non-blocking)                       │
│  ├── Metrics server (/metrics, /health)                │
└─────────────────────────────────────────────────────────┘
```

## License

MIT © Agenium Team

## Contributing

1. Fork the repo
2. Create feature branch
3. Run tests: `npm test && npm run e2e`
4. Submit PR

See [CHANGELOG.md](CHANGELOG.md) for version history.

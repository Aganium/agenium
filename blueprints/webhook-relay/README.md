# Blueprint: Webhook Relay Agent

> **`agent://webhook-relay`** — Turn webhooks into a queryable event stream via AGENIUM protocol

A practical agent that receives webhooks (GitHub, Stripe, Slack, custom) via HTTP, stores events, and makes them queryable through `agent://`. Other agents can subscribe to events, search history, or get real-time notifications.

## Why?

Webhooks are fire-and-forget — if your handler is down, you lose events. This agent acts as a durable relay: it catches webhooks, stores them, and lets any `agent://`-connected service query the event stream. Perfect for building CI/CD pipelines, payment tracking, or multi-agent workflows.

## Tools

| Tool | Description |
|------|-------------|
| `events` | Query recent webhook events with filtering |
| `subscribe` | Register interest in specific event types |
| `sources` | List all webhook sources and their stats |
| `replay` | Replay a specific event (re-deliver) |
| `health` | Relay health: events/min, queue depth, sources |

## Quick Start

```bash
# Clone and install
git clone https://github.com/Aganium/agenium.git
cd agenium/blueprints/webhook-relay
npm install

# Run (webhook listener on :9012, agent on same port)
npx tsx agent.ts

# Point your webhooks to:
#   POST http://your-server:9012/webhook/:source
# Example:
#   GitHub webhook URL → http://myserver:9012/webhook/github
#   Stripe webhook URL → http://myserver:9012/webhook/stripe
```

## Docker

```bash
docker build -t webhook-relay .
docker run -p 9012:9012 webhook-relay
```

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `PORT` | `9012` | Agent + webhook listener port |
| `WEBHOOK_SECRET` | — | Optional shared secret for HMAC validation |
| `MAX_EVENTS` | `5000` | Max events to keep in memory |
| `DNS_API_KEY` | — | AGENIUM marketplace API key |
| `PUBLIC_HOST` | `localhost` | Public hostname for DNS |
| `DNS_SERVER` | `185.204.169.26:3000` | DNS server address |

## Webhook Endpoints

```
POST /webhook/:source          — Receive webhook from any source
POST /webhook/:source/:type    — Receive with explicit event type
GET  /webhook/health           — Relay health check
```

### Supported Headers

- `X-GitHub-Event` — auto-detected as GitHub event type
- `X-Stripe-Event` — Stripe event type
- `X-Webhook-Secret` — HMAC signature validation
- `Content-Type` — `application/json` or `application/x-www-form-urlencoded`

## Example Usage

### From another AGENIUM agent:

```typescript
import { AgeniumClient } from 'agenium';

const client = new AgeniumClient({ apiKey: 'dom_xxx', agentUri: 'agent://my-ci' });
const session = await client.connect('agent://webhook-relay');

// Get recent GitHub push events
await session.invoke('events', {
  source: 'github',
  type: 'push',
  limit: 10
});

// List all webhook sources
await session.invoke('sources', {});

// Replay a missed event
await session.invoke('replay', { eventId: 'evt_abc123' });
```

### Real-world pipeline:

```
GitHub push webhook
  → agent://webhook-relay (stores event)
  → agent://log-analyzer (checks for deploy errors)
  → agent://api-health (verifies endpoints after deploy)
```

## Architecture

```
External Services                    AGENIUM Network
─────────────────                    ───────────────
                                     
GitHub  ──POST──┐                    
Stripe  ──POST──┤                    agent://ci-bot
Slack   ──POST──┼──► agent://webhook-relay ◄──── agent://monitor
Custom  ──POST──┘        │                       agent://alerter
                         │
                   Event Store
                   (ring buffer)
                         │
                    Tools API
                    ├── events(source, type, since)
                    ├── subscribe(source, type)
                    ├── sources()
                    ├── replay(eventId)
                    └── health()
```

## License

MIT — Part of the [AGENIUM](https://github.com/Aganium/agenium) project.

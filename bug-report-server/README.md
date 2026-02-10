# AGENIUM Bug Report Server

Centralized bug report ingestion and aggregation service for Agenium agents.

## Features

- **Ingestion API**: Accept bug reports from agents with Zod validation
- **Deduplication**: Fingerprint-based aggregation (same error = same fingerprint)
- **Secret Redaction**: Automatically strips API keys, tokens, passwords
- **Multi-Agent Tracking**: See which agents report each error
- **Rate Limiting**: Per-agent-id request throttling
- **SQLite Storage**: WAL mode for crash safety

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Run (development)
npm run dev

# Run (production)
BUG_REPORT_TOKEN=your-secure-token npm start
```

## Docker

```bash
# Build and run
docker compose up -d

# With custom token
BUG_REPORT_TOKEN=my-secret-token docker compose up -d
```

## API Endpoints

### Ingest Report
```http
POST /api/bug-reports
Authorization: Bearer <token>
X-Agent-Id: my-agent-1

{
  "reportId": "unique-id",
  "agentId": "my-agent-1",
  "agentVersion": "1.0.0",
  "timestamp": 1234567890,
  "uptime": 3600,
  "errorType": "protocol",
  "errorCode": "HANDSHAKE_FAILED",
  "errorMessage": "Connection refused",
  "stackTrace": "Error: ...",
  "remoteAgent": "target-agent",
  "protocolVersion": "1.0.0"
}
```

Response:
```json
{
  "ok": true,
  "reportId": "unique-id",
  "fingerprint": "a2d5c20e0ca2af01",
  "isNew": true
}
```

### Get Recent Reports
```http
GET /api/bug-reports/recent?limit=100
Authorization: Bearer <token>
```

### Get Top Reports (by occurrence)
```http
GET /api/bug-reports/top?window=24h&limit=20
Authorization: Bearer <token>
```

### Get Report Details
```http
GET /api/bug-reports/:fingerprint
Authorization: Bearer <token>
```

### Get Statistics (public)
```http
GET /api/stats
```

### Health Check
```http
GET /health
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | 3100 | Server port |
| `DB_PATH` | `./bug-reports.db` | SQLite database path |
| `BUG_REPORT_TOKEN` | `dev-token-change-me` | Auth token |

## Database Schema

```sql
-- Main reports (deduplicated by fingerprint)
CREATE TABLE bug_reports (
  id INTEGER PRIMARY KEY,
  fingerprint TEXT UNIQUE,
  report_id TEXT,
  agent_id TEXT,
  error_type TEXT,
  error_code TEXT,
  error_message TEXT,
  stack_trace TEXT,
  occurrences INTEGER DEFAULT 1,
  first_seen INTEGER,
  last_seen INTEGER,
  agents_seen TEXT  -- JSON array
);

-- Individual events (for detailed tracking)
CREATE TABLE bug_events (
  id INTEGER PRIMARY KEY,
  fingerprint TEXT,
  report_id TEXT,
  agent_id TEXT,
  timestamp INTEGER
);

-- Agent instances
CREATE TABLE agent_instances (
  agent_id TEXT PRIMARY KEY,
  agent_version TEXT,
  first_seen INTEGER,
  last_seen INTEGER,
  report_count INTEGER
);
```

## Fingerprinting Algorithm

Fingerprints are computed from:
- `errorCode`
- `remoteAgent`
- Top 3 lines of stack trace
- `protocolVersion`
- `errorType`

```typescript
fingerprint = sha256(
  errorCode + "|" +
  remoteAgent + "|" +
  topStack + "|" +
  protocolVersion + "|" +
  errorType
).slice(0, 16)
```

## Demo

```bash
# Start server
npm start

# In another terminal, run demo
npx tsx demo.ts
```

Demo sends 4 reports (2 unique errors, each from 2 agents) and queries results.

## Integration with Agenium

The Agenium bug reporter uploads to this server automatically:

```typescript
const reporter = getBugReporter({
  serverUrl: 'http://localhost:3100/api/bug-reports',
  authToken: 'your-token',
  agentId: 'my-agent',
});

reporter.start();
reporter.reportError(error, 'protocol', sessionId);
```

## License

MIT

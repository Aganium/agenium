# Agenium v0.1.0 Release Runbook

## Prerequisites

- Node.js >= 20.0.0
- npm >= 10.0.0
- SQLite3 (bundled via better-sqlite3)

## Quick Start

### 1. Install

```bash
# From npm (when published)
npm install -g agenium

# From source
git clone https://github.com/agenium/agenium.git
cd agenium
npm install
npm run build
npm link
```

### 2. Initialize Agent

```bash
agenium init
```

Creates `agenium.json` and `.agenium/` directory.

### 3. Resolve Agent

```bash
agenium resolve agent://alice.agent
```

### 4. Check Status

```bash
agenium status
```

## Configuration Reference

### agenium.json

```json
{
  "agentId": "agent-abc123",
  "version": "0.1.0",
  "dataDir": "./.agenium",
  "dnsServer": "185.204.169.26",
  "metricsPort": 9090,
  "metricsHost": "127.0.0.1",
  "bugReportServer": "http://localhost:3100/api/bug-reports",
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
| `BUG_REPORT_URL` | `http://localhost:3100/api/bug-reports` | Bug report server |
| `BUG_REPORT_TOKEN` | `dev-token-change-me` | Bug report auth token |
| `AGENIUM_DNS_TIMEOUT_MS` | `10000` | DNS lookup timeout |
| `AGENIUM_HANDSHAKE_TIMEOUT_MS` | `10000` | TLS handshake timeout |
| `AGENIUM_REQUEST_TIMEOUT_MS` | `30000` | Request timeout |
| `AGENIUM_MAX_CONNECTIONS_PER_AGENT` | `4` | Connection pool size |
| `AGENIUM_CIRCUIT_BREAKER_THRESHOLD` | `5` | Failures before open |

## Bug Report Server Setup

### Docker (Recommended)

```bash
cd bug-report-server
docker compose up -d
```

### Manual

```bash
cd bug-report-server
npm install
npm run build
BUG_REPORT_TOKEN=your-secure-token npm start
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `DB_PATH` | `./bug-reports.db` | SQLite database path |
| `BUG_REPORT_TOKEN` | `dev-token-change-me` | Auth token |
| `METRICS_HOST` | `127.0.0.1` | Bind address |
| `SHUTDOWN_TIMEOUT_MS` | `5000` | Graceful shutdown timeout |

## Deployment Checklist

### Pre-Deploy

- [ ] Set secure `BUG_REPORT_TOKEN`
- [ ] Configure DNS server address
- [ ] Set appropriate timeouts for network conditions
- [ ] Decide metrics exposure (`127.0.0.1` vs `0.0.0.0`)

### Deploy

- [ ] Build: `npm run build`
- [ ] Test: `npm test && npm run e2e`
- [ ] Start bug report server
- [ ] Start agent
- [ ] Verify `/health` endpoint

### Monitor

- [ ] Prometheus scrape `/metrics`
- [ ] Alert on `agenium_sessions_resume_fail_total`
- [ ] Alert on `bug_reports_db_write_fail_total`
- [ ] Dashboard for session/outbox metrics

## Troubleshooting

### DNS Resolution Fails

```
Error: DNS lookup timed out
```

**Cause**: DNS server (185.204.169.26) unreachable

**Fix**:
1. Check network connectivity: `ping 185.204.169.26`
2. Increase timeout: `AGENIUM_DNS_TIMEOUT_MS=30000`
3. Check firewall allows outbound DNS (port 53)

### Handshake Fails

```
Error: TLS handshake timeout
```

**Cause**: Remote agent not responding or certificate mismatch

**Fix**:
1. Verify remote agent is running
2. Check certificate matches DNS record
3. Increase timeout: `AGENIUM_HANDSHAKE_TIMEOUT_MS=30000`

### Session Resume Fails

```
Error: Session resume rejected
```

**Cause**: Remote agent doesn't recognize session

**Fix**:
1. Clear local session: Delete `.agenium/sessions.db`
2. Reconnect fresh
3. Check if remote agent restarted and lost state

### Outbox Growing

```
Warning: Outbox has 100+ pending messages
```

**Cause**: Remote agent unreachable, messages queuing

**Fix**:
1. Check circuit breaker state (may be open)
2. Verify remote agent connectivity
3. Monitor `agenium_outbox_retry_total` for retry storms

### Bug Reports Not Uploading

```
Error: Bug report upload failed
```

**Cause**: Bug report server unreachable

**Fix**:
1. Verify bug report server is running
2. Check `BUG_REPORT_TOKEN` matches
3. Check `BUG_REPORT_URL` is correct
4. Reports queue locally and retry

## Rollback

1. Stop agent: `pkill -f agenium`
2. Restore previous version
3. Restart with old config
4. Session data in `.agenium/sessions.db` is compatible

## Support

- Issues: https://github.com/agenium/agenium/issues
- Docs: https://github.com/agenium/agenium#readme

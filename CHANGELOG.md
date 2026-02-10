# Changelog

All notable changes to Agenium will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-02-10

### 🎉 Initial Release

First public release of Agenium - a local, stateful, agent-to-agent client software.

### Added

#### Core Features
- **Stateful Sessions**: Persistent session management with SQLite storage
- **Agent Discovery**: `agent://` protocol resolution via custom DNS (185.204.169.26)
- **Secure Transport**: HTTP/2 + mTLS for encrypted agent communication
- **Message Protocol**: REQUEST/RESPONSE/EVENT/ERROR message types with backpressure

#### Reliability
- **At-Least-Once Delivery**: Outbox pattern with retry scheduling (1s/5s/20s backoff)
- **Session Resume**: Automatic session restoration after restart
- **Deduplication**: 10-minute message ID cache to prevent reprocessing
- **Crash Safety**: SQLite WAL mode for data integrity

#### Observability
- **Bug Reporter**: Non-blocking automatic error reporting with fingerprint deduplication
- **Prometheus Metrics**: `/metrics` endpoint with counters and gauges
- **Health Checks**: `/health` endpoint with runtime status
- **Configurable Bind**: Default localhost, optional 0.0.0.0 exposure

#### Production Hardening
- **Graceful Shutdown**: Coordinated component shutdown with timeouts
- **Circuit Breaker**: Open/half-open/closed states for resilience
- **Configurable Timeouts**: DNS (10s), Handshake (10s), Request (30s)
- **Rate Limiting**: Per-agent request throttling

#### CLI
- `agenium init` - Initialize new agent
- `agenium resolve agent://name` - DNS resolution
- `agenium connect agent://name` - Connect to agent
- `agenium status` - Show agent status
- `agenium e2e` - Run integration tests

#### Bug Report Server
- Separate service for centralized bug collection
- Fingerprint-based deduplication
- Secret redaction (API keys, tokens)
- Prometheus metrics + health checks
- Docker support

### Development Phases

| Phase | Description |
|-------|-------------|
| 1 | Architecture & Design |
| 2 | Project skeleton & core types |
| 3 | Transport layer (mTLS + HTTP/2) |
| 4 | Handshake protocol |
| 5 | FSM integration |
| 6 | Message passing protocol |
| 7 | DNS integration (agent://) |
| 8 | Session persistence + reliable messaging |
| 9 | Bug report server + integration |
| 10 | Health checks + Prometheus metrics |
| 11 | Production hardening |
| 12 | Release & Packaging |

### Tests

- **Unit Tests**: 46 passing
- **E2E Tests**: 10 passing
- **Total**: 56 tests

---

## [Unreleased]

### Planned
- Streaming/file transfer protocol
- Agent clustering
- Web dashboard
- npm package publishing

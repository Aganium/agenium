# AGENIUM

**Goal:** Local, stateful, agent-to-agent client software with automatic bug reporting.

## Status

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | ✅ COMPLETE | Architecture & Design |
| 2 | ✅ COMPLETE | Project skeleton & core types |
| 3 | ✅ COMPLETE | Transport layer (mTLS + HTTP/2) |
| 4 | ✅ COMPLETE | Handshake protocol |
| 5 | ✅ COMPLETE | FSM integration |
| 6 | ✅ COMPLETE | Message passing (REQUEST/RESPONSE/EVENT/ERROR) |
| 7 | ✅ COMPLETE | DNS integration (agent:// resolution) |
| 8 | ✅ COMPLETE | Session persistence + reliable messaging |
| 9 | ✅ COMPLETE | **Bug report server + integration** |
| 10 | ⏳ PENDING | Production hardening |

## Key Requirements

- ✅ Stateful sessions
- ✅ Agent discovery via agent://
- ✅ Secure A2A messaging
- ✅ Local daemon-style (no human UI)
- ✅ Automatic bug reporting (non-blocking)
- ✅ Centralized bug aggregation

## Tech Stack

- Node.js 20+ / TypeScript
- libsodium for crypto
- SQLite for persistence
- HTTP/2 + mTLS for transport
- Zod for validation

## Quick Links

- [Architecture](./ARCHITECTURE.md)
- [Bug Report Server](./bug-report-server/README.md)
- DNS Server: 185.204.169.26

---
*Last updated: 2026-02-10*

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
| 6 | ⏳ PENDING | Message passing |
| 7 | ⏳ PENDING | Integration & testing |

## Key Requirements

- ✅ Stateful sessions
- ✅ Agent discovery via agent://
- ✅ Secure A2A messaging
- ✅ Local daemon-style (no human UI)
- ✅ Automatic bug reporting (non-blocking)

## Tech Stack

- Node.js 20+ / TypeScript
- libsodium for crypto
- SQLite for persistence
- HTTP/2 + mTLS for transport

## Quick Links

- [Architecture](./ARCHITECTURE.md)
- DNS Server: 185.204.169.26

---
*Last updated: 2026-02-10*

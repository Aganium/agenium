# AGENIUM

**Goal:** Local, stateful, agent-to-agent client software with automatic bug reporting.

## Status

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | ✅ COMPLETE | Architecture & Design |
| 2 | ✅ COMPLETE | Project skeleton & core types |
| 3 | ⏳ PENDING | Protocol resolver (agent://) |
| 4 | ⏳ PENDING | Session manager (stateful) |
| 5 | ⏳ PENDING | Bug reporter subsystem |
| 6 | ⏳ PENDING | Transport layer (mTLS) |
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

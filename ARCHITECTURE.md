# AGENIUM - System Architecture (PHASE 1)

> Local, Stateful, Agent-to-Agent Client Software

---

## 1. High-Level Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         AGENIUM DAEMON                          │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │   Protocol   │  │   Session    │  │     Bug Reporter       │ │
│  │   Resolver   │  │   Manager    │  │   (Non-blocking)       │ │
│  │  agent://    │  │  (Stateful)  │  │                        │ │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬────────────┘ │
│         │                 │                      │              │
│  ┌──────▼─────────────────▼──────────────────────▼────────────┐ │
│  │                    Core Runtime                             │ │
│  │  • Event Loop  • State Machine  • Message Queue             │ │
│  └──────────────────────────┬──────────────────────────────────┘ │
│                             │                                    │
│  ┌──────────────────────────▼──────────────────────────────────┐ │
│  │                  Transport Layer                             │ │
│  │  • mTLS Client  • Connection Pool  • Retry Logic            │ │
│  └──────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    EXTERNAL SYSTEMS                             │
├─────────────────┬─────────────────────┬─────────────────────────┤
│  DNS System     │   Remote Agents     │   Bug Report Server     │
│  185.204.169.26 │   (discovered)      │   (central collector)   │
└─────────────────┴─────────────────────┴─────────────────────────┘
```

---

## 2. Component Architecture

### 2.1 Protocol Resolver

**Purpose:** Resolve `agent://<agent-name>` URIs to actual endpoints

```
agent://shannon → DNS lookup → { endpoint: "https://...", pubkey: "..." }
```

**Components:**
- `AgentURI` parser: validates and parses `agent://` scheme
- `DNSClient`: queries 185.204.169.26 for agent records
- `EndpointCache`: TTL-based cache to reduce DNS lookups
- `KeyStore`: caches public keys for verified agents

**Flow:**
```
1. Parse agent://name
2. Check EndpointCache (hit → return)
3. Query DNS: GET /agents/{name}/endpoint
4. Validate response signature
5. Cache endpoint + pubkey
6. Return connection info
```

---

### 2.2 Session Manager (Stateful Core)

**Purpose:** Maintain persistent, stateful sessions between agents

**State Model:**
```
┌──────────┐     connect      ┌────────────┐
│  IDLE    │ ───────────────► │ CONNECTING │
└──────────┘                  └─────┬──────┘
     ▲                              │
     │ disconnect                   │ handshake_ok
     │                              ▼
┌────┴─────┐     error        ┌────────────┐
│  CLOSED  │ ◄─────────────── │   ACTIVE   │
└──────────┘                  └─────┬──────┘
     ▲                              │
     │ timeout/fatal                │ pause
     │                              ▼
     │                        ┌────────────┐
     └─────────────────────── │  SUSPENDED │
                              └────────────┘
```

**Session Data Structure:**
```typescript
interface Session {
  id: string;                    // UUID v4
  localAgent: AgentIdentity;     // Our identity
  remoteAgent: AgentIdentity;    // Peer identity
  state: SessionState;           // FSM state
  createdAt: number;             // Unix timestamp
  lastActivity: number;          // For timeout detection
  
  // Stateful context
  context: {
    handshakeComplete: boolean;
    negotiatedCapabilities: string[];
    sharedSecrets: CryptoKeys;
    messageCounter: number;      // For replay protection
  };
  
  // Message history (ring buffer)
  history: Message[];            // Last N messages
}
```

**Persistence:**
- Sessions persisted to `~/.agenium/sessions/` as JSON
- Auto-resume on daemon restart
- Configurable history depth (default: 100 messages)

---

### 2.3 Message Queue

**Purpose:** Reliable, ordered message delivery

**Design:**
- In-memory priority queue with disk spillover
- Three priority levels: `CRITICAL`, `NORMAL`, `LOW`
- At-least-once delivery with deduplication

```
┌─────────────────────────────────────────────┐
│              Message Queue                  │
├─────────────────────────────────────────────┤
│  ┌─────────┐  ┌─────────┐  ┌─────────┐     │
│  │CRITICAL │  │ NORMAL  │  │   LOW   │     │
│  │ Queue   │  │ Queue   │  │  Queue  │     │
│  └────┬────┘  └────┬────┘  └────┬────┘     │
│       │            │            │          │
│       ▼            ▼            ▼          │
│  ┌─────────────────────────────────────┐   │
│  │         Dispatcher (FIFO)           │   │
│  └─────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

---

### 2.4 Transport Layer

**Purpose:** Secure, reliable network communication

**Features:**
- mTLS for all connections (mutual authentication)
- Connection pooling (max 10 per remote agent)
- Automatic reconnection with exponential backoff
- Request timeout: 30s default, configurable

**Protocol:**
- HTTPS/2 for efficiency (multiplexed streams)
- JSON-RPC 2.0 message format
- Optional: WebSocket upgrade for real-time bidirectional

---

### 2.5 Bug Reporter (CRITICAL COMPONENT)

**Purpose:** Automatic, non-blocking error reporting

**Design Principles:**
1. **Never block main agent flow** - async fire-and-forget
2. **Capture everything** - crashes, timeouts, protocol errors
3. **Graceful degradation** - if reporting fails, log locally

**Architecture:**
```
┌─────────────────────────────────────────────────────────────────┐
│                     BUG REPORTER SUBSYSTEM                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌────────────────┐    ┌────────────────┐    ┌───────────────┐ │
│  │ Error Catcher  │───►│  Report Queue  │───►│   Uploader    │ │
│  │ (sync hooks)   │    │  (bounded)     │    │   (async)     │ │
│  └────────────────┘    └────────────────┘    └───────┬───────┘ │
│         │                                            │         │
│         ▼                                            ▼         │
│  ┌────────────────┐                         ┌───────────────┐  │
│  │ Local Fallback │                         │ Central Server│  │
│  │ ~/.agenium/    │                         │ (configurable)│  │
│  │ crashes/*.json │                         └───────────────┘  │
│  └────────────────┘                                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Bug Report Schema:**
```typescript
interface BugReport {
  // Identity
  reportId: string;              // UUID
  agentId: string;               // This agent's ID
  agentVersion: string;          // Software version
  
  // Timing
  timestamp: number;             // When error occurred
  uptime: number;                // Agent uptime in seconds
  
  // Error details
  errorType: 'crash' | 'timeout' | 'protocol' | 'connection' | 'internal';
  errorCode: string;             // Machine-readable code
  errorMessage: string;          // Human-readable message
  stackTrace?: string;           // If available
  
  // Context
  sessionId?: string;            // Active session if any
  lastActions: Action[];         // Last 10 actions before error
  state: {
    sessionCount: number;
    queueDepth: number;
    memoryUsage: number;
    activeConnections: number;
  };
  
  // Environment
  platform: string;              // os.platform()
  nodeVersion: string;           // process.version
  
  // Privacy
  sanitized: boolean;            // Sensitive data removed
}
```

**Error Capture Points:**
1. `process.on('uncaughtException')` - Crashes
2. `process.on('unhandledRejection')` - Promise failures
3. Transport timeout handlers - Network timeouts
4. Protocol validation failures - Invalid messages
5. Session state machine errors - Invalid transitions

**Upload Strategy:**
- Batch uploads every 60 seconds (or immediately for crashes)
- Max queue size: 100 reports (oldest dropped if full)
- Retry failed uploads 3x with backoff
- Fall back to local storage if server unreachable

---

## 3. Data Flow

### 3.1 Outbound Message Flow

```
Agent wants to send message to agent://bob
            │
            ▼
┌───────────────────────┐
│  1. Resolve agent://  │
│     bob → endpoint    │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│  2. Get/Create        │
│     Session           │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│  3. Encrypt +         │
│     Queue Message     │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│  4. Transport         │
│     Send via mTLS     │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│  5. Update Session    │
│     State + History   │
└───────────────────────┘
```

### 3.2 Inbound Message Flow

```
mTLS connection received
            │
            ▼
┌───────────────────────┐
│  1. Verify client     │
│     certificate       │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│  2. Lookup/Create     │
│     Session           │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│  3. Decrypt +         │
│     Validate Message  │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│  4. Dispatch to       │
│     Agent Handler     │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│  5. Update Session    │
│     State + History   │
└───────────────────────┘
```

---

## 4. State Model

### 4.1 Global Daemon State

```typescript
interface DaemonState {
  // Identity
  agentId: string;
  publicKey: string;
  privateKey: string;           // Encrypted at rest
  
  // Runtime
  startedAt: number;
  status: 'starting' | 'running' | 'stopping' | 'stopped';
  
  // Sessions
  sessions: Map<string, Session>;
  
  // Metrics
  metrics: {
    messagesIn: number;
    messagesOut: number;
    errorsTotal: number;
    activeConnections: number;
  };
  
  // Config
  config: {
    dnsServer: string;          // Default: 185.204.169.26
    bugReportServer: string;    // Central collector
    listenPort: number;         // For inbound connections
    dataDir: string;            // ~/.agenium
  };
}
```

### 4.2 Persistence Strategy

```
~/.agenium/
├── config.json           # Daemon configuration
├── identity/
│   ├── agent.id          # Agent identifier
│   ├── public.pem        # Public key
│   └── private.pem.enc   # Encrypted private key
├── sessions/
│   ├── {session-id}.json # Persisted sessions
│   └── ...
├── cache/
│   ├── endpoints.json    # DNS cache
│   └── keys.json         # Public key cache
├── crashes/
│   ├── {timestamp}.json  # Local crash reports (fallback)
│   └── ...
└── logs/
    └── daemon.log        # Rotating log file
```

---

## 5. Security Model

### 5.1 Authentication

- **Agent Identity:** Ed25519 keypair generated on first run
- **Mutual TLS:** Both sides present certificates
- **Certificate Pinning:** First-contact pins, warning on change

### 5.2 Encryption

- **Transport:** TLS 1.3 (mTLS)
- **Messages:** Additional layer using session keys (NaCl secretbox)
- **At-rest:** Private keys encrypted with system keychain or passphrase

### 5.3 Replay Protection

- Message counter per session (monotonically increasing)
- Reject messages with counter ≤ last seen
- Timestamp validation (±5 minute window)

---

## 6. Technology Stack (Recommended)

| Component | Technology | Rationale |
|-----------|------------|-----------|
| Runtime | Node.js 20+ | Async I/O, good crypto support |
| Language | TypeScript | Type safety, maintainability |
| Transport | undici + http2 | Fast, modern HTTP client |
| Crypto | libsodium (sodium-native) | Battle-tested, fast |
| Storage | SQLite (better-sqlite3) | Embedded, reliable |
| IPC | Unix socket | Local agent communication |
| Logging | pino | Fast, structured logging |

---

## 7. Bug Reporting Pipeline (Detailed)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        ERROR OCCURS                                     │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  CAPTURE (Sync, < 1ms)                                                  │
│  ─────────────────────                                                  │
│  • Grab error type, message, stack                                      │
│  • Snapshot current state (sessions, queue depth)                       │
│  • Capture last 10 actions from ring buffer                             │
│  • Immediately return control to main flow                              │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  SANITIZE (Async, background)                                           │
│  ───────────────────────────────                                        │
│  • Remove sensitive data (keys, tokens, personal info)                  │
│  • Hash session IDs for correlation without exposure                    │
│  • Truncate large payloads                                              │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  QUEUE (Async, bounded buffer)                                          │
│  ─────────────────────────────                                          │
│  • Add to upload queue (max 100)                                        │
│  • If queue full, drop oldest non-crash reports                         │
│  • Crashes always preserved                                             │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  UPLOAD (Background worker, non-blocking)                               │
│  ─────────────────────────────────────────                              │
│  • Batch upload every 60s OR immediately for crashes                    │
│  • POST to configured bug report server                                 │
│  • Retry 3x with exponential backoff (1s, 2s, 4s)                       │
│  • On failure: write to ~/.agenium/crashes/ for later                   │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  CENTRAL SERVER                                                         │
│  ──────────────                                                         │
│  • Receives reports via HTTPS                                           │
│  • Aggregates by agent, error type, version                             │
│  • Alerts on spike detection                                            │
│  • Dashboard for debugging                                              │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Open Questions for PHASE 2

1. **DNS Protocol:** Exact API contract with 185.204.169.26
2. **Bug Report Server:** Deploy new or extend existing?
3. **Agent Registration:** How do new agents join the network?
4. **Capability Negotiation:** What capabilities are supported?
5. **Rate Limiting:** How to prevent abuse?

---

## PHASE 1 COMPLETE ✓

**Deliverables:**
- [x] System architecture defined
- [x] Component breakdown complete
- [x] Data flow documented
- [x] State model specified
- [x] Bug reporting pipeline designed
- [x] Technology stack recommended

**Next Phase:** Implementation skeleton + project structure

---

*Architecture v1.0 - AGENIUM*
*Generated: 2026-02-10*

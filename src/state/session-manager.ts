/**
 * Session Manager - Finite State Machine
 * Manages stateful sessions between agents
 */

import {
  Session,
  SessionState,
  SessionEvent,
  AgentID,
  generateId,
  now,
} from '../core/types.js';

// ============================================================================
// FSM Transition Table
// ============================================================================

type TransitionResult = SessionState | null; // null = invalid transition

const TRANSITIONS: Record<SessionState, Partial<Record<SessionEvent, SessionState>>> = {
  [SessionState.IDLE]: {
    [SessionEvent.CONNECT]: SessionState.CONNECTING,
  },
  [SessionState.CONNECTING]: {
    [SessionEvent.CONNECTED]: SessionState.HANDSHAKING,
    [SessionEvent.ERROR]: SessionState.ERROR,
    [SessionEvent.TIMEOUT]: SessionState.ERROR,
  },
  [SessionState.HANDSHAKING]: {
    [SessionEvent.HANDSHAKE_OK]: SessionState.ACTIVE,
    [SessionEvent.HANDSHAKE_FAIL]: SessionState.ERROR,
    [SessionEvent.ERROR]: SessionState.ERROR,
    [SessionEvent.TIMEOUT]: SessionState.ERROR,
  },
  [SessionState.ACTIVE]: {
    [SessionEvent.SUSPEND]: SessionState.SUSPENDED,
    [SessionEvent.DISCONNECT]: SessionState.CLOSED,
    [SessionEvent.ERROR]: SessionState.ERROR,
    [SessionEvent.TIMEOUT]: SessionState.ERROR,
  },
  [SessionState.SUSPENDED]: {
    [SessionEvent.RESUME]: SessionState.ACTIVE,
    [SessionEvent.DISCONNECT]: SessionState.CLOSED,
    [SessionEvent.TIMEOUT]: SessionState.CLOSED,
  },
  [SessionState.ERROR]: {
    [SessionEvent.CONNECT]: SessionState.CONNECTING, // Retry
    [SessionEvent.DISCONNECT]: SessionState.CLOSED,
  },
  [SessionState.CLOSED]: {
    // Terminal state - no transitions out
  },
};

// ============================================================================
// Session Manager
// ============================================================================

export interface SessionManagerConfig {
  /** How many sessions to keep in memory */
  maxSessions: number;
  /** Session timeout in ms */
  sessionTimeoutMs: number;
  /** History depth per session */
  historyDepth: number;
}

export interface SessionTransitionResult {
  ok: boolean;
  previousState: SessionState;
  currentState: SessionState;
  session: Session;
  error?: string;
}

export class SessionManager {
  private sessions: Map<string, Session>;
  private config: SessionManagerConfig;
  private localAgent: AgentID;

  constructor(localAgent: AgentID, config: Partial<SessionManagerConfig> = {}) {
    this.localAgent = localAgent;
    this.config = {
      maxSessions: config.maxSessions ?? 100,
      sessionTimeoutMs: config.sessionTimeoutMs ?? 300000, // 5 min
      historyDepth: config.historyDepth ?? 100,
    };
    this.sessions = new Map();
  }

  /**
   * Create a new session with a remote agent
   */
  create(remoteAgent: AgentID): Session {
    const session: Session = {
      id: generateId(),
      localAgent: this.localAgent,
      remoteAgent,
      state: SessionState.IDLE,
      createdAt: now(),
      lastActivity: now(),
      handshakeComplete: false,
      capabilities: [],
      messageCounter: 0,
    };

    // Evict oldest if at capacity
    if (this.sessions.size >= this.config.maxSessions) {
      this.evictOldest();
    }

    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Get a session by ID
   */
  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Find session by remote agent name
   */
  findByRemote(agentName: string): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.remoteAgent.name === agentName) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * Transition a session to a new state
   */
  transition(sessionId: string, event: SessionEvent): SessionTransitionResult {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        ok: false,
        previousState: SessionState.CLOSED,
        currentState: SessionState.CLOSED,
        session: this.createDummySession(),
        error: `Session not found: ${sessionId}`,
      };
    }

    const previousState = session.state;
    const validTransitions = TRANSITIONS[session.state];
    const nextState = validTransitions?.[event];

    if (nextState === undefined) {
      return {
        ok: false,
        previousState,
        currentState: session.state,
        session,
        error: `Invalid transition: ${session.state} + ${event}`,
      };
    }

    // Apply transition
    session.state = nextState;
    session.lastActivity = now();

    // Handle state-specific logic
    if (nextState === SessionState.ACTIVE && event === SessionEvent.HANDSHAKE_OK) {
      session.handshakeComplete = true;
    }

    if (nextState === SessionState.ERROR) {
      session.errorMessage = `Transitioned to ERROR via ${event}`;
    }

    if (nextState === SessionState.CLOSED) {
      // Mark for cleanup but keep in map for potential inspection
      session.errorMessage = session.errorMessage ?? 'Session closed';
    }

    return {
      ok: true,
      previousState,
      currentState: session.state,
      session,
    };
  }

  /**
   * Update session activity timestamp
   */
  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = now();
    }
  }

  /**
   * Increment message counter and return new value
   */
  nextMessageCounter(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) return -1;
    session.messageCounter++;
    return session.messageCounter;
  }

  /**
   * Set negotiated capabilities
   */
  setCapabilities(sessionId: string, capabilities: string[]): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.capabilities = capabilities;
    }
  }

  /**
   * Delete a session
   */
  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * Get all sessions
   */
  getAll(): Session[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get sessions by state
   */
  getByState(state: SessionState): Session[] {
    return this.getAll().filter(s => s.state === state);
  }

  /**
   * Get active session count
   */
  getActiveCount(): number {
    return this.getByState(SessionState.ACTIVE).length;
  }

  /**
   * Check and timeout stale sessions
   */
  checkTimeouts(): Session[] {
    const timedOut: Session[] = [];
    const cutoff = now() - this.config.sessionTimeoutMs;

    for (const session of this.sessions.values()) {
      if (session.lastActivity < cutoff) {
        // Only timeout non-terminal states
        if (session.state !== SessionState.CLOSED) {
          this.transition(session.id, SessionEvent.TIMEOUT);
          timedOut.push(session);
        }
      }
    }

    return timedOut;
  }

  /**
   * Clean up closed sessions
   */
  cleanup(): number {
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (session.state === SessionState.CLOSED) {
        this.sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Get manager statistics
   */
  getStats(): {
    total: number;
    byState: Record<SessionState, number>;
    oldestActivity: number;
  } {
    const byState: Record<SessionState, number> = {
      [SessionState.IDLE]: 0,
      [SessionState.CONNECTING]: 0,
      [SessionState.HANDSHAKING]: 0,
      [SessionState.ACTIVE]: 0,
      [SessionState.SUSPENDED]: 0,
      [SessionState.ERROR]: 0,
      [SessionState.CLOSED]: 0,
    };

    let oldestActivity = now();

    for (const session of this.sessions.values()) {
      byState[session.state]++;
      if (session.lastActivity < oldestActivity) {
        oldestActivity = session.lastActivity;
      }
    }

    return {
      total: this.sessions.size,
      byState,
      oldestActivity,
    };
  }

  /**
   * Export sessions for persistence
   */
  export(): Session[] {
    return this.getAll().filter(s => s.state !== SessionState.CLOSED);
  }

  /**
   * Import sessions from persistence
   */
  import(sessions: Session[]): number {
    let imported = 0;
    for (const session of sessions) {
      if (!this.sessions.has(session.id)) {
        this.sessions.set(session.id, session);
        imported++;
      }
    }
    return imported;
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  private evictOldest(): void {
    let oldest: Session | null = null;
    for (const session of this.sessions.values()) {
      // Prefer evicting closed/error sessions
      if (session.state === SessionState.CLOSED || session.state === SessionState.ERROR) {
        this.sessions.delete(session.id);
        return;
      }
      if (!oldest || session.lastActivity < oldest.lastActivity) {
        oldest = session;
      }
    }
    if (oldest) {
      this.sessions.delete(oldest.id);
    }
  }

  private createDummySession(): Session {
    return {
      id: 'INVALID',
      localAgent: this.localAgent,
      remoteAgent: { name: 'unknown', publicKey: '' },
      state: SessionState.CLOSED,
      createdAt: 0,
      lastActivity: 0,
      handshakeComplete: false,
      capabilities: [],
      messageCounter: 0,
    };
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createSessionManager(
  localAgent: AgentID,
  config?: Partial<SessionManagerConfig>
): SessionManager {
  return new SessionManager(localAgent, config);
}

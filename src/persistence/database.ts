/**
 * Database Layer - SQLite Persistence
 * Crash-safe session and outbox storage
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getBugReporter } from '../bug-report/reporter.js';
import { generateId, now } from '../core/types.js';

// ============================================================================
// Types
// ============================================================================

export interface PersistedSession {
  sessionId: string;
  remoteAgentName: string;
  remotePublicKey: string;
  endpoint: string;
  host: string;
  port: number;
  state: string;
  capabilities: string;  // JSON array
  createdAt: number;
  lastSeenAt: number;
  lastErrorCode: string | null;
  protocolVersion: string;
}

export interface OutboxMessage {
  msgId: string;
  sessionId: string;
  type: string;  // REQUEST | EVENT
  frameJson: string;
  priority: number;
  status: 'PENDING' | 'SENT' | 'ACKED' | 'FAILED';
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  lastError: string | null;
}

// ============================================================================
// Schema
// ============================================================================

const SCHEMA_VERSION = 1;

const CREATE_SESSIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS sessions (
    sessionId TEXT PRIMARY KEY,
    remoteAgentName TEXT NOT NULL,
    remotePublicKey TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'SUSPENDED',
    capabilities TEXT NOT NULL DEFAULT '[]',
    createdAt INTEGER NOT NULL,
    lastSeenAt INTEGER NOT NULL,
    lastErrorCode TEXT,
    protocolVersion TEXT NOT NULL DEFAULT '1.0'
  )
`;

const CREATE_OUTBOX_TABLE = `
  CREATE TABLE IF NOT EXISTS outbox_messages (
    msgId TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL,
    type TEXT NOT NULL,
    frameJson TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'PENDING',
    attempts INTEGER NOT NULL DEFAULT 0,
    nextAttemptAt INTEGER NOT NULL,
    createdAt INTEGER NOT NULL,
    lastError TEXT
  )
`;

const CREATE_OUTBOX_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_outbox_pending 
  ON outbox_messages(status, nextAttemptAt) 
  WHERE status = 'PENDING'
`;

const CREATE_DEDUPE_TABLE = `
  CREATE TABLE IF NOT EXISTS dedupe_cache (
    msgId TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL,
    receivedAt INTEGER NOT NULL
  )
`;

const CREATE_DEDUPE_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_dedupe_expiry 
  ON dedupe_cache(receivedAt)
`;

const CREATE_META_TABLE = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`;

// ============================================================================
// Database Manager
// ============================================================================

export class DatabaseManager {
  private db: Database.Database | null = null;
  private dbPath: string;
  private agentName: string;

  constructor(agentName: string, dataDir?: string) {
    this.agentName = agentName;
    const baseDir = dataDir?.replace('~', os.homedir()) ?? 
                    path.join(os.homedir(), '.agenium');
    const agentDir = path.join(baseDir, agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    this.dbPath = path.join(agentDir, 'sessions.db');
  }

  /**
   * Open and initialize the database
   */
  open(): void {
    if (this.db) return;

    try {
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');  // Write-ahead logging for crash safety
      this.db.pragma('synchronous = NORMAL');
      this.migrate();
    } catch (err) {
      // Database corrupted - create fresh
      getBugReporter().report('internal', 'DB_CORRUPT', 
        `Database corrupted, creating fresh: ${(err as Error).message}`, {
          isCrash: false,
        });
      
      // Backup corrupted file
      if (fs.existsSync(this.dbPath)) {
        const backupPath = `${this.dbPath}.corrupt.${Date.now()}`;
        fs.renameSync(this.dbPath, backupPath);
      }
      
      // Try again with fresh database
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.migrate();
    }
  }

  /**
   * Close the database
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Run migrations
   */
  private migrate(): void {
    if (!this.db) return;

    const transaction = this.db.transaction(() => {
      // Create tables
      this.db!.exec(CREATE_META_TABLE);
      this.db!.exec(CREATE_SESSIONS_TABLE);
      this.db!.exec(CREATE_OUTBOX_TABLE);
      this.db!.exec(CREATE_OUTBOX_INDEX);
      this.db!.exec(CREATE_DEDUPE_TABLE);
      this.db!.exec(CREATE_DEDUPE_INDEX);

      // Check schema version
      const stmt = this.db!.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
      stmt.run('schema_version', SCHEMA_VERSION.toString());
    });

    transaction();
  }

  // ============================================================================
  // Session Operations
  // ============================================================================

  /**
   * Save or update a session
   */
  saveSession(session: PersistedSession): void {
    if (!this.db) this.open();

    const stmt = this.db!.prepare(`
      INSERT OR REPLACE INTO sessions 
      (sessionId, remoteAgentName, remotePublicKey, endpoint, host, port, 
       state, capabilities, createdAt, lastSeenAt, lastErrorCode, protocolVersion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      session.sessionId,
      session.remoteAgentName,
      session.remotePublicKey,
      session.endpoint,
      session.host,
      session.port,
      session.state,
      session.capabilities,
      session.createdAt,
      session.lastSeenAt,
      session.lastErrorCode,
      session.protocolVersion
    );
  }

  /**
   * Load all resumable sessions (ACTIVE or SUSPENDED)
   */
  loadResumableSessions(): PersistedSession[] {
    if (!this.db) this.open();

    const stmt = this.db!.prepare(`
      SELECT * FROM sessions 
      WHERE state IN ('ACTIVE', 'SUSPENDED')
      ORDER BY lastSeenAt DESC
    `);

    return stmt.all() as PersistedSession[];
  }

  /**
   * Update session state
   */
  updateSessionState(sessionId: string, state: string, errorCode?: string): void {
    if (!this.db) this.open();

    const stmt = this.db!.prepare(`
      UPDATE sessions 
      SET state = ?, lastSeenAt = ?, lastErrorCode = ?
      WHERE sessionId = ?
    `);

    stmt.run(state, now(), errorCode ?? null, sessionId);
  }

  /**
   * Delete a session
   */
  deleteSession(sessionId: string): void {
    if (!this.db) this.open();
    this.db!.prepare('DELETE FROM sessions WHERE sessionId = ?').run(sessionId);
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): PersistedSession | undefined {
    if (!this.db) this.open();
    const stmt = this.db!.prepare('SELECT * FROM sessions WHERE sessionId = ?');
    return stmt.get(sessionId) as PersistedSession | undefined;
  }

  // ============================================================================
  // Outbox Operations
  // ============================================================================

  /**
   * Add message to outbox
   */
  enqueueMessage(msg: Omit<OutboxMessage, 'attempts' | 'status' | 'nextAttemptAt' | 'lastError'>): void {
    if (!this.db) this.open();

    const stmt = this.db!.prepare(`
      INSERT INTO outbox_messages 
      (msgId, sessionId, type, frameJson, priority, status, attempts, nextAttemptAt, createdAt, lastError)
      VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?, ?, NULL)
    `);

    stmt.run(
      msg.msgId,
      msg.sessionId,
      msg.type,
      msg.frameJson,
      msg.priority,
      now(),  // nextAttemptAt = now (immediate)
      msg.createdAt
    );
  }

  /**
   * Get pending messages ready for retry
   */
  getPendingMessages(limit: number = 10): OutboxMessage[] {
    if (!this.db) this.open();

    const stmt = this.db!.prepare(`
      SELECT * FROM outbox_messages 
      WHERE status = 'PENDING' AND nextAttemptAt <= ?
      ORDER BY priority ASC, createdAt ASC
      LIMIT ?
    `);

    return stmt.all(now(), limit) as OutboxMessage[];
  }

  /**
   * Get pending messages for a specific session
   */
  getSessionPendingMessages(sessionId: string): OutboxMessage[] {
    if (!this.db) this.open();

    const stmt = this.db!.prepare(`
      SELECT * FROM outbox_messages 
      WHERE sessionId = ? AND status = 'PENDING'
      ORDER BY priority ASC, createdAt ASC
    `);

    return stmt.all(sessionId) as OutboxMessage[];
  }

  /**
   * Update message status after send attempt
   */
  updateMessageStatus(
    msgId: string, 
    status: OutboxMessage['status'], 
    nextAttemptAt?: number,
    error?: string
  ): void {
    if (!this.db) this.open();

    const stmt = this.db!.prepare(`
      UPDATE outbox_messages 
      SET status = ?, attempts = attempts + 1, nextAttemptAt = ?, lastError = ?
      WHERE msgId = ?
    `);

    stmt.run(status, nextAttemptAt ?? now(), error ?? null, msgId);
  }

  /**
   * Mark message as acknowledged
   */
  ackMessage(msgId: string): void {
    this.updateMessageStatus(msgId, 'ACKED');
  }

  /**
   * Get count of in-flight messages for a session
   */
  getInFlightCount(sessionId: string): number {
    if (!this.db) this.open();

    const stmt = this.db!.prepare(`
      SELECT COUNT(*) as count FROM outbox_messages 
      WHERE sessionId = ? AND status IN ('PENDING', 'SENT')
    `);

    const result = stmt.get(sessionId) as { count: number };
    return result.count;
  }

  /**
   * Delete old completed messages
   */
  pruneOutbox(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    if (!this.db) this.open();

    const cutoff = now() - maxAgeMs;
    const stmt = this.db!.prepare(`
      DELETE FROM outbox_messages 
      WHERE status IN ('ACKED', 'FAILED') AND createdAt < ?
    `);

    return stmt.run(cutoff).changes;
  }

  // ============================================================================
  // Deduplication
  // ============================================================================

  /**
   * Check if message was already processed (returns true if duplicate)
   */
  isDuplicate(msgId: string, sessionId: string): boolean {
    if (!this.db) this.open();

    const stmt = this.db!.prepare(`
      SELECT 1 FROM dedupe_cache WHERE msgId = ? AND sessionId = ?
    `);

    return stmt.get(msgId, sessionId) !== undefined;
  }

  /**
   * Mark message as processed
   */
  markProcessed(msgId: string, sessionId: string): void {
    if (!this.db) this.open();

    const stmt = this.db!.prepare(`
      INSERT OR IGNORE INTO dedupe_cache (msgId, sessionId, receivedAt)
      VALUES (?, ?, ?)
    `);

    stmt.run(msgId, sessionId, now());
  }

  /**
   * Prune old dedupe entries (older than 10 minutes)
   */
  pruneDedupe(): number {
    if (!this.db) this.open();

    const cutoff = now() - (10 * 60 * 1000);  // 10 minutes
    const stmt = this.db!.prepare('DELETE FROM dedupe_cache WHERE receivedAt < ?');
    return stmt.run(cutoff).changes;
  }

  // ============================================================================
  // Statistics
  // ============================================================================

  getStats(): {
    sessionCount: number;
    outboxPending: number;
    outboxFailed: number;
    dedupeSize: number;
  } {
    if (!this.db) this.open();

    const sessions = this.db!.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
    const pending = this.db!.prepare("SELECT COUNT(*) as count FROM outbox_messages WHERE status = 'PENDING'").get() as { count: number };
    const failed = this.db!.prepare("SELECT COUNT(*) as count FROM outbox_messages WHERE status = 'FAILED'").get() as { count: number };
    const dedupe = this.db!.prepare('SELECT COUNT(*) as count FROM dedupe_cache').get() as { count: number };

    return {
      sessionCount: sessions.count,
      outboxPending: pending.count,
      outboxFailed: failed.count,
      dedupeSize: dedupe.count,
    };
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createDatabase(agentName: string, dataDir?: string): DatabaseManager {
  return new DatabaseManager(agentName, dataDir);
}

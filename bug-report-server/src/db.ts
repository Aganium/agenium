/**
 * Bug Report Server - Database Layer
 * SQLite storage with fingerprint-based deduplication
 */

import Database from 'better-sqlite3';
import { BugReport, ReportSummary, ReportDetail, computeFingerprint, sanitizeReport } from './schema.js';

// ============================================================================
// Database Schema
// ============================================================================

const SCHEMA = `
-- Main reports table (stores each unique fingerprint once)
CREATE TABLE IF NOT EXISTS bug_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT UNIQUE NOT NULL,
  report_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  error_type TEXT NOT NULL,
  error_code TEXT NOT NULL,
  error_message TEXT NOT NULL,
  stack_trace TEXT,
  session_id TEXT,
  remote_agent TEXT,
  protocol_version TEXT,
  last_actions TEXT,
  state TEXT,
  environment TEXT,
  occurrences INTEGER DEFAULT 1,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  agents_seen TEXT DEFAULT '[]',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_reports_fingerprint ON bug_reports(fingerprint);
CREATE INDEX IF NOT EXISTS idx_reports_last_seen ON bug_reports(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_reports_error_code ON bug_reports(error_code);
CREATE INDEX IF NOT EXISTS idx_reports_agent_id ON bug_reports(agent_id);
CREATE INDEX IF NOT EXISTS idx_reports_error_type ON bug_reports(error_type);

-- Events table for detailed occurrence tracking (optional)
CREATE TABLE IF NOT EXISTS bug_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL,
  report_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  uptime INTEGER,
  memory_mb INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (fingerprint) REFERENCES bug_reports(fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_events_fingerprint ON bug_events(fingerprint);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON bug_events(timestamp DESC);

-- Agent instances tracking
CREATE TABLE IF NOT EXISTS agent_instances (
  agent_id TEXT PRIMARY KEY,
  agent_version TEXT NOT NULL,
  platform TEXT,
  node_version TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  report_count INTEGER DEFAULT 0
);
`;

// ============================================================================
// Database Class
// ============================================================================

export class BugReportDB {
  private db: Database.Database;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
  }

  /**
   * Ingest a bug report with fingerprint-based deduplication
   */
  ingest(report: BugReport): { fingerprint: string; isNew: boolean; occurrences: number } {
    // Sanitize the report
    const sanitized = sanitizeReport(report);
    const fingerprint = computeFingerprint(sanitized);

    // Check if fingerprint exists
    const existing = this.db.prepare(`
      SELECT occurrences, agents_seen FROM bug_reports WHERE fingerprint = ?
    `).get(fingerprint) as { occurrences: number; agents_seen: string } | undefined;

    if (existing) {
      // Update existing report
      const agents = JSON.parse(existing.agents_seen) as string[];
      if (!agents.includes(sanitized.agentId)) {
        agents.push(sanitized.agentId);
      }

      this.db.prepare(`
        UPDATE bug_reports 
        SET occurrences = occurrences + 1,
            last_seen = ?,
            agents_seen = ?
        WHERE fingerprint = ?
      `).run(sanitized.timestamp, JSON.stringify(agents), fingerprint);

      // Record event
      this.recordEvent(fingerprint, sanitized);

      // Update agent instance
      this.updateAgentInstance(sanitized);

      return { fingerprint, isNew: false, occurrences: existing.occurrences + 1 };
    }

    // Insert new report
    this.db.prepare(`
      INSERT INTO bug_reports (
        fingerprint, report_id, agent_id, agent_version, error_type, error_code,
        error_message, stack_trace, session_id, remote_agent, protocol_version,
        last_actions, state, environment, first_seen, last_seen, agents_seen
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fingerprint,
      sanitized.reportId,
      sanitized.agentId,
      sanitized.agentVersion,
      sanitized.errorType,
      sanitized.errorCode,
      sanitized.errorMessage,
      sanitized.stackTrace ?? null,
      sanitized.sessionId ?? null,
      sanitized.remoteAgent ?? null,
      sanitized.protocolVersion ?? null,
      sanitized.lastActions ? JSON.stringify(sanitized.lastActions) : null,
      sanitized.state ? JSON.stringify(sanitized.state) : null,
      sanitized.environment ? JSON.stringify(sanitized.environment) : null,
      sanitized.timestamp,
      sanitized.timestamp,
      JSON.stringify([sanitized.agentId])
    );

    // Record event
    this.recordEvent(fingerprint, sanitized);

    // Update agent instance
    this.updateAgentInstance(sanitized);

    return { fingerprint, isNew: true, occurrences: 1 };
  }

  /**
   * Get recent reports
   */
  getRecent(limit: number = 100): ReportSummary[] {
    const rows = this.db.prepare(`
      SELECT fingerprint, error_code, error_type, error_message, 
             occurrences, first_seen, last_seen, agents_seen
      FROM bug_reports
      ORDER BY last_seen DESC
      LIMIT ?
    `).all(limit) as Array<{
      fingerprint: string;
      error_code: string;
      error_type: string;
      error_message: string;
      occurrences: number;
      first_seen: number;
      last_seen: number;
      agents_seen: string;
    }>;

    return rows.map(row => ({
      fingerprint: row.fingerprint,
      errorCode: row.error_code,
      errorType: row.error_type,
      errorMessage: row.error_message,
      occurrences: row.occurrences,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      agents: JSON.parse(row.agents_seen),
    }));
  }

  /**
   * Get top reports by occurrence in time window
   */
  getTop(windowMs: number = 24 * 60 * 60 * 1000, limit: number = 20): ReportSummary[] {
    const cutoff = Date.now() - windowMs;
    
    const rows = this.db.prepare(`
      SELECT fingerprint, error_code, error_type, error_message,
             occurrences, first_seen, last_seen, agents_seen
      FROM bug_reports
      WHERE last_seen >= ?
      ORDER BY occurrences DESC
      LIMIT ?
    `).all(cutoff, limit) as Array<{
      fingerprint: string;
      error_code: string;
      error_type: string;
      error_message: string;
      occurrences: number;
      first_seen: number;
      last_seen: number;
      agents_seen: string;
    }>;

    return rows.map(row => ({
      fingerprint: row.fingerprint,
      errorCode: row.error_code,
      errorType: row.error_type,
      errorMessage: row.error_message,
      occurrences: row.occurrences,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      agents: JSON.parse(row.agents_seen),
    }));
  }

  /**
   * Get report details by fingerprint or reportId
   */
  getById(id: string): ReportDetail | null {
    // Try fingerprint first, then reportId
    const row = this.db.prepare(`
      SELECT * FROM bug_reports WHERE fingerprint = ? OR report_id = ?
    `).get(id, id) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      reportId: row.report_id as string,
      agentId: row.agent_id as string,
      agentVersion: row.agent_version as string,
      timestamp: row.first_seen as number,
      uptime: 0,
      errorType: row.error_type as BugReport['errorType'],
      errorCode: row.error_code as string,
      errorMessage: row.error_message as string,
      stackTrace: row.stack_trace as string | undefined,
      sessionId: row.session_id as string | undefined,
      remoteAgent: row.remote_agent as string | undefined,
      protocolVersion: row.protocol_version as string | undefined,
      lastActions: row.last_actions ? JSON.parse(row.last_actions as string) : undefined,
      state: row.state ? JSON.parse(row.state as string) : undefined,
      environment: row.environment ? JSON.parse(row.environment as string) : undefined,
      fingerprint: row.fingerprint as string,
      occurrences: row.occurrences as number,
      firstSeen: row.first_seen as number,
      lastSeen: row.last_seen as number,
    };
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalReports: number;
    uniqueFingerprints: number;
    reportsLast24h: number;
    topErrorCodes: Array<{ code: string; count: number }>;
  } {
    const total = this.db.prepare(`SELECT SUM(occurrences) as total FROM bug_reports`).get() as { total: number };
    const unique = this.db.prepare(`SELECT COUNT(*) as count FROM bug_reports`).get() as { count: number };
    
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recent = this.db.prepare(`
      SELECT COUNT(*) as count FROM bug_events WHERE timestamp >= ?
    `).get(cutoff) as { count: number };

    const topCodes = this.db.prepare(`
      SELECT error_code as code, SUM(occurrences) as count
      FROM bug_reports
      GROUP BY error_code
      ORDER BY count DESC
      LIMIT 10
    `).all() as Array<{ code: string; count: number }>;

    return {
      totalReports: total.total ?? 0,
      uniqueFingerprints: unique.count,
      reportsLast24h: recent.count,
      topErrorCodes: topCodes,
    };
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private recordEvent(fingerprint: string, report: BugReport): void {
    this.db.prepare(`
      INSERT INTO bug_events (fingerprint, report_id, agent_id, timestamp, uptime, memory_mb)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      fingerprint,
      report.reportId,
      report.agentId,
      report.timestamp,
      report.uptime,
      report.state?.memoryUsageMB ?? null
    );
  }

  private updateAgentInstance(report: BugReport): void {
    const existing = this.db.prepare(`
      SELECT agent_id FROM agent_instances WHERE agent_id = ?
    `).get(report.agentId);

    if (existing) {
      this.db.prepare(`
        UPDATE agent_instances
        SET last_seen = ?, report_count = report_count + 1, agent_version = ?
        WHERE agent_id = ?
      `).run(report.timestamp, report.agentVersion, report.agentId);
    } else {
      this.db.prepare(`
        INSERT INTO agent_instances (agent_id, agent_version, platform, node_version, first_seen, last_seen, report_count)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(
        report.agentId,
        report.agentVersion,
        report.environment?.platform ?? null,
        report.environment?.nodeVersion ?? null,
        report.timestamp,
        report.timestamp
      );
    }
  }
}

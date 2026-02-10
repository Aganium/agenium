/**
 * Bug Report Server - HTTP Server
 * Minimal HTTP server with rate limiting and token auth
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { BugReportDB } from './db.js';
import { BugReportSchema, IngestResponse } from './schema.js';

// ============================================================================
// Configuration
// ============================================================================

export interface ServerConfig {
  port: number;
  dbPath: string;
  authToken: string;
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };
}

const DEFAULT_CONFIG: ServerConfig = {
  port: parseInt(process.env.PORT ?? '3100'),
  dbPath: process.env.DB_PATH ?? './bug-reports.db',
  authToken: process.env.BUG_REPORT_TOKEN ?? 'dev-token-change-me',
  rateLimit: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 100,
  },
};

// ============================================================================
// Rate Limiter
// ============================================================================

class RateLimiter {
  private requests: Map<string, { count: number; resetAt: number }> = new Map();

  constructor(private windowMs: number, private maxRequests: number) {}

  isAllowed(key: string): boolean {
    const now = Date.now();
    const entry = this.requests.get(key);

    if (!entry || now > entry.resetAt) {
      this.requests.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    if (entry.count >= this.maxRequests) {
      return false;
    }

    entry.count++;
    return true;
  }

  // Cleanup old entries periodically
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.requests) {
      if (now > entry.resetAt) {
        this.requests.delete(key);
      }
    }
  }
}

// ============================================================================
// HTTP Helpers
// ============================================================================

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString();
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function getAgentId(req: IncomingMessage): string {
  return req.headers['x-agent-id'] as string ?? 'unknown';
}

function parseTimeWindow(window?: string): number {
  if (!window) return 24 * 60 * 60 * 1000; // Default 24h
  const match = window.match(/^(\d+)(h|m|d)$/);
  if (!match) return 24 * 60 * 60 * 1000;
  const [, num, unit] = match;
  const multiplier = { h: 60 * 60 * 1000, m: 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return parseInt(num) * multiplier[unit as keyof typeof multiplier];
}

// ============================================================================
// Server Class
// ============================================================================

export class BugReportServer {
  private db: BugReportDB;
  private rateLimiter: RateLimiter;
  private server: ReturnType<typeof createServer> | null = null;
  private config: ServerConfig;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<ServerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.db = new BugReportDB(this.config.dbPath);
    this.rateLimiter = new RateLimiter(
      this.config.rateLimit.windowMs,
      this.config.rateLimit.maxRequests
    );
  }

  /**
   * Start the server
   */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(this.config.port, () => {
        console.log(`[BugReportServer] Listening on port ${this.config.port}`);
        resolve();
      });

      // Cleanup rate limiter every minute
      this.cleanupInterval = setInterval(() => {
        this.rateLimiter.cleanup();
      }, 60 * 1000);
    });
  }

  /**
   * Stop the server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
      }
      this.db.close();
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle incoming request
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Agent-Id');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Health check (no auth)
      if (path === '/health' && method === 'GET') {
        return sendJson(res, 200, { ok: true, timestamp: Date.now() });
      }

      // Stats endpoint (no auth, public)
      if (path === '/api/stats' && method === 'GET') {
        return sendJson(res, 200, this.db.getStats());
      }

      // Auth check for other endpoints
      if (!this.checkAuth(req)) {
        return sendJson(res, 401, { error: 'Unauthorized', message: 'Invalid or missing token' });
      }

      // Rate limiting
      const agentId = getAgentId(req);
      if (!this.rateLimiter.isAllowed(agentId)) {
        return sendJson(res, 429, { error: 'Too Many Requests', message: 'Rate limit exceeded' });
      }

      // Route handlers
      if (path === '/api/bug-reports' && method === 'POST') {
        return await this.handleIngest(req, res);
      }

      if (path === '/api/bug-reports/recent' && method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') ?? '100');
        return sendJson(res, 200, this.db.getRecent(Math.min(limit, 500)));
      }

      if (path === '/api/bug-reports/top' && method === 'GET') {
        const window = parseTimeWindow(url.searchParams.get('window') ?? undefined);
        const limit = parseInt(url.searchParams.get('limit') ?? '20');
        return sendJson(res, 200, this.db.getTop(window, Math.min(limit, 100)));
      }

      const idMatch = path.match(/^\/api\/bug-reports\/([a-f0-9]+)$/);
      if (idMatch && method === 'GET') {
        const report = this.db.getById(idMatch[1]);
        if (report) {
          return sendJson(res, 200, report);
        }
        return sendJson(res, 404, { error: 'Not Found', message: 'Report not found' });
      }

      // 404
      sendJson(res, 404, { error: 'Not Found', message: 'Unknown endpoint' });
    } catch (err) {
      console.error('[BugReportServer] Error:', err);
      sendJson(res, 500, { error: 'Internal Server Error', message: String(err) });
    }
  }

  /**
   * Handle report ingestion
   */
  private async handleIngest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await parseBody(req);
      const result = BugReportSchema.safeParse(body);

      if (!result.success) {
        return sendJson(res, 400, {
          error: 'Validation Error',
          message: 'Invalid bug report format',
          details: result.error.errors,
        });
      }

      const report = result.data;
      const { fingerprint, isNew, occurrences } = this.db.ingest(report);

      const response: IngestResponse = {
        ok: true,
        reportId: report.reportId,
        fingerprint,
        isNew,
      };

      console.log(`[BugReportServer] Ingested report ${report.reportId} (fp: ${fingerprint}, new: ${isNew}, total: ${occurrences})`);

      sendJson(res, 200, response);
    } catch (err) {
      console.error('[BugReportServer] Ingest error:', err);
      sendJson(res, 400, { error: 'Bad Request', message: String(err) });
    }
  }

  /**
   * Check authorization
   */
  private checkAuth(req: IncomingMessage): boolean {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return false;

    // Support both "Bearer <token>" and just "<token>"
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader;

    return token === this.config.authToken;
  }
}

/**
 * Bug Report Server - Entry Point
 */

import { BugReportServer } from './server.js';

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║       AGENIUM Bug Report Server v1.0       ║');
  console.log('╚════════════════════════════════════════════╝');

  const host = process.env.METRICS_HOST ?? '127.0.0.1';
  const port = parseInt(process.env.PORT ?? '3100');

  const server = new BugReportServer({
    port,
    host,
    dbPath: process.env.DB_PATH ?? './bug-reports.db',
    authToken: process.env.BUG_REPORT_TOKEN ?? 'dev-token-change-me',
    shutdownTimeoutMs: parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? '5000'),
  });

  let isShuttingDown = false;

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    if (isShuttingDown) {
      console.log(`[BugReportServer] Already shutting down, forcing exit...`);
      process.exit(1);
    }
    isShuttingDown = true;
    
    console.log(`\n[BugReportServer] Received ${signal}, starting graceful shutdown...`);
    
    try {
      await server.stop();
      console.log('[BugReportServer] Shutdown complete');
      process.exit(0);
    } catch (err) {
      console.error('[BugReportServer] Shutdown error:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await server.start();

  console.log(`
Endpoints:
  POST /api/bug-reports          - Ingest a bug report
  GET  /api/bug-reports/recent   - Get recent reports (?limit=100)
  GET  /api/bug-reports/top      - Get top reports (?window=24h&limit=20)
  GET  /api/bug-reports/:id      - Get report by fingerprint or reportId
  GET  /api/stats                - Stats (requires auth)
  GET  /metrics                  - Prometheus metrics
  GET  /health                   - Health check

Bind: ${host}:${port}
Auth: Authorization: Bearer <BUG_REPORT_TOKEN>
`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

// Re-export for library use
export { BugReportServer } from './server.js';
export { BugReportDB } from './db.js';
export * from './schema.js';
export * from './metrics.js';

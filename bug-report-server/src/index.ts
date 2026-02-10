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

  const server = new BugReportServer({
    port: parseInt(process.env.PORT ?? '3100'),
    dbPath: process.env.DB_PATH ?? './bug-reports.db',
    authToken: process.env.BUG_REPORT_TOKEN ?? 'dev-token-change-me',
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[BugReportServer] Received ${signal}, shutting down...`);
    await server.stop();
    process.exit(0);
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
  GET  /api/stats                - Get statistics (public)
  GET  /health                   - Health check

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

#!/usr/bin/env node
// Only show in development / interactive installs (not CI, not production)
if (
  process.env.CI ||
  process.env.CONTINUOUS_INTEGRATION ||
  process.env.NODE_ENV === 'production' ||
  !process.stdout.isTTY
) {
  process.exit(0);
}

console.log(`
  ╔══════════════════════════════════════════════════════╗
  ║                                                      ║
  ║   🔍 Find any MCP server in seconds                  ║
  ║   https://agenium.net/search                         ║
  ║                                                      ║
  ║   Search 2,000+ MCP servers by capability,           ║
  ║   language, and use case.                            ║
  ║                                                      ║
  ╚══════════════════════════════════════════════════════╝
`);

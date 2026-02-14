#!/usr/bin/env node

/**
 * @agenium/mcp-server CLI
 *
 * Quick way to bridge an MCP server to the AGENIUM network.
 *
 * Usage:
 *   npx @agenium/mcp-server --name weather-tools --command npx --args "-y @modelcontextprotocol/server-weather"
 *   npx @agenium/mcp-server --name my-tools --sse http://localhost:3001/sse
 */

import { MCPBridge } from './bridge.js';
import type { MCPServerConfig } from './types.js';

function usage(): void {
  console.log(`
@agenium/mcp-server — Bridge MCP servers to the AGENIUM agent:// network

Usage:
  agenium-mcp [options]

Options:
  --name <name>         Agent name (required)
  --command <cmd>       Stdio MCP server command
  --args <args>         Command arguments (space-separated, quote if needed)
  --cwd <dir>           Working directory for stdio server
  --sse <url>           SSE endpoint URL (instead of stdio)
  --host <ip>           Public host for DNS registration
  --port <port>         Listen port (default: auto)
  --dns <server>        DNS server (default: 185.204.169.26)
  --no-register         Skip DNS registration
  --log <level>         Log level: debug|info|warn|error|silent (default: info)
  -h, --help            Show this help

Examples:
  # Bridge a weather MCP server
  agenium-mcp --name weather --command npx --args "-y @modelcontextprotocol/server-weather" --host 1.2.3.4

  # Bridge a running SSE server
  agenium-mcp --name my-tools --sse http://localhost:3001/sse --host 1.2.3.4
`);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      result['help'] = true;
    } else if (arg === '--no-register') {
      result['noRegister'] = true;
    } else if (arg?.startsWith('--') && i + 1 < argv.length) {
      result[arg.slice(2)] = argv[i + 1]!;
      i++;
    }
    i++;
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args['help'] || !args['name']) {
    usage();
    process.exit(args['help'] ? 0 : 1);
  }

  const name = args['name'] as string;

  // Determine MCP config
  let mcp: MCPServerConfig;
  if (args['sse']) {
    mcp = { transport: 'sse', url: args['sse'] as string };
  } else if (args['command']) {
    mcp = {
      transport: 'stdio',
      command: args['command'] as string,
      args: args['args'] ? (args['args'] as string).split(/\s+/) : undefined,
      cwd: args['cwd'] as string | undefined,
    };
  } else {
    console.error('Error: Either --command or --sse is required');
    usage();
    process.exit(1);
  }

  const bridge = new MCPBridge({
    name,
    mcp,
    agent: {
      publicHost: args['host'] as string | undefined,
      port: args['port'] ? parseInt(args['port'] as string) : undefined,
      dnsServer: args['dns'] as string | undefined,
      autoRegister: !args['noRegister'],
    },
    bridge: {
      logLevel: (args['log'] as any) ?? 'info',
    },
  });

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    await bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start
  try {
    await bridge.start();

    const tools = bridge.getTools();
    console.log(`\n✅ Bridge running as agent://${name}`);
    console.log(`   Tools: ${tools.map((t) => t.name).join(', ') || 'none'}`);
    console.log(`   Press Ctrl+C to stop\n`);
  } catch (err) {
    console.error('Failed to start bridge:', (err as Error).message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

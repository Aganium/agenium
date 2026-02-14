#!/usr/bin/env node
/**
 * Agenium CLI
 * 
 * Commands:
 *   agenium init           - Initialize a new agent
 *   agenium resolve <uri>  - Resolve agent:// URI via DNS
 *   agenium connect <uri>  - Connect to agent:// URI
 *   agenium status         - Show agent status
 *   agenium e2e            - Run end-to-end tests
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = '0.1.0';

// ============================================================================
// Helpers
// ============================================================================

function log(msg: string): void {
  console.log(msg);
}

function error(msg: string): void {
  console.error(`❌ ${msg}`);
}

function success(msg: string): void {
  console.log(`✅ ${msg}`);
}

function printHelp(): void {
  console.log(`
╔════════════════════════════════════════════╗
║           AGENIUM CLI v${VERSION}              ║
╚════════════════════════════════════════════╝

Usage: agenium <command> [options]

Commands:
  init                    Initialize a new agent in current directory
  resolve <agent://uri>   Resolve agent URI to IP:port via DNS
  connect <agent://uri>   Connect to a remote agent
  status                  Show local agent status
  e2e                     Run end-to-end integration tests
  version                 Show version

Options:
  --help, -h              Show this help
  --config, -c <file>     Config file (default: ./agenium.json)

Examples:
  agenium init
  agenium resolve agent://alice.agent
  agenium connect agent://bob.agent
  agenium status
  agenium e2e

Documentation: https://github.com/agenium/agenium
`);
}

// ============================================================================
// Commands
// ============================================================================

async function cmdInit(): Promise<void> {
  log('Initializing Agenium agent...\n');

  const configPath = './agenium.json';
  const dataDir = './.agenium';

  if (existsSync(configPath)) {
    error('agenium.json already exists. Delete it to reinitialize.');
    process.exit(1);
  }

  // Create data directory
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // Generate agent ID
  const agentId = `agent-${Date.now().toString(36)}`;

  // Default config
  const config = {
    agentId,
    version: VERSION,
    dataDir,
    dnsServer: '185.204.169.26',
    metricsPort: 9090,
    metricsHost: '127.0.0.1',
    bugReportServer: 'http://localhost:3100/api/bug-reports',
    timeouts: {
      dnsLookupMs: 10000,
      handshakeMs: 10000,
      requestMs: 30000,
    },
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2));

  success(`Created agenium.json`);
  success(`Created ${dataDir}/`);
  log(`\nAgent ID: ${agentId}`);
  log('\nNext steps:');
  log('  1. Edit agenium.json to configure your agent');
  log('  2. Run: agenium status');
  log('  3. Connect: agenium connect agent://target.agent');
}

async function cmdResolve(uri: string): Promise<void> {
  if (!uri) {
    error('Usage: agenium resolve agent://name');
    process.exit(1);
  }

  // Normalize URI
  const fullUri = uri.startsWith('agent://') ? uri : `agent://${uri}`;
  log(`Resolving ${fullUri}...`);

  try {
    // Dynamic import to avoid loading at startup
    const { getResolver } = await import('./dns/index.js');
    const resolver = getResolver();

    const result = await resolver.resolve(fullUri);

    if (result.ok) {
      const agent = result.agent;
      success(`Resolved: ${agent.name}`);
      log(`  Endpoint: ${agent.endpoint}`);
      log(`  Host:     ${agent.host}:${agent.port}`);
      if (agent.description) {
        log(`  Desc:     ${agent.description}`);
      }
      if (agent.publicKey) {
        log(`  PubKey:   ${agent.publicKey.slice(0, 24)}...`);
      }
      if (agent.capabilities.length > 0) {
        log(`  Caps:     ${agent.capabilities.join(', ')}`);
      }
      if (agent.tools && agent.tools.length > 0) {
        log(`  Tools:    ${agent.tools.length} registered`);
        for (const tool of agent.tools) {
          const desc = tool.description ? ` — ${tool.description}` : '';
          log(`    • ${tool.name}${desc}`);
          if (tool.inputSchema) {
            const props = (tool.inputSchema as Record<string, unknown>).properties;
            if (props && typeof props === 'object') {
              const keys = Object.keys(props);
              log(`      Input:  { ${keys.join(', ')} }`);
            }
          }
        }
      }
      if (agent.metadata && Object.keys(agent.metadata).length > 0) {
        log(`  Meta:     ${JSON.stringify(agent.metadata)}`);
      }
    } else {
      error(`Could not resolve: ${fullUri}`);
      error(`  ${result.error.code}: ${result.error.message}`);
      process.exit(1);
    }
  } catch (err) {
    error(`DNS resolution failed: ${err}`);
    process.exit(1);
  }
}

async function cmdConnect(uri: string): Promise<void> {
  if (!uri) {
    error('Usage: agenium connect agent://name');
    process.exit(1);
  }

  // Normalize URI
  const fullUri = uri.startsWith('agent://') ? uri : `agent://${uri}`;
  log(`Connecting to ${fullUri}...`);

  // Load config
  const configPath = './agenium.json';
  if (!existsSync(configPath)) {
    error('No agenium.json found. Run: agenium init');
    process.exit(1);
  }

  const config = JSON.parse(readFileSync(configPath, 'utf-8'));

  try {
    const { getResolver } = await import('./dns/index.js');
    const resolver = getResolver();

    log('  Resolving DNS...');
    const result = await resolver.resolve(fullUri);

    if (!result.ok) {
      error(`Could not resolve: ${fullUri}`);
      error(`  ${result.error.code}: ${result.error.message}`);
      process.exit(1);
    }

    const target = result.agent;
    success(`Resolved: ${target.host}:${target.port}`);

    // TODO: Implement actual connection via Agent class
    log('\n⚠️  Full connection not yet implemented in CLI.');
    log('   Use the Node.js API for programmatic connections:');
    log('\n   import { createAgent } from "agenium";');
    log(`   const agent = await createAgent({ agentId: "${config.agentId}" });`);
    log(`   const session = await agent.connect("${uri}");`);

  } catch (err) {
    error(`Connection failed: ${err}`);
    process.exit(1);
  }
}

async function cmdStatus(): Promise<void> {
  log('Agenium Status\n');

  const configPath = './agenium.json';
  if (!existsSync(configPath)) {
    error('No agenium.json found. Run: agenium init');
    process.exit(1);
  }

  const config = JSON.parse(readFileSync(configPath, 'utf-8'));

  log(`  Agent ID:    ${config.agentId}`);
  log(`  Version:     ${config.version}`);
  log(`  Data Dir:    ${config.dataDir}`);
  log(`  DNS Server:  ${config.dnsServer}`);
  log(`  Metrics:     ${config.metricsHost}:${config.metricsPort}`);
  log(`  Bug Reports: ${config.bugReportServer}`);

  // Check if database exists
  const dbPath = join(config.dataDir, 'sessions.db');
  if (existsSync(dbPath)) {
    log(`  Database:    ✅ ${dbPath}`);
  } else {
    log(`  Database:    ⚠️  Not created yet`);
  }

  // Check DNS reachability
  log('\nConnectivity:');
  try {
    const { getResolver } = await import('./dns/index.js');
    const resolver = getResolver({ server: config.dnsServer });
    
    const start = Date.now();
    await resolver.resolve('test.agent').catch(() => null);
    const elapsed = Date.now() - start;
    
    log(`  DNS Server:  ✅ Reachable (${elapsed}ms)`);
  } catch {
    log(`  DNS Server:  ❌ Unreachable`);
  }
}

async function cmdE2E(): Promise<void> {
  log('Running Agenium E2E Tests...\n');

  const e2ePath = join(__dirname, '..', 'e2e-test.ts');
  
  if (!existsSync(e2ePath)) {
    // Try compiled version
    const compiledPath = join(__dirname, '..', 'e2e-test.js');
    if (existsSync(compiledPath)) {
      const proc = spawn('node', [compiledPath], { stdio: 'inherit' });
      proc.on('exit', (code) => process.exit(code ?? 0));
      return;
    }
    
    error('E2E test file not found. Run from agenium source directory.');
    process.exit(1);
  }

  const proc = spawn('npx', ['tsx', e2ePath], { stdio: 'inherit' });
  proc.on('exit', (code) => process.exit(code ?? 0));
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(`agenium v${VERSION}`);
    process.exit(0);
  }

  switch (command) {
    case 'init':
      await cmdInit();
      break;
    case 'resolve':
      await cmdResolve(args[1]);
      break;
    case 'connect':
      await cmdConnect(args[1]);
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'e2e':
      await cmdE2E();
      break;
    default:
      error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  error(`Fatal: ${err.message}`);
  process.exit(1);
});

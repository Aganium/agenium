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
import * as readline from 'node:readline';

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

// ============================================================================
// Interactive Prompt Helpers
// ============================================================================

function ask(rl: readline.Interface, question: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` (${defaultVal})` : '';
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultVal || '');
    });
  });
}

function askChoice(rl: readline.Interface, question: string, choices: string[], defaultIdx = 0): Promise<number> {
  return new Promise((resolve) => {
    console.log(`\n  ${question}`);
    choices.forEach((c, i) => {
      const marker = i === defaultIdx ? '❯' : ' ';
      console.log(`    ${marker} ${i + 1}. ${c}`);
    });
    rl.question(`  Choose [1-${choices.length}] (${defaultIdx + 1}): `, (answer) => {
      const num = parseInt(answer.trim()) - 1;
      resolve(num >= 0 && num < choices.length ? num : defaultIdx);
    });
  });
}

// ============================================================================
// Agent Templates
// ============================================================================

const TEMPLATES: Record<string, { desc: string; code: (name: string, description: string) => string }> = {
  echo: {
    desc: 'Echo agent — mirrors messages back (great for testing)',
    code: (name, description) => `#!/usr/bin/env npx tsx
/**
 * agent://${name} — ${description}
 * Built with AGENIUM (https://agenium.net)
 */
import { createAgent } from 'agenium';

const agent = createAgent('${name}', {
  listenPort: parseInt(process.env.PORT ?? '9001'),
  tools: [
    {
      name: 'echo',
      description: 'Echo back the message you send',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Message to echo' },
        },
        required: ['message'],
      },
      handler: async (input) => ({
        echo: (input as any).message,
        timestamp: new Date().toISOString(),
      }),
    },
    {
      name: 'ping',
      description: 'Health check',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({
        pong: true,
        uptime: Math.round(process.uptime()),
      }),
    },
  ],
});

agent.on('started', ({ name, port }) => {
  console.log(\`\\n🤖 agent://\${name} started on port \${port}\`);
  console.log('   Ready to receive connections!\\n');
});

agent.on('connection', ({ sessionId, remoteAgent }) => {
  console.log(\`📡 Connection from \${remoteAgent?.name ?? 'unknown'}\`);
});

(async () => {
  await agent.start();
  console.log('Press Ctrl+C to stop\\n');
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      await agent.stop();
      process.exit(0);
    });
  }
})();
`,
  },
  weather: {
    desc: 'Weather agent — serves weather data (shows real-world patterns)',
    code: (name, description) => `#!/usr/bin/env npx tsx
/**
 * agent://${name} — ${description}
 * Built with AGENIUM (https://agenium.net)
 */
import { createAgent } from 'agenium';

const agent = createAgent('${name}', {
  listenPort: parseInt(process.env.PORT ?? '9001'),
  tools: [
    {
      name: 'get_weather',
      description: 'Get current weather for a city',
      inputSchema: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name' },
        },
        required: ['city'],
      },
      handler: async (input) => {
        const city = (input as any).city;
        // Demo: replace with a real weather API
        const conditions = ['sunny', 'cloudy', 'rainy', 'snowy'];
        const condition = conditions[Math.floor(Math.random() * conditions.length)];
        const temp = Math.round(15 + Math.random() * 20);
        return {
          city,
          temperature: \`\${temp}°C\`,
          condition,
          timestamp: new Date().toISOString(),
        };
      },
    },
    {
      name: 'ping',
      description: 'Health check',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ pong: true, uptime: Math.round(process.uptime()) }),
    },
  ],
});

agent.on('started', ({ name, port }) => {
  console.log(\`\\n🌤️  agent://\${name} started on port \${port}\`);
  console.log('   Tools: get_weather, ping\\n');
});

(async () => {
  await agent.start();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => { await agent.stop(); process.exit(0); });
  }
})();
`,
  },
  blank: {
    desc: 'Blank agent — minimal starter, add your own tools',
    code: (name, description) => `#!/usr/bin/env npx tsx
/**
 * agent://${name} — ${description}
 * Built with AGENIUM (https://agenium.net)
 */
import { createAgent } from 'agenium';

const agent = createAgent('${name}', {
  listenPort: parseInt(process.env.PORT ?? '9001'),
  tools: [
    // Add your tools here:
    // {
    //   name: 'my_tool',
    //   description: 'What it does',
    //   inputSchema: {
    //     type: 'object',
    //     properties: {
    //       param: { type: 'string', description: 'A parameter' },
    //     },
    //     required: ['param'],
    //   },
    //   handler: async (input) => {
    //     return { result: 'hello' };
    //   },
    // },
  ],
});

agent.on('started', ({ name, port }) => {
  console.log(\`\\n🤖 agent://\${name} started on port \${port}\`);
});

(async () => {
  await agent.start();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => { await agent.stop(); process.exit(0); });
  }
})();
`,
  },
};

async function cmdInit(useDefaults = false): Promise<void> {
  console.log(`
╔════════════════════════════════════════════╗
║      🚀 AGENIUM — Create Your Agent       ║
╚════════════════════════════════════════════╝
`);

  const configPath = './agenium.json';
  if (existsSync(configPath)) {
    error('agenium.json already exists in this directory.');
    log('  Run in an empty directory or delete agenium.json first.');
    process.exit(1);
  }

  let agentName: string;
  let description: string;
  let template: string;

  if (useDefaults) {
    // Non-interactive: use sensible defaults
    const dirName = process.cwd().split('/').pop() || 'my-agent';
    agentName = dirName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-') || 'my-agent';
    description = `${agentName} — an AGENIUM agent`;
    template = 'echo';
    log(`  Using defaults: name=${agentName}, template=echo\n`);
  } else {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      // Step 1: Agent name
      log('Step 1/3: Name your agent');
      log('  This becomes your agent:// address (e.g. agent://mybot.agent)\n');
      agentName = await ask(rl, 'Agent name', 'my-agent');
      agentName = agentName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');

      // Step 2: Description
      log('\nStep 2/3: Describe your agent\n');
      description = await ask(rl, 'Description', `${agentName} — an AGENIUM agent`);

      // Step 3: Template
      const templateKeys = Object.keys(TEMPLATES);
      const templateChoices = templateKeys.map((k) => TEMPLATES[k].desc);
      const templateIdx = await askChoice(rl, 'Step 3/3: Choose a template', templateChoices, 0);
      template = templateKeys[templateIdx];
    } finally {
      rl.close();
    }
  }

  // Generate files
  console.log('\n  Creating project...\n');

  const dataDir = './.agenium';
  mkdirSync(dataDir, { recursive: true });

  // agenium.json
  const config = {
    agentId: agentName,
    version: VERSION,
    dataDir,
    dnsServer: '185.204.169.26',
    metricsPort: 9090,
    metricsHost: '127.0.0.1',
    timeouts: {
      dnsLookupMs: 10000,
      handshakeMs: 10000,
      requestMs: 30000,
    },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  success('agenium.json');

  // agent.ts
  const agentCode = TEMPLATES[template].code(agentName, description);
  writeFileSync('./agent.ts', agentCode);
  success('agent.ts');

  // package.json (only if missing)
  if (!existsSync('./package.json')) {
    const pkg = {
      name: agentName,
      version: '1.0.0',
      description,
      type: 'module',
      scripts: {
        start: 'npx tsx agent.ts',
        dev: 'npx tsx --watch agent.ts',
      },
      dependencies: {
        agenium: `^${VERSION}`,
      },
      devDependencies: {
        tsx: '^4.0.0',
        typescript: '^5.0.0',
      },
    };
    writeFileSync('./package.json', JSON.stringify(pkg, null, 2));
    success('package.json');
  }

  // .gitignore
  if (!existsSync('./.gitignore')) {
    writeFileSync('./.gitignore', 'node_modules/\n.agenium/\ndist/\n*.db\n');
    success('.gitignore');
  }

  // Data dir
  success('.agenium/');

  // Next steps
  console.log(`
╔════════════════════════════════════════════╗
║            ✅ Agent Created!               ║
╚════════════════════════════════════════════╝

  Your agent: agent://${agentName}.agent

  Next steps:

    1. Install dependencies:
       ${'\x1b[36m'}npm install${'\x1b[0m'}

    2. Start your agent:
       ${'\x1b[36m'}npm start${'\x1b[0m'}

    3. Test from another terminal:
       ${'\x1b[36m'}npx agenium resolve agent://${agentName}.agent${'\x1b[0m'}

  📖 Docs: https://docs.agenium.net/quickstart
  🐙 GitHub: https://github.com/Aganium/agenium
`);
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
      await cmdInit(args.includes('--yes') || args.includes('-y'));
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

#!/usr/bin/env npx tsx
/**
 * E2E test for all 4 demo agents on the DNS server (185.204.169.26)
 */
import { createAgent } from '../dist/index.js';

const HOST = '185.204.169.26';
const agents = [
  { name: 'echo', port: 9001, tool: 'echo', input: { message: 'Hello from E2E!' } },
  { name: 'weather', port: 9002, tool: 'current', input: { city: 'Tehran' } },
  { name: 'translator', port: 9003, tool: 'languages', input: {} },
  { name: 'helper', port: 9004, tool: 'quickstart', input: {} },
];

const client = createAgent('e2e-tester', { listenPort: 9098, persistence: false });

(async () => {
  await client.start();
  let passed = 0;
  let failed = 0;

  for (const a of agents) {
    try {
      process.stdout.write(`🧪 ${a.name} (${HOST}:${a.port})... `);
      const conn = await client.connect({ host: HOST, port: a.port });
      if (!conn.success) throw new Error(conn.error);

      const tools = await client.listRemoteTools(conn.session!.id);
      const result = await client.callTool(conn.session!.id, a.tool, a.input);
      console.log(`✅ ${tools.tools.length} tools, ${a.tool} → ${JSON.stringify(result.output).slice(0, 80)}`);
      passed++;
    } catch (err) {
      console.log(`❌ ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${agents.length}`);
  await client.stop();
  process.exit(failed > 0 ? 1 : 0);
})();

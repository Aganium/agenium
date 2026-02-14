#!/usr/bin/env npx tsx
import { createAgent } from '../dist/index.js';

const client = createAgent('weather-tester', { listenPort: 9098, persistence: false });

(async () => {
  await client.start();
  console.log('✅ Client started');

  const result = await client.connect({ host: 'localhost', port: 9002 });
  if (!result.success) { console.error('❌', result.error); await client.stop(); process.exit(1); }
  console.log('✅ Connected:', result.session!.id);

  const tools = await client.listRemoteTools(result.session!.id);
  console.log('📋 Tools:', tools.tools.map(t => t.name));

  console.log('\n🌤️  Current weather Tehran...');
  const cur = await client.callTool(result.session!.id, 'current', { city: 'Tehran' });
  console.log(JSON.stringify(cur.output, null, 2));

  console.log('\n📅 Forecast London (2 days)...');
  const fc = await client.callTool(result.session!.id, 'forecast', { city: 'London', days: 2 });
  console.log(JSON.stringify(fc.output, null, 2));

  console.log('\n✅ All weather tests passed!');
  await client.stop();
  process.exit(0);
})();

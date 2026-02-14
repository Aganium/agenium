#!/usr/bin/env npx tsx
/**
 * E2E test: connect to remote demo agents on 130.185.123.153
 */
import { createAgent } from '../dist/index.js';

const REMOTE = '130.185.123.153';
const client = createAgent('e2e-tester', { listenPort: 9097, persistence: false });

(async () => {
  await client.start();
  
  // --- Echo Agent ---
  console.log(`\n🔊 Testing agent://echo @ ${REMOTE}:9001`);
  const echo = await client.connect({ host: REMOTE, port: 9001 });
  if (!echo.success) { console.error('❌ Echo connect:', echo.error); } 
  else {
    const tools = await client.listRemoteTools(echo.session!.id);
    console.log('   Tools:', tools.tools.map(t => t.name).join(', '));
    const r = await client.callTool(echo.session!.id, 'echo', { message: 'E2E test from Mamad!' });
    console.log('   Echo:', JSON.stringify(r.output));
    console.log('   ✅ Echo agent works!');
  }

  // --- Weather Agent ---
  console.log(`\n🌤️  Testing agent://weather @ ${REMOTE}:9002`);
  const weather = await client.connect({ host: REMOTE, port: 9002 });
  if (!weather.success) { console.error('❌ Weather connect:', weather.error); }
  else {
    const tools = await client.listRemoteTools(weather.session!.id);
    console.log('   Tools:', tools.tools.map(t => t.name).join(', '));
    const r = await client.callTool(weather.session!.id, 'current', { city: 'Tehran' });
    console.log('   Tehran:', JSON.stringify(r.output));
    console.log('   ✅ Weather agent works!');
  }

  console.log('\n🎉 E2E Remote Test Complete!');
  await client.stop();
  process.exit(0);
})();

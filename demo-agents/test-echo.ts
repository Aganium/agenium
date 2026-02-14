#!/usr/bin/env npx tsx
/**
 * Quick integration test for echo agent
 */
import { createAgent } from '../dist/index.js';

const client = createAgent('test-client', {
  listenPort: 9099,
  persistence: false,
});

(async () => {
  await client.start();
  console.log('✅ Test client started');

  // Connect to echo agent (direct, no DNS)
  console.log('📡 Connecting to echo agent...');
  const result = await client.connect({ host: 'localhost', port: 9001 });
  
  if (!result.success) {
    console.error('❌ Connect failed:', result.error);
    await client.stop();
    process.exit(1);
  }
  
  console.log('✅ Connected! Session:', result.session!.id);

  // List tools
  console.log('\n📋 Listing remote tools...');
  const tools = await client.listRemoteTools(result.session!.id);
  console.log('Tools:', JSON.stringify(tools.tools.map(t => t.name)));

  // Invoke echo
  console.log('\n🔊 Invoking echo...');
  const echoResult = await client.callTool(result.session!.id, 'echo', { message: 'Hello AGENIUM!' });
  console.log('Result:', JSON.stringify(echoResult.output));

  // Invoke ping
  console.log('\n🏓 Invoking ping...');
  const pingResult = await client.callTool(result.session!.id, 'ping', {});
  console.log('Result:', JSON.stringify(pingResult.output));

  // Invoke info
  console.log('\n📦 Invoking info...');
  const infoResult = await client.callTool(result.session!.id, 'info', {});
  console.log('Result:', JSON.stringify(infoResult.output));

  console.log('\n✅ All tests passed!');
  await client.stop();
  process.exit(0);
})();

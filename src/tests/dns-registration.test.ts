/**
 * Signed DNS registration tests
 *
 * A mock registry checks that register()/unregister() send payloads whose
 * signatures verify against the agent's identity key — the same check the
 * real registry at dns.agenium.net performs.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { verifyAgentSignature } from '../crypto/keys.js';
import { dnsRegisterMessage, dnsDeleteMessage, DNSResolver, DEFAULT_DNS_SERVER } from '../dns/index.js';

interface Captured {
  method: string;
  url: string;
  body: Record<string, any>;
}

describe('DNS signed payloads', () => {
  it('uses the exact newline-joined format the registry verifies', () => {
    assert.equal(
      dnsRegisterMessage('Alice', 'https://a.example.com:8443', 'PUB', 1700000000000),
      'agenium-dns/v1/register\nalice\nhttps://a.example.com:8443\nPUB\n1700000000000',
    );
    assert.equal(dnsDeleteMessage('Alice', 1700000000000), 'agenium-dns/v1/delete\nalice\n1700000000000');
  });
});

describe('DNSResolver defaults', () => {
  it('points at dns.agenium.net over HTTPS', () => {
    assert.equal(new DNSResolver().baseUrl(), `https://${DEFAULT_DNS_SERVER}`);
  });

  it('redirects the retired 185.204.169.26 server', () => {
    const r = new DNSResolver({ server: '185.204.169.26', port: 3000, useHttps: false });
    assert.equal(r.baseUrl(), `https://${DEFAULT_DNS_SERVER}`);
  });
});

describe('Agent.register() / unregister()', () => {
  let server: http.Server;
  let port: number;
  let dataDir: string;
  const captured: Captured[] = [];

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenium-dns-test-'));
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        captured.push({ method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : {} });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  after(() => {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('sends a registration signed by the identity key', async () => {
    const { createAgent } = await import('../agent.js');
    const agent = createAgent('SignTest', { persistence: false, dataDir });
    agent.setDNSServer('127.0.0.1', port, false);

    const result = await agent.register({ host: 'agent.example.com' });
    assert.equal(result.success, true, result.error);
    assert.equal(result.domain, 'signtest');

    const req = captured.at(-1)!;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/agents/register');
    assert.equal(req.body.name, 'signtest');
    assert.ok(Math.abs(Date.now() - req.body.timestamp) < 60_000);

    const msg = dnsRegisterMessage(req.body.name, req.body.endpoint, req.body.publicKey, req.body.timestamp);
    assert.ok(verifyAgentSignature(Buffer.from(msg), req.body.signature, req.body.publicKey), 'signature must verify');

    // tampering with the endpoint must break the signature
    const forged = dnsRegisterMessage(req.body.name, 'https://evil.example.com', req.body.publicKey, req.body.timestamp);
    assert.equal(verifyAgentSignature(Buffer.from(forged), req.body.signature, req.body.publicKey), false);
  });

  it('accepts the legacy (apiKey, host) call shape', async () => {
    const { createAgent } = await import('../agent.js');
    const agent = createAgent('LegacyCall', { persistence: false, dataDir });
    agent.setDNSServer('127.0.0.1', port, false);

    const result = await agent.register('dom_ignored', 'legacy.example.com');
    assert.equal(result.success, true, result.error);
    assert.match(captured.at(-1)!.body.endpoint, /legacy\.example\.com/);
  });

  it('sends a signed deletion', async () => {
    const { createAgent } = await import('../agent.js');
    const agent = createAgent('SignTest', { persistence: false, dataDir });
    agent.setDNSServer('127.0.0.1', port, false);

    const result = await agent.unregister();
    assert.equal(result.success, true, result.error);

    const req = captured.at(-1)!;
    assert.equal(req.method, 'DELETE');
    assert.equal(req.url, '/api/agents/signtest');

    // same data dir -> same identity key as the registration above
    const regPublicKey = captured.find((c) => c.body.name === 'signtest')!.body.publicKey;
    const msg = dnsDeleteMessage('signtest', req.body.timestamp);
    assert.ok(verifyAgentSignature(Buffer.from(msg), req.body.signature, regPublicKey));
  });
});

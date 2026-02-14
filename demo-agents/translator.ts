#!/usr/bin/env npx tsx
/**
 * agent://translator — Translation demo agent
 * 
 * Tools:
 *   translate({text, from?, to}) → translated text
 *   detect({text}) → detected language
 *   languages() → supported language list
 * 
 * Uses MyMemory Translation API (free, no key needed)
 */

import { createAgent } from '../dist/index.js';

const PORT = parseInt(process.env.PORT ?? '9003');
const DNS_API_KEY = process.env.DNS_API_KEY ?? '';
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? 'localhost';
const DNS_SERVER = process.env.DNS_SERVER ?? '185.204.169.26:3000';

const LANGUAGES: Record<string, string> = {
  en: 'English', fa: 'Persian', ar: 'Arabic', fr: 'French',
  de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese',
  ru: 'Russian', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
  tr: 'Turkish', hi: 'Hindi', nl: 'Dutch', sv: 'Swedish',
};

async function translateText(text: string, from: string, to: string): Promise<string> {
  const langpair = `${from}|${to}`;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langpair)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'agenium-translator/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Translation API error: ${res.status}`);
  const data = await res.json() as any;
  if (data.responseStatus !== 200) {
    throw new Error(data.responseDetails ?? 'Translation failed');
  }
  return data.responseData?.translatedText ?? '';
}

const agent = createAgent('translator', {
  listenPort: PORT,
  dnsServer: DNS_SERVER,
  persistence: true,
  tools: [
    {
      name: 'translate',
      description: 'Translate text between languages',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to translate' },
          from: { type: 'string', description: 'Source language code (e.g. "en"). Default: auto-detect' },
          to: { type: 'string', description: 'Target language code (e.g. "fa")' },
        },
        required: ['text', 'to'],
      },
      handler: async (input) => {
        const { text, from = 'auto', to } = input as { text: string; from?: string; to: string };
        const translated = await translateText(text, from === 'auto' ? '' : from, to);
        return {
          original: text,
          translated,
          from: from === 'auto' ? 'auto-detected' : (LANGUAGES[from] ?? from),
          to: LANGUAGES[to] ?? to,
          timestamp: new Date().toISOString(),
        };
      },
    },
    {
      name: 'detect',
      description: 'Detect the language of a text',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to analyze' },
        },
        required: ['text'],
      },
      handler: async (input) => {
        const { text } = input as { text: string };
        // Use translation API with en target — it returns detected language
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 200))}&langpair=|en`;
        const res = await fetch(url, {
          headers: { 'User-Agent': 'agenium-translator/1.0' },
          signal: AbortSignal.timeout(10000),
        });
        const data = await res.json() as any;
        const detected = data.responseData?.detectedLanguage ?? null;
        return {
          text: text.slice(0, 100) + (text.length > 100 ? '...' : ''),
          detectedLanguage: detected,
          confidence: data.responseData?.match ?? null,
        };
      },
    },
    {
      name: 'languages',
      description: 'List supported languages',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({
        languages: Object.entries(LANGUAGES).map(([code, name]) => ({ code, name })),
        count: Object.keys(LANGUAGES).length,
      }),
    },
  ],
});

agent.on('started', ({ port }) => {
  console.log(`\n🌐 agent://translator started on port ${port}`);
  console.log(`   Tools: translate, detect, languages`);
});
agent.on('connection', ({ sessionId, remoteAgent }) => {
  console.log(`📡 Connection: ${remoteAgent?.name ?? '?'} (${sessionId})`);
});
agent.on('registered', ({ domain }) => {
  console.log(`✅ DNS: ${domain}`);
});

(async () => {
  await agent.start();
  if (DNS_API_KEY) {
    const r = await agent.register(DNS_API_KEY, PUBLIC_HOST);
    if (!r.success) console.warn(`⚠️  DNS failed: ${r.error}`);
  } else {
    console.log('ℹ️  No DNS_API_KEY — local-only mode');
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => { await agent.stop(); process.exit(0); });
  }
})();

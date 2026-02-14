#!/usr/bin/env npx tsx
/**
 * agent://weather — Weather lookup demo agent
 * 
 * Tools:
 *   current({city}) → current weather for a city
 *   forecast({city, days?}) → multi-day forecast
 * 
 * Uses wttr.in (free, no API key needed)
 */

import { createAgent } from '../dist/index.js';

const PORT = parseInt(process.env.PORT ?? '9002');
const DNS_API_KEY = process.env.DNS_API_KEY ?? '';
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? 'localhost';
const DNS_SERVER = process.env.DNS_SERVER ?? '185.204.169.26:3000';

async function fetchWeather(city: string, format: string = 'j1'): Promise<any> {
  const encoded = encodeURIComponent(city);
  const res = await fetch(`https://wttr.in/${encoded}?format=${format}`, {
    headers: { 'User-Agent': 'agenium-weather/1.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Weather API error: ${res.status}`);
  return format === 'j1' ? res.json() : res.text();
}

const agent = createAgent('weather', {
  listenPort: PORT,
  dnsServer: DNS_SERVER,
  persistence: true,
  tools: [
    {
      name: 'current',
      description: 'Get current weather for a city',
      inputSchema: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name (e.g. "Tehran", "London")' },
        },
        required: ['city'],
      },
      handler: async (input) => {
        const { city } = input as { city: string };
        const data = await fetchWeather(city);
        const cur = data.current_condition?.[0];
        if (!cur) throw new Error(`No weather data for "${city}"`);
        return {
          city,
          temperature_c: parseInt(cur.temp_C),
          feels_like_c: parseInt(cur.FeelsLikeC),
          humidity: parseInt(cur.humidity),
          description: cur.weatherDesc?.[0]?.value ?? 'Unknown',
          wind_kmph: parseInt(cur.windspeedKmph),
          wind_dir: cur.winddir16Point,
          visibility_km: parseInt(cur.visibility),
          uv_index: parseInt(cur.uvIndex),
          observation_time: cur.observation_time,
        };
      },
    },
    {
      name: 'forecast',
      description: 'Get multi-day weather forecast for a city',
      inputSchema: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name' },
          days: { type: 'number', description: 'Number of days (1-3, default 3)' },
        },
        required: ['city'],
      },
      handler: async (input) => {
        const { city, days = 3 } = input as { city: string; days?: number };
        const data = await fetchWeather(city);
        const forecasts = (data.weather ?? []).slice(0, Math.min(days, 3)).map((day: any) => ({
          date: day.date,
          max_c: parseInt(day.maxtempC),
          min_c: parseInt(day.mintempC),
          avg_c: parseInt(day.avgtempC),
          description: day.hourly?.[4]?.weatherDesc?.[0]?.value ?? 'Unknown',
          chance_of_rain: parseInt(day.hourly?.[4]?.chanceofrain ?? '0'),
          total_snow_cm: parseFloat(day.totalSnow_cm ?? '0'),
          sunrise: day.astronomy?.[0]?.sunrise,
          sunset: day.astronomy?.[0]?.sunset,
        }));
        return { city, days: forecasts.length, forecast: forecasts };
      },
    },
  ],
});

agent.on('started', ({ port }) => {
  console.log(`\n🌤️  agent://weather started on port ${port}`);
  console.log(`   Tools: current, forecast`);
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

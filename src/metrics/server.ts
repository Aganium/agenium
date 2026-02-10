/**
 * Agenium Metrics HTTP Server
 * Lightweight server for /health and /metrics endpoints
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { getHealth, getMetricsText } from './index.js';

export interface MetricsServerConfig {
  port: number;
  version: string;
}

export class MetricsServer {
  private server: ReturnType<typeof createServer> | null = null;
  private config: MetricsServerConfig;

  constructor(config: Partial<MetricsServerConfig> = {}) {
    this.config = {
      port: config.port ?? parseInt(process.env.METRICS_PORT ?? '9090'),
      version: config.version ?? '0.1.0',
    };
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(this.config.port, () => {
        console.log(`[MetricsServer] Listening on port ${this.config.port}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const path = req.url ?? '/';

    if (path === '/health' || path === '/healthz') {
      const health = getHealth(this.config.version);
      res.writeHead(health.ok ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health, null, 2));
      return;
    }

    if (path === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(getMetricsText());
      return;
    }

    if (path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html>
<html>
<head><title>Agenium Metrics</title></head>
<body>
<h1>Agenium Metrics Server</h1>
<ul>
  <li><a href="/health">/health</a> - Health status (JSON)</li>
  <li><a href="/metrics">/metrics</a> - Prometheus metrics</li>
</ul>
</body>
</html>`);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }
}

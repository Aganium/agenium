/**
 * DNS Resolver Module
 * Resolves agent:// URIs to AgentEndpoint via DNS system
 */

import { AgentEndpoint, AgentID, parseAgentURI, now } from '../core/types.js';

// ============================================================================
// Types
// ============================================================================

export interface DNSResolverConfig {
  /** DNS server address */
  server: string;
  /** Request timeout in ms */
  timeoutMs: number;
  /** Cache TTL in seconds */
  cacheTtlSeconds: number;
}

export interface DNSResponse {
  success: boolean;
  agent?: {
    name: string;
    publicKey: string;
    description?: string;
    endpoint: string;
    certFingerprint?: string;
    protocolVersions: string[];
    capabilities: string[];
    ttl: number;
  };
  error?: {
    code: string;
    message: string;
  };
}

export type ResolveResult = {
  ok: true;
  endpoint: AgentEndpoint;
} | {
  ok: false;
  error: ResolveError;
}

export interface ResolveError {
  code: 'INVALID_URI' | 'NOT_FOUND' | 'DNS_ERROR' | 'TIMEOUT' | 'NETWORK_ERROR';
  message: string;
}

// ============================================================================
// DNS Resolver
// ============================================================================

export class DNSResolver {
  private config: DNSResolverConfig;
  private cache: Map<string, { endpoint: AgentEndpoint; expiresAt: number }>;

  constructor(config: Partial<DNSResolverConfig> = {}) {
    this.config = {
      server: config.server ?? '185.204.169.26',
      timeoutMs: config.timeoutMs ?? 10000,
      cacheTtlSeconds: config.cacheTtlSeconds ?? 300,
    };
    this.cache = new Map();
  }

  /**
   * Resolve an agent:// URI to an endpoint
   */
  async resolve(agentUri: string): Promise<ResolveResult> {
    // Parse URI
    const parsed = parseAgentURI(agentUri);
    if (!parsed) {
      return {
        ok: false,
        error: {
          code: 'INVALID_URI',
          message: `Invalid agent URI: ${agentUri}. Expected format: agent://<name>`,
        },
      };
    }

    const { name } = parsed;

    // Check cache
    const cached = this.cache.get(name);
    if (cached && cached.expiresAt > now()) {
      return { ok: true, endpoint: cached.endpoint };
    }

    // Query DNS
    try {
      const response = await this.queryDNS(name);
      
      if (!response.success || !response.agent) {
        return {
          ok: false,
          error: {
            code: 'NOT_FOUND',
            message: response.error?.message ?? `Agent not found: ${name}`,
          },
        };
      }

      const agent = response.agent;
      const endpoint: AgentEndpoint = {
        agentId: {
          name: agent.name,
          publicKey: agent.publicKey,
          description: agent.description,
        },
        url: agent.endpoint,
        certFingerprint: agent.certFingerprint,
        protocolVersions: agent.protocolVersions,
        capabilities: agent.capabilities,
        ttl: agent.ttl,
        resolvedAt: now(),
      };

      // Cache the result
      this.cache.set(name, {
        endpoint,
        expiresAt: now() + (agent.ttl * 1000),
      });

      return { ok: true, endpoint };
    } catch (err) {
      const error = err as Error;
      
      if (error.name === 'AbortError') {
        return {
          ok: false,
          error: {
            code: 'TIMEOUT',
            message: `DNS query timed out after ${this.config.timeoutMs}ms`,
          },
        };
      }

      return {
        ok: false,
        error: {
          code: 'NETWORK_ERROR',
          message: `DNS query failed: ${error.message}`,
        },
      };
    }
  }

  /**
   * Query the DNS server for agent info
   */
  private async queryDNS(agentName: string): Promise<DNSResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const url = `https://${this.config.server}/api/agents/${encodeURIComponent(agentName)}`;
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'AGENIUM/0.1.0',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 404) {
          return {
            success: false,
            error: { code: 'NOT_FOUND', message: `Agent '${agentName}' not found` },
          };
        }
        return {
          success: false,
          error: { code: 'DNS_ERROR', message: `DNS returned ${response.status}` },
        };
      }

      const data = await response.json() as DNSResponse['agent'];
      return { success: true, agent: data };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Invalidate a cached entry
   */
  invalidate(agentName: string): void {
    this.cache.delete(agentName);
  }

  /**
   * Clear the entire cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; entries: string[] } {
    return {
      size: this.cache.size,
      entries: Array.from(this.cache.keys()),
    };
  }
}

// ============================================================================
// Singleton instance
// ============================================================================

let defaultResolver: DNSResolver | null = null;

export function getResolver(config?: Partial<DNSResolverConfig>): DNSResolver {
  if (!defaultResolver) {
    defaultResolver = new DNSResolver(config);
  }
  return defaultResolver;
}

export function resetResolver(): void {
  defaultResolver = null;
}

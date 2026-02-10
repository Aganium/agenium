/**
 * DNS Resolver
 * Resolves agent:// URIs to endpoints via DNS system at 185.204.169.26
 */

import {
  ResolvedAgent,
  ResolveResult,
  DNSLookupResponse,
  DNSErrorCode,
  validateAgentName,
  parseAgentURI,
} from './types.js';
import { verifyAgentSignature } from '../crypto/keys.js';
import { getBugReporter } from '../bug-report/reporter.js';
import { now } from '../core/types.js';

// ============================================================================
// Configuration
// ============================================================================

export interface DNSResolverConfig {
  /** DNS server address */
  server: string;
  /** Request timeout in ms */
  timeoutMs: number;
  /** Default cache TTL in seconds (used if server doesn't provide TTL) */
  defaultTtlSeconds: number;
  /** Whether to use HTTPS (true) or HTTP (false) */
  useHttps: boolean;
  /** Port for DNS server */
  port: number;
}

const DEFAULT_CONFIG: DNSResolverConfig = {
  server: '185.204.169.26',
  timeoutMs: 10000,
  defaultTtlSeconds: 300,
  useHttps: false,  // DNS server uses HTTP
  port: 3000,       // DNS server port
};

// ============================================================================
// Cache Entry
// ============================================================================

interface CacheEntry {
  agent: ResolvedAgent;
  expiresAt: number;
}

// ============================================================================
// DNS Resolver
// ============================================================================

export class DNSResolver {
  private config: DNSResolverConfig;
  private cache: Map<string, CacheEntry> = new Map();
  private pendingRequests: Map<string, Promise<ResolveResult>> = new Map();

  constructor(config: Partial<DNSResolverConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Resolve an agent:// URI to agent info
   */
  async resolve(agentUri: string): Promise<ResolveResult> {
    const startTime = now();
    getBugReporter().recordAction('dns_resolve', { uri: agentUri });

    // Parse URI
    const parsed = parseAgentURI(agentUri);
    if (!parsed) {
      const error = {
        code: DNSErrorCode.INVALID_NAME,
        message: `Invalid agent URI: ${agentUri}. Expected format: agent://<name>`,
      };
      getBugReporter().report('protocol', 'DNS_INVALID_URI', error.message);
      return { ok: false, error };
    }

    const { name, tld } = parsed;
    
    // Build full domain name (name.tld or just name if no tld)
    const fullName = tld ? `${name}.${tld}` : name;

    // Validate name
    if (!validateAgentName(name)) {
      const error = {
        code: DNSErrorCode.INVALID_NAME,
        message: `Invalid agent name: ${name}. Must start with letter, 1-63 chars, alphanumeric with _ -`,
      };
      getBugReporter().report('protocol', 'DNS_INVALID_NAME', error.message);
      return { ok: false, error };
    }

    // Check cache
    const cached = this.cache.get(fullName);
    if (cached && cached.expiresAt > now()) {
      getBugReporter().recordAction('dns_cache_hit', { name: fullName, age: now() - cached.agent.resolvedAt });
      return { ok: true, agent: cached.agent };
    }

    // Check for pending request (dedup)
    const pending = this.pendingRequests.get(fullName);
    if (pending) {
      return pending;
    }

    // Make the request
    const requestPromise = this.doResolve(fullName);
    this.pendingRequests.set(fullName, requestPromise);

    try {
      const result = await requestPromise;
      const duration = now() - startTime;
      getBugReporter().recordAction('dns_resolved', { name: fullName, success: result.ok, durationMs: duration });
      return result;
    } finally {
      this.pendingRequests.delete(fullName);
    }
  }

  /**
   * Perform the actual DNS lookup
   */
  private async doResolve(name: string): Promise<ResolveResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const protocol = this.config.useHttps ? 'https' : 'http';
      const portSuffix = (this.config.useHttps && this.config.port === 443) || 
                         (!this.config.useHttps && this.config.port === 80) 
                         ? '' : `:${this.config.port}`;
      // DNS API endpoint: /agent/lookup/:domain
      const url = `${protocol}://${this.config.server}${portSuffix}/agent/lookup/${encodeURIComponent(name)}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'AGENIUM/0.1.0',
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      // Handle HTTP errors
      if (!response.ok) {
        if (response.status === 404) {
          return {
            ok: false,
            error: {
              code: DNSErrorCode.NOT_FOUND,
              message: `Agent not found: ${name}`,
            },
          };
        }
        return {
          ok: false,
          error: {
            code: DNSErrorCode.SERVER_ERROR,
            message: `DNS server returned ${response.status}: ${response.statusText}`,
          },
        };
      }

      // Parse response
      // DNS server returns: { success: true, data: { domain, endpoint, status, ... } }
      const responseData = await response.json() as { success: boolean; data?: { domain: string; endpoint: string; status: string; health?: string; publicKey?: string; capabilities?: string[]; protocolVersions?: string[]; }; error?: { code: DNSErrorCode; message: string } };

      if (!responseData.success || !responseData.data) {
        return {
          ok: false,
          error: responseData.error ?? {
            code: DNSErrorCode.NOT_FOUND,
            message: `Agent not found: ${name}`,
          },
        };
      }

      const agentData = responseData.data;

      // Parse endpoint URL
      let host: string;
      let port: number;
      try {
        const endpointUrl = new URL(agentData.endpoint);
        host = endpointUrl.hostname;
        port = endpointUrl.port ? parseInt(endpointUrl.port) : (endpointUrl.protocol === 'https:' ? 443 : 80);
      } catch {
        return {
          ok: false,
          error: {
            code: DNSErrorCode.SERVER_ERROR,
            message: `Invalid endpoint URL: ${agentData.endpoint}`,
          },
        };
      }

      // Build resolved agent
      const ttlSeconds = this.config.defaultTtlSeconds;
      const resolvedAgent: ResolvedAgent = {
        name: agentData.domain,
        publicKey: agentData.publicKey ?? '',
        endpoint: agentData.endpoint,
        host,
        port,
        description: undefined,
        capabilities: agentData.capabilities ?? [],
        protocolVersions: agentData.protocolVersions ?? ['1.0'],
        resolvedAt: now(),
        expiresAt: now() + (ttlSeconds * 1000),
      };

      // Cache the result
      this.cache.set(name, {
        agent: resolvedAgent,
        expiresAt: resolvedAgent.expiresAt,
      });

      return { ok: true, agent: resolvedAgent };

    } catch (err) {
      clearTimeout(timeout);
      const error = err as Error;

      if (error.name === 'AbortError') {
        getBugReporter().report('timeout', 'DNS_TIMEOUT', `DNS query timed out after ${this.config.timeoutMs}ms`);
        return {
          ok: false,
          error: {
            code: DNSErrorCode.TIMEOUT,
            message: `DNS query timed out after ${this.config.timeoutMs}ms`,
          },
        };
      }

      getBugReporter().report('connection', 'DNS_NETWORK_ERROR', error.message);
      return {
        ok: false,
        error: {
          code: DNSErrorCode.NETWORK_ERROR,
          message: `DNS query failed: ${error.message}`,
        },
      };
    }
  }

  /**
   * Verify that a connected agent's public key matches DNS record
   */
  async verifyAgentKey(name: string, presentedKey: string): Promise<boolean> {
    const result = await this.resolve(`agent://${name}`);
    if (!result.ok) {
      getBugReporter().report('protocol', 'DNS_VERIFY_FAILED', `Cannot verify key: ${result.error.message}`);
      return false;
    }

    if (result.agent.publicKey !== presentedKey) {
      getBugReporter().report('protocol', 'KEY_MISMATCH', 
        `Public key mismatch for agent ${name}. DNS: ${result.agent.publicKey.slice(0, 20)}..., presented: ${presentedKey.slice(0, 20)}...`);
      return false;
    }

    return true;
  }

  /**
   * Invalidate a cached entry
   */
  invalidate(name: string): void {
    this.cache.delete(name);
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
  getCacheStats(): {
    size: number;
    entries: Array<{ name: string; expiresIn: number }>;
  } {
    const entries: Array<{ name: string; expiresIn: number }> = [];
    const currentTime = now();

    for (const [name, entry] of this.cache) {
      entries.push({
        name,
        expiresIn: Math.max(0, entry.expiresAt - currentTime),
      });
    }

    return { size: this.cache.size, entries };
  }

  /**
   * Prune expired cache entries
   */
  pruneCache(): number {
    const currentTime = now();
    let pruned = 0;

    for (const [name, entry] of this.cache) {
      if (entry.expiresAt <= currentTime) {
        this.cache.delete(name);
        pruned++;
      }
    }

    return pruned;
  }
}

// ============================================================================
// Singleton
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

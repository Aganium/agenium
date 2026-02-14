/**
 * @agenium/mcp-server — Discovery
 *
 * Discover MCP-bridged agents on the AGENIUM network and call their tools.
 */

import { DNSResolver, createAgent, Agent, createClient } from 'agenium';
import { MCPToolInfo, MCPResourceInfo, MCPPromptInfo } from './types.js';

// ============================================================================
// Discovery Config
// ============================================================================

export interface MCPDiscoveryConfig {
  /** DNS server address */
  dnsServer?: string;
  /** DNS server port */
  dnsPort?: number;
  /** Request timeout in ms */
  timeoutMs?: number;
}

const DEFAULTS = {
  dnsServer: '185.204.169.26',
  dnsPort: 3000,
  timeoutMs: 15_000,
};

// ============================================================================
// Discovered MCP Agent
// ============================================================================

export interface DiscoveredMCPAgent {
  /** Agent name */
  name: string;
  /** Agent URI */
  uri: string;
  /** Endpoint URL */
  endpoint: string;
  /** Available tools */
  tools: MCPToolInfo[];
  /** Available resources */
  resources: MCPResourceInfo[];
  /** Available prompts */
  prompts: MCPPromptInfo[];
  /** Raw capabilities list */
  capabilities: string[];
}

// ============================================================================
// MCP Client (for calling remote MCP-bridged agents)
// ============================================================================

export class MCPAgentClient {
  private agent: Agent;
  private config: MCPDiscoveryConfig;
  private started = false;

  constructor(clientName: string, config?: MCPDiscoveryConfig) {
    this.config = { ...DEFAULTS, ...config };
    this.agent = createAgent(clientName, {
      dnsServer: this.config.dnsServer,
      listenPort: 0,
      persistence: false,
    });
  }

  /** Start the client agent */
  async start(): Promise<void> {
    if (this.started) return;
    await this.agent.start();
    this.started = true;
  }

  /** Stop the client agent */
  async stop(): Promise<void> {
    if (!this.started) return;
    await this.agent.stop();
    this.started = false;
  }

  /**
   * Connect to an MCP-bridged agent and discover its capabilities
   */
  async discover(agentUri: string): Promise<DiscoveredMCPAgent | null> {
    this.ensureStarted();

    const result = await this.agent.connect(agentUri);
    if (!result.success || !result.session) {
      return null;
    }

    const sessionId = result.session.id;

    try {
      // Get capabilities
      const caps = await this.agent.request(sessionId, 'capabilities') as any;

      // Get tools
      const toolsResult = await this.agent.request(sessionId, 'tools/list') as any;
      const tools: MCPToolInfo[] = toolsResult?.tools ?? [];

      // Get resources
      let resources: MCPResourceInfo[] = [];
      try {
        const resourcesResult = await this.agent.request(sessionId, 'resources/list') as any;
        resources = resourcesResult?.resources ?? [];
      } catch {
        // May not support resources
      }

      // Get prompts
      let prompts: MCPPromptInfo[] = [];
      try {
        const promptsResult = await this.agent.request(sessionId, 'prompts/list') as any;
        prompts = promptsResult?.prompts ?? [];
      } catch {
        // May not support prompts
      }

      return {
        name: caps?.agent ?? agentUri.replace('agent://', ''),
        uri: agentUri,
        endpoint: '',
        tools,
        resources,
        prompts,
        capabilities: caps?.tools ?? [],
      };
    } catch {
      return null;
    }
  }

  /**
   * Call a tool on a remote MCP-bridged agent
   */
  async callTool(
    agentUri: string,
    toolName: string,
    args?: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean;
  }> {
    this.ensureStarted();

    const result = await this.agent.connect(agentUri);
    if (!result.success || !result.session) {
      throw new Error(`Failed to connect to ${agentUri}: ${result.error}`);
    }

    const response = await this.agent.request(result.session.id, 'tools/call', {
      name: toolName,
      arguments: args,
    }) as any;

    if (response?.error) {
      throw new Error(`Tool call failed: ${response.error.message}`);
    }

    return {
      content: response?.content ?? [],
      isError: response?.isError,
    };
  }

  /**
   * Read a resource from a remote MCP-bridged agent
   */
  async readResource(
    agentUri: string,
    resourceUri: string,
  ): Promise<{
    contents: Array<{ uri: string; text?: string; blob?: string; mimeType?: string }>;
  }> {
    this.ensureStarted();

    const result = await this.agent.connect(agentUri);
    if (!result.success || !result.session) {
      throw new Error(`Failed to connect to ${agentUri}: ${result.error}`);
    }

    const response = await this.agent.request(result.session.id, 'resources/read', {
      uri: resourceUri,
    }) as any;

    if (response?.error) {
      throw new Error(`Resource read failed: ${response.error.message}`);
    }

    return { contents: response?.contents ?? [] };
  }

  /**
   * Get a prompt from a remote MCP-bridged agent
   */
  async getPrompt(
    agentUri: string,
    promptName: string,
    args?: Record<string, string>,
  ): Promise<{
    description?: string;
    messages: Array<{ role: string; content: { type: string; text?: string } }>;
  }> {
    this.ensureStarted();

    const result = await this.agent.connect(agentUri);
    if (!result.success || !result.session) {
      throw new Error(`Failed to connect to ${agentUri}: ${result.error}`);
    }

    const response = await this.agent.request(result.session.id, 'prompts/get', {
      name: promptName,
      arguments: args,
    }) as any;

    if (response?.error) {
      throw new Error(`Prompt get failed: ${response.error.message}`);
    }

    return {
      description: response?.description,
      messages: response?.messages ?? [],
    };
  }

  private ensureStarted(): void {
    if (!this.started) {
      throw new Error('MCPAgentClient not started. Call start() first.');
    }
  }
}

/**
 * @agenium/mcp-server
 *
 * Bridge MCP (Model Context Protocol) servers to the AGENIUM agent:// network.
 *
 * Usage:
 * ```typescript
 * import { MCPBridge } from '@agenium/mcp-server';
 *
 * const bridge = new MCPBridge({
 *   name: 'weather-tools',
 *   mcp: {
 *     transport: 'stdio',
 *     command: 'npx',
 *     args: ['-y', '@modelcontextprotocol/server-weather'],
 *   },
 *   agent: {
 *     publicHost: '203.0.113.1',
 *   },
 * });
 *
 * await bridge.start();
 * // Now registered as agent://weather-tools on the AGENIUM network
 * ```
 */

// Main bridge
export { MCPBridge } from './bridge.js';

// Discovery client
export { MCPAgentClient, type DiscoveredMCPAgent, type MCPDiscoveryConfig } from './discovery.js';

// Transport manager (for advanced use)
export { MCPTransportManager } from './mcp-transport.js';

// Types
export {
  type MCPBridgeConfig,
  type MCPStdioConfig,
  type MCPHttpConfig,
  type MCPStreamableHttpConfig,
  type MCPServerConfig,
  type MCPToolInfo,
  type MCPResourceInfo,
  type MCPPromptInfo,
  BridgeState,
} from './types.js';

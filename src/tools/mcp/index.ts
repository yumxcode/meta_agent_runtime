export { registerMcpClient, unregisterMcpClient, getRegisteredMcpServers } from './registry.js'
export type { McpClient } from './registry.js'
export { HttpMcpClient } from './HttpMcpClient.js'
export { loadMcpConfig, MCP_CONFIG_PATH, buildMcpServerInstructions } from './mcpConfigFile.js'
export { createMcpCallTool } from './mcp_call/index.js'
export { createListMcpResourcesTool } from './list_mcp_resources/index.js'
export { createReadMcpResourceTool } from './read_mcp_resource/index.js'
import type { MetaAgentTool } from '../../core/types.js'
import { createMcpCallTool } from './mcp_call/index.js'
import { createListMcpResourcesTool } from './list_mcp_resources/index.js'
import { createReadMcpResourceTool } from './read_mcp_resource/index.js'
export async function createMcpTools(): Promise<MetaAgentTool[]> {
  return Promise.all([createMcpCallTool(), createListMcpResourcesTool(), createReadMcpResourceTool()])
}

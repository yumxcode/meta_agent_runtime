import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'
import { mcpClients } from '../registry.js'

export async function createMcpCallTool(): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'mcp_call',
    description,
    permission: { category: 'network', checkpointBoundary: 'both' },
    inputSchema: {
      type: 'object',
      properties: {
        server_name: { type: 'string', description: 'MCP server name' },
        tool_name: { type: 'string', description: 'Tool name on the server' },
        tool_input: { type: 'object', description: 'Input parameters' },
      },
      required: ['server_name', 'tool_name'],
    },
    async call(input: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> {
      const serverName = input['server_name'] as string
      const toolName = input['tool_name'] as string
      const toolInput = (input['tool_input'] as Record<string, unknown>) ?? {}
      const client = mcpClients.get(serverName)
      if (!client) {
        const avail = [...mcpClients.keys()]
        return { content: `MCP server "${serverName}" not found. Available: ${avail.length ? avail.join(', ') : 'none'}`, isError: true }
      }
      try {
        const result = await client.callTool(toolName, toolInput)
        const text = result.content.filter(c => c.type === 'text' && c.text).map(c => c.text!).join('\n')
        return { content: text || '(no output)', isError: false }
      } catch (err) {
        return { content: `MCP error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  }
}

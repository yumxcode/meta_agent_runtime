import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'
import {
  getMcpAppPresenter,
  getMcpAppResourceUri,
  isMcpToolVisibleTo,
  mcpClients,
  type McpToolResult,
} from '../registry.js'

function modelText(result: McpToolResult): string {
  const text = (Array.isArray(result.content) ? result.content : [])
    .filter(c => c.type === 'text' && typeof c.text === 'string')
    .map(c => c.text!)
    .join('\n')
  if (text) return text
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent)
  return '(no output)'
}

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
        // Fail CLOSED on an unknown tool.
        //
        // This used to read `if (tool && !isMcpToolVisibleTo(...))`, so a tool
        // missing from tools/list skipped the visibility check entirely and the
        // call went out anyway — meaning a server could hide an app-only tool
        // from its own listing and have the model call it. listTools() is cached
        // (registry.cachedListTools), so this lookup is not a round-trip.
        const tool = (await client.listTools()).find(candidate => candidate.name === toolName)
        if (!tool) {
          return {
            content: `MCP tool "${toolName}" is not advertised by server "${serverName}".`,
            isError: true,
          }
        }
        if (!isMcpToolVisibleTo(tool, 'model')) {
          return { content: `MCP tool "${toolName}" is app-only and cannot be called by the model`, isError: true }
        }
        const result = await client.callTool(toolName, toolInput)
        let appNotice = ''
        const presenter = getMcpAppPresenter()
        const resourceUri = getMcpAppResourceUri(tool)
        if (presenter && resourceUri) {
          try {
            await presenter.present({ serverName, tool, toolInput, toolResult: result, resourceUri, client })
            appNotice = `\n\n[MCP App rendered in the local browser host: ${resourceUri}]`
          } catch (presentError) {
            const message = presentError instanceof Error ? presentError.message : String(presentError)
            appNotice = `\n\n[MCP App UI unavailable: ${message}]`
          }
        }
        return { content: modelText(result) + appNotice, isError: result.isError === true }
      } catch (err) {
        return { content: `MCP error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  }
}

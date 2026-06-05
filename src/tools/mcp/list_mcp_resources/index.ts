import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'
import { mcpClients } from '../registry.js'

export async function createListMcpResourcesTool(): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'list_mcp_resources',
    description,
    isConcurrencySafe: true,
    inputSchema: { type: 'object', properties: {}, required: [] },
    async call(_input: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> {
      if (mcpClients.size === 0) return { content: 'No MCP servers connected. Use registerMcpClient() to add servers.', isError: false }
      const sections: string[] = []
      for (const [serverName, client] of mcpClients) {
        const lines: string[] = [`## Server: ${serverName}`]
        try {
          const tools = await client.listTools()
          if (tools.length === 0) { lines.push('  Tools: (none)') } else {
            lines.push(`  Tools (${tools.length}):`)
            for (const t of tools) {
              lines.push(`    - ${t.name}${t.description ? `: ${t.description}` : ''}`)
              if (t.inputSchema) {
                lines.push(`      inputSchema: ${JSON.stringify(t.inputSchema)}`)
              }
            }
          }
        } catch (e) { lines.push(`  Tools: Error listing — ${e instanceof Error ? e.message : String(e)}`) }
        if (client.listResources) {
          try {
            const resources = await client.listResources()
            if (resources.length > 0) {
              lines.push(`  Resources (${resources.length}):`)
              for (const r of resources.slice(0, 20)) lines.push(`    - ${r.uri}${r.name ? ` (${r.name})` : ''}`)
              if (resources.length > 20) lines.push(`    ... and ${resources.length - 20} more`)
            }
          } catch { /* skip */ }
        }
        sections.push(lines.join('\n'))
      }
      return { content: sections.join('\n\n'), isError: false }
    },
  }
}

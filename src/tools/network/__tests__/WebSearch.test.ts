import { describe, expect, it } from 'vitest'
import { DEFAULT_WEB_SEARCH_MODEL, createWebSearchTool } from '../web_search/index.js'
import { registerMcpClient, unregisterMcpClient } from '../../mcp/registry.js'

describe('web_search defaults', () => {
  it('uses an Anthropic model by default for Anthropic web-search API calls', () => {
    expect(DEFAULT_WEB_SEARCH_MODEL).toMatch(/^claude-/)
  })

  it('uses the current GLM MCP tool name and schema as fallback', async () => {
    const calls: Array<{ toolName: string; toolInput: Record<string, unknown> }> = []
    registerMcpClient('web-search-prime', {
      async listTools() { return [] },
      async callTool(toolName, toolInput) {
        calls.push({ toolName, toolInput })
        return { content: [{ type: 'text', text: 'result' }] }
      },
    })
    try {
      const tool = await createWebSearchTool({ apiKey: '' })
      const result = await tool.call({ query: 'humanoid heel toe walking' }, { abortSignal: new AbortController().signal })

      expect(result).toEqual({ content: 'result', isError: false })
      expect(calls).toEqual([{
        toolName: 'web_search_prime',
        toolInput: {
          search_query: 'humanoid heel toe walking',
          content_size: 'medium',
          location: 'us',
        },
      }])
    } finally {
      unregisterMcpClient('web-search-prime')
    }
  })
})

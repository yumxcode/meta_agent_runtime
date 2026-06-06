import Anthropic from '@anthropic-ai/sdk'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'
import { mcpClients } from '../../mcp/registry.js'

export interface WebSearchToolOptions { apiKey?: string; model?: string }

export const DEFAULT_WEB_SEARCH_MODEL = 'claude-sonnet-4-6'

/** MCP server name and tool name for the GLM web search fallback. */
const GLM_MCP_SERVER = 'web-search-prime'
const GLM_MCP_TOOL   = 'web_search_prime'

/**
 * Try the GLM webSearchPrime MCP as a fallback when no Anthropic key is available.
 * Returns null if the server is not registered.
 */
async function callGlmSearch(query: string): Promise<ToolResult | null> {
  const client = mcpClients.get(GLM_MCP_SERVER)
  if (!client) return null
  try {
    const result = await client.callTool(GLM_MCP_TOOL, {
      search_query: query,
      content_size: 'medium',
      location: 'us',
    })
    const text = result.content.filter(c => c.type === 'text' && c.text).map(c => c.text!).join('\n')
    return { content: text || 'No results found', isError: false }
  } catch (err) {
    return { content: `GLM search error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

export async function createWebSearchTool(options: WebSearchToolOptions = {}): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'web_search',
    description,
    isConcurrencySafe: true,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (min 2 chars)' },
        allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Only include these domains' },
        blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Exclude these domains' },
      },
      required: ['query'],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const query = input['query'] as string
      if (!query || query.length < 2) return { content: 'Error: query must be ≥ 2 characters', isError: true }

      const apiKey = options.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? ''

      // No Anthropic key — try GLM webSearchPrime MCP fallback first.
      if (!apiKey) {
        const glmResult = await callGlmSearch(query)
        if (glmResult) return glmResult
        return {
          content: 'Error: web_search requires either ANTHROPIC_API_KEY or the GLM web-search-prime MCP to be configured (set ZHIPU_API_KEY).',
          isError: true,
        }
      }

      // Anthropic web search path.
      try {
        const client = new Anthropic({ apiKey, baseURL: 'https://api.anthropic.com' })
        const webSearchTool = {
          type: 'web_search_20250305',
          name: 'web_search',
          ...(input['allowed_domains'] ? { allowed_domains: input['allowed_domains'] } : {}),
          ...(input['blocked_domains'] ? { blocked_domains: input['blocked_domains'] } : {}),
        }
        const response = await (client.messages as unknown as { create: (p: unknown, o: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> }).create({
          model: options.model ?? DEFAULT_WEB_SEARCH_MODEL,
          max_tokens: 1024,
          tools: [webSearchTool],
          messages: [{ role: 'user', content: `Search: ${query}. Provide a concise summary with sources.` }],
        }, { signal: ctx.abortSignal })
        const text = response.content.filter(b => b.type === 'text' && b.text).map(b => b.text!).join('\n')
        return { content: text || 'No results found', isError: false }
      } catch (err) {
        // Anthropic call failed — try GLM fallback before giving up.
        const glmResult = await callGlmSearch(query)
        if (glmResult) return glmResult
        return { content: `Search error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  }
}

import Anthropic from '@anthropic-ai/sdk'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'
import { mcpClients } from '../../mcp/registry.js'
import { loadModelConfigFile } from '../../../core/modelConfigFile.js'

export interface WebSearchToolOptions {
  /** Anthropic API key (last-resort provider). */
  apiKey?: string
  /** Model for the Anthropic web-search side-call. */
  model?: string
  /** Tavily API key — preferred provider. Falls back to TAVILY_API_KEY env. */
  tavilyApiKey?: string
}

export const DEFAULT_WEB_SEARCH_MODEL = 'claude-sonnet-4-6'

/**
 * Provider chain (cheapest / most purpose-built first):
 *   1. tavily    — direct REST call to api.tavily.com (no MCP, just fetch)
 *   2. glm       — Zhipu web-search-prime MCP (when registered)
 *   3. anthropic — claude side-call with the native web_search server tool
 *                  (a full Claude API request per search — most expensive)
 *
 * Pin a single provider (no fallback) with META_AGENT_SEARCH_PROVIDER=
 * tavily | glm | anthropic — useful for cost control and debugging.
 */
/** First argument that is a non-empty (after trim) string, else undefined. */
function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return undefined
}

const TAVILY_ENDPOINT = 'https://api.tavily.com/search'
const TAVILY_MAX_RESULTS = 8
const TAVILY_SNIPPET_CHARS = 600

/** MCP server name and tool name for the GLM web search provider. */
const GLM_MCP_SERVER = 'web-search-prime'
const GLM_MCP_TOOL   = 'web_search_prime'

// ── Provider: Tavily (direct REST — deliberately NOT an MCP server) ──────────

async function callTavilySearch(
  query: string,
  apiKey: string,
  allowedDomains: string[] | undefined,
  blockedDomains: string[] | undefined,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  try {
    const res = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: TAVILY_MAX_RESULTS,
        search_depth: 'basic',
        include_answer: true,
        ...(allowedDomains?.length ? { include_domains: allowedDomains } : {}),
        ...(blockedDomains?.length ? { exclude_domains: blockedDomains } : {}),
      }),
      ...(signal ? { signal } : {}),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { content: `Tavily search error: HTTP ${res.status} ${body.slice(0, 200)}`, isError: true }
    }
    const data = await res.json() as {
      answer?: string
      results?: Array<{ title?: string; url?: string; content?: string; score?: number }>
    }
    const lines: string[] = []
    if (data.answer?.trim()) {
      lines.push(`Answer: ${data.answer.trim()}`, '')
    }
    if (data.results?.length) {
      lines.push('Sources:')
      for (const r of data.results) {
        lines.push(`- ${r.title ?? '(untitled)'}`)
        if (r.url) lines.push(`  ${r.url}`)
        const snippet = (r.content ?? '').trim()
        if (snippet) lines.push(`  ${snippet.slice(0, TAVILY_SNIPPET_CHARS)}`)
      }
    }
    const text = lines.join('\n').trim()
    if (!text) return { content: 'Tavily returned no results', isError: true }
    return { content: text, isError: false }
  } catch (err) {
    return { content: `Tavily search error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

// ── Provider: GLM web-search-prime MCP ────────────────────────────────────────

/** Returns null when the web-search-prime MCP server is not registered. */
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

// ── Provider: Anthropic native web_search server tool ─────────────────────────

async function callAnthropicSearch(
  query: string,
  apiKey: string,
  model: string,
  input: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  try {
    const client = new Anthropic({ apiKey, baseURL: 'https://api.anthropic.com' })
    const webSearchTool = {
      type: 'web_search_20250305',
      name: 'web_search',
      ...(input['allowed_domains'] ? { allowed_domains: input['allowed_domains'] } : {}),
      ...(input['blocked_domains'] ? { blocked_domains: input['blocked_domains'] } : {}),
    }
    const response = await (client.messages as unknown as { create: (p: unknown, o: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> }).create({
      model,
      max_tokens: 1024,
      tools: [webSearchTool],
      messages: [{ role: 'user', content: `Search: ${query}. Provide a concise summary with sources.` }],
    }, { signal })
    const text = response.content.filter(b => b.type === 'text' && b.text).map(b => b.text!).join('\n')
    return { content: text || 'No results found', isError: false }
  } catch (err) {
    return { content: `Anthropic search error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

// ── Tool ──────────────────────────────────────────────────────────────────────

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

      const allowedDomains = input['allowed_domains'] as string[] | undefined
      const blockedDomains = input['blocked_domains'] as string[] | undefined
      // Resolution: explicit option → env var → ~/.meta-agent/config.json
      // ("tavilyApiKey"). The config-file path is what most users actually
      // configure; without it the chain silently fell through to GLM MCP even
      // though Tavily is the preferred provider. Empty/whitespace values are
      // treated as absent so an empty env var cannot mask the config file.
      const tavilyKey =
        firstNonEmpty(
          options.tavilyApiKey,
          process.env['TAVILY_API_KEY'],
          loadModelConfigFile().tavilyApiKey,
        ) ?? ''
      const anthropicKey = options.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? ''
      const model = options.model ?? DEFAULT_WEB_SEARCH_MODEL
      const pinned = (process.env['META_AGENT_SEARCH_PROVIDER'] ?? '').trim().toLowerCase()

      // ── Pinned provider: exactly one attempt, no fallback ─────────────────
      if (pinned === 'tavily') {
        if (!tavilyKey) return { content: 'Error: META_AGENT_SEARCH_PROVIDER=tavily but TAVILY_API_KEY is not set.', isError: true }
        return callTavilySearch(query, tavilyKey, allowedDomains, blockedDomains, ctx.abortSignal)
      }
      if (pinned === 'glm') {
        const glm = await callGlmSearch(query)
        return glm ?? { content: 'Error: META_AGENT_SEARCH_PROVIDER=glm but the web-search-prime MCP is not registered (set ZHIPU_API_KEY / mcp.json).', isError: true }
      }
      if (pinned === 'anthropic') {
        if (!anthropicKey) return { content: 'Error: META_AGENT_SEARCH_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set.', isError: true }
        return callAnthropicSearch(query, anthropicKey, model, input, ctx.abortSignal)
      }

      // ── Default chain: Tavily → GLM MCP → Anthropic ───────────────────────
      const failures: string[] = []

      if (tavilyKey) {
        const tavily = await callTavilySearch(query, tavilyKey, allowedDomains, blockedDomains, ctx.abortSignal)
        if (!tavily.isError) return tavily
        failures.push(tavily.content)
      }

      const glm = await callGlmSearch(query)
      if (glm && !glm.isError) return glm
      if (glm) failures.push(glm.content)

      if (anthropicKey) {
        const anthropic = await callAnthropicSearch(query, anthropicKey, model, input, ctx.abortSignal)
        if (!anthropic.isError) return anthropic
        failures.push(anthropic.content)
      }

      if (failures.length > 0) {
        return { content: `web_search failed across all providers:\n- ${failures.join('\n- ')}`, isError: true }
      }
      return {
        content:
          'Error: no web search provider configured. Set TAVILY_API_KEY (recommended), ' +
          'or ZHIPU_API_KEY (GLM web-search-prime MCP), or ANTHROPIC_API_KEY.',
        isError: true,
      }
    },
  }
}

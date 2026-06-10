import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WEB_SEARCH_MODEL, createWebSearchTool } from '../web_search/index.js'
import { registerMcpClient, unregisterMcpClient } from '../../mcp/registry.js'

const ctx = () => ({ abortSignal: new AbortController().signal })

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  unregisterMcpClient('web-search-prime')
})

function stubTavilyFetch(response: {
  ok?: boolean
  status?: number
  json?: unknown
}): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.json ?? {},
    text: async () => JSON.stringify(response.json ?? {}),
  }))
  vi.stubGlobal('fetch', mock)
  return mock
}

function registerGlmMock(calls: Array<{ toolName: string; toolInput: Record<string, unknown> }>): void {
  registerMcpClient('web-search-prime', {
    async listTools() { return [] },
    async callTool(toolName, toolInput) {
      calls.push({ toolName, toolInput })
      return { content: [{ type: 'text', text: 'glm result' }] }
    },
  })
}

describe('web_search defaults', () => {
  it('uses an Anthropic model by default for Anthropic web-search API calls', () => {
    expect(DEFAULT_WEB_SEARCH_MODEL).toMatch(/^claude-/)
  })
})

describe('web_search provider chain: Tavily → GLM → Anthropic', () => {
  it('prefers Tavily (direct REST, no MCP) when TAVILY_API_KEY is available', async () => {
    const fetchMock = stubTavilyFetch({
      json: {
        answer: 'Heel-toe walking improves stability.',
        results: [
          { title: 'Paper A', url: 'https://arxiv.org/abs/1', content: 'CPG-based heel-toe gait...' },
        ],
      },
    })
    const glmCalls: Array<{ toolName: string; toolInput: Record<string, unknown> }> = []
    registerGlmMock(glmCalls)

    const tool = await createWebSearchTool({ apiKey: '', tavilyApiKey: 'tvly-test' })
    const result = await tool.call(
      { query: 'humanoid heel toe walking', allowed_domains: ['arxiv.org'], blocked_domains: ['spam.com'] },
      ctx(),
    )

    expect(result.isError).toBe(false)
    expect(result.content).toContain('Heel-toe walking improves stability.')
    expect(result.content).toContain('https://arxiv.org/abs/1')
    // GLM must NOT have been touched
    expect(glmCalls).toEqual([])

    // Direct REST call with Bearer auth + domain filters mapped
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }]
    expect(url).toBe('https://api.tavily.com/search')
    expect(init.headers['authorization']).toBe('Bearer tvly-test')
    const body = JSON.parse(init.body) as Record<string, unknown>
    expect(body['query']).toBe('humanoid heel toe walking')
    expect(body['include_domains']).toEqual(['arxiv.org'])
    expect(body['exclude_domains']).toEqual(['spam.com'])
  })

  it('falls back to GLM MCP when Tavily fails', async () => {
    stubTavilyFetch({ ok: false, status: 500 })
    const glmCalls: Array<{ toolName: string; toolInput: Record<string, unknown> }> = []
    registerGlmMock(glmCalls)

    const tool = await createWebSearchTool({ apiKey: '', tavilyApiKey: 'tvly-test' })
    const result = await tool.call({ query: 'quadruped slam' }, ctx())

    expect(result).toEqual({ content: 'glm result', isError: false })
    expect(glmCalls).toEqual([{
      toolName: 'web_search_prime',
      toolInput: { search_query: 'quadruped slam', content_size: 'medium', location: 'us' },
    }])
  })

  it('uses GLM directly when no Tavily key is configured (legacy behaviour)', async () => {
    vi.stubEnv('TAVILY_API_KEY', '')
    const glmCalls: Array<{ toolName: string; toolInput: Record<string, unknown> }> = []
    registerGlmMock(glmCalls)

    const tool = await createWebSearchTool({ apiKey: '' })
    const result = await tool.call({ query: 'humanoid heel toe walking' }, ctx())

    expect(result).toEqual({ content: 'glm result', isError: false })
    expect(glmCalls).toHaveLength(1)
  })

  it('errors with configuration guidance when no provider is available', async () => {
    vi.stubEnv('TAVILY_API_KEY', '')
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    const tool = await createWebSearchTool({})
    const result = await tool.call({ query: 'anything at all' }, ctx())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('TAVILY_API_KEY')
  })

  it('META_AGENT_SEARCH_PROVIDER=glm pins GLM and never calls Tavily', async () => {
    vi.stubEnv('META_AGENT_SEARCH_PROVIDER', 'glm')
    const fetchMock = stubTavilyFetch({ json: { answer: 'should not be used' } })
    const glmCalls: Array<{ toolName: string; toolInput: Record<string, unknown> }> = []
    registerGlmMock(glmCalls)

    const tool = await createWebSearchTool({ tavilyApiKey: 'tvly-test' })
    const result = await tool.call({ query: 'pinned provider' }, ctx())

    expect(result).toEqual({ content: 'glm result', isError: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('META_AGENT_SEARCH_PROVIDER=tavily without a key returns a clear error', async () => {
    vi.stubEnv('META_AGENT_SEARCH_PROVIDER', 'tavily')
    vi.stubEnv('TAVILY_API_KEY', '')
    const tool = await createWebSearchTool({})
    const result = await tool.call({ query: 'pinned but unconfigured' }, ctx())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('TAVILY_API_KEY')
  })
})

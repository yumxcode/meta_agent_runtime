/**
 * web_search provider chain — availability and diagnosability in auto mode.
 *
 * The GLM MCP provider used to be barred from autonomous runs because
 * `McpClient.callTool` takes no AbortSignal and a hung server could wedge an
 * unattended session. For a GLM-only install that left auto mode with NO search
 * provider at all, and the failure surfaced as "no web search provider
 * configured" — pointing at a missing API key that was never the problem.
 *
 * The wait is now bounded instead, so these pin the two properties that matter:
 * auto mode can search, and a failure names what happened to every provider.
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import { createWebSearchTool } from '../web_search/index.js'
import { mcpClients } from '../../mcp/registry.js'
import type { ToolCallContext } from '../../../core/types.js'

const GLM_SERVER = 'web-search-prime'

afterEach(() => {
  mcpClients.delete(GLM_SERVER)
  vi.unstubAllEnvs()
})

function registerGlm(impl: () => Promise<{ content: Array<{ type: string; text?: string }> }>): void {
  mcpClients.set(GLM_SERVER, {
    callTool: impl,
    listTools: async () => [{ name: 'web_search_prime' }],
  } as never)
}

/** An auto-mode call context with no provider keys in the environment. */
function autoCtx(signal?: AbortSignal): ToolCallContext {
  return { autonomousMode: true, ...(signal ? { abortSignal: signal } : {}) } as ToolCallContext
}

function clearKeys(): void {
  vi.stubEnv('TAVILY_API_KEY', '')
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  vi.stubEnv('META_AGENT_SEARCH_PROVIDER', '')
}

describe('auto mode can use the GLM MCP provider', () => {
  it('returns GLM results instead of refusing because the run is unattended', async () => {
    clearKeys()
    registerGlm(async () => ({ content: [{ type: 'text', text: 'the answer' }] }))
    const tool = await createWebSearchTool()

    const result = await tool.call({ query: 'x1 amp retargeting' }, autoCtx())
    expect(result.isError).toBe(false)
    expect(result.content).toContain('the answer')
  })

  it('is bounded, so an unresponsive server cannot wedge an unattended run', async () => {
    clearKeys()
    // Never settles — the old failure mode this provider was banned for.
    registerGlm(() => new Promise(() => undefined))
    const tool = await createWebSearchTool()
    const controller = new AbortController()

    const pending = tool.call({ query: 'x1 amp' }, autoCtx(controller.signal))
    controller.abort()
    const result = await pending

    // The wait ends; it does not hang. The abort is reported, not swallowed.
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/aborted/i)
  })
})

describe('a failure names what happened to every provider', () => {
  it('reports each skipped provider and its reason, not just "not configured"', async () => {
    clearKeys()
    const tool = await createWebSearchTool()

    const result = await tool.call({ query: 'anything' }, autoCtx())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('tavily: TAVILY_API_KEY not set')
    expect(result.content).toContain(`glm: MCP server "${GLM_SERVER}" is not registered`)
    expect(result.content).toContain('anthropic: ANTHROPIC_API_KEY not set')
  })

  it('distinguishes a provider that failed from one that was never tried', async () => {
    clearKeys()
    registerGlm(async () => { throw new Error('upstream 502') })
    const tool = await createWebSearchTool()

    const result = await tool.call({ query: 'anything' }, autoCtx())
    expect(result.content).toMatch(/failed → .*502/)
    expect(result.content).toMatch(/skipped → tavily/)
  })
})

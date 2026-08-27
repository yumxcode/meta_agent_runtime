/**
 * The network category ships BOTH tools.
 *
 * web_search used to be withheld from createNetworkTools and registered only by
 * RoboticsSession, so agentic/auto/graph/CLI sessions got web_fetch alone —
 * while GraphCatalog advertised `web_search` as a capability and the
 * PaperSearchAgent prompt told the model to use it. A prompt that names an
 * absent tool teaches the model to guess URLs instead.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { createNetworkTools } from '../index.js'
import { SEARCH_PROVIDER_ORDER } from '../web_search/index.js'
import { createStandardTools } from '../../index.js'

afterEach(() => { vi.unstubAllEnvs() })

describe('createNetworkTools', () => {
  it('registers web_fetch and web_search', async () => {
    const names = (await createNetworkTools()).map(t => t.name).sort()
    expect(names).toEqual(['web_fetch', 'web_search'])
  })

  it('applies the web_fetch result budget without touching web_search', async () => {
    const tools = await createNetworkTools({ webFetch: { maxResultSizeChars: 8_000 } })
    const fetchTool = tools.find(t => t.name === 'web_fetch')!
    const searchTool = tools.find(t => t.name === 'web_search')!
    expect(fetchTool.maxResultSizeChars).toBe(8_000)
    expect(searchTool.maxResultSizeChars).toBeUndefined()
  })

  it('reaches the standard toolset, which is what non-robotics sessions build from', async () => {
    const names = (await createStandardTools({ include: ['network'] })).map(t => t.name)
    expect(names).toContain('web_fetch')
    expect(names).toContain('web_search')
  })
})

describe('the provider order is stated once', () => {
  it('is exactly Tavily → GLM → Anthropic', () => {
    expect(SEARCH_PROVIDER_ORDER).toEqual(['tavily', 'glm', 'anthropic'])
  })
})

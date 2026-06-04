import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { usesBearerAuth, buildAnthropicAuth } from '../AnthropicClient.js'

/**
 * Auth selection for the Anthropic SDK client.
 *
 * Native Anthropic uses x-api-key (apiKey); Zhipu GLM compat endpoints use
 * Authorization: Bearer (authToken). buildAnthropicAuth() must set exactly one,
 * passing apiKey: null to suppress x-api-key on Bearer endpoints.
 */
describe('usesBearerAuth', () => {
  it('is true for bigmodel.cn and z.ai endpoints', () => {
    expect(usesBearerAuth('https://open.bigmodel.cn/api/anthropic')).toBe(true)
    expect(usesBearerAuth('https://api.z.ai/api/anthropic')).toBe(true)
  })
  it('is false for native Anthropic or missing baseURL', () => {
    expect(usesBearerAuth('https://api.anthropic.com')).toBe(false)
    expect(usesBearerAuth(undefined)).toBe(false)
    expect(usesBearerAuth('')).toBe(false)
  })
})

describe('buildAnthropicAuth', () => {
  let savedZhipu: string | undefined
  let savedAnthropic: string | undefined

  beforeEach(() => {
    savedZhipu = process.env['ZHIPU_API_KEY']
    savedAnthropic = process.env['ANTHROPIC_API_KEY']
    delete process.env['ZHIPU_API_KEY']
    delete process.env['ANTHROPIC_API_KEY']
  })
  afterEach(() => {
    if (savedZhipu === undefined) delete process.env['ZHIPU_API_KEY']
    else process.env['ZHIPU_API_KEY'] = savedZhipu
    if (savedAnthropic === undefined) delete process.env['ANTHROPIC_API_KEY']
    else process.env['ANTHROPIC_API_KEY'] = savedAnthropic
  })

  it('uses Bearer (authToken, apiKey null) on Zhipu endpoints', () => {
    const a = buildAnthropicAuth('zhipu-key', 'https://open.bigmodel.cn/api/anthropic')
    expect(a.apiKey).toBeNull()
    expect(a.authToken).toBe('zhipu-key')
  })

  it('falls back to ZHIPU_API_KEY env when no key passed on Bearer endpoint', () => {
    process.env['ZHIPU_API_KEY'] = 'env-zhipu'
    const a = buildAnthropicAuth(undefined, 'https://api.z.ai/api/anthropic')
    expect(a.apiKey).toBeNull()
    expect(a.authToken).toBe('env-zhipu')
  })

  it('uses x-api-key (apiKey, no authToken) on native Anthropic', () => {
    const a = buildAnthropicAuth('sk-ant', 'https://api.anthropic.com')
    expect(a.apiKey).toBe('sk-ant')
    expect(a.authToken).toBeUndefined()
  })

  it('falls back to ANTHROPIC_API_KEY env when no key passed on native endpoint', () => {
    process.env['ANTHROPIC_API_KEY'] = 'env-ant'
    const a = buildAnthropicAuth(undefined, undefined)
    expect(a.apiKey).toBe('env-ant')
    expect(a.authToken).toBeUndefined()
  })

  it('returns apiKey null when no key available on native endpoint', () => {
    const a = buildAnthropicAuth(undefined, 'https://api.anthropic.com')
    expect(a.apiKey).toBeNull()
    expect(a.authToken).toBeUndefined()
  })
})

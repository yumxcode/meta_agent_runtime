import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { detectProvider, isAnthropicProvider } from '../config.js'

/**
 * Provider auto-detection — focus on the Zhipu GLM coding plan addition.
 *
 * detectProvider() reads process.env directly, so each test snapshots and
 * restores the four provider keys to stay hermetic.
 */
const PROVIDER_KEYS = [
  'ZHIPU_API_KEY', 'ZAI_API_KEY', 'GLM_API_KEY',
  'DEEPSEEK_API_KEY', 'QWEN_API_KEY', 'ANTHROPIC_API_KEY',
] as const

describe('detectProvider — Zhipu GLM', () => {
  let saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved = {}
    for (const k of PROVIDER_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of PROVIDER_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('selects glm-5.1 on the bigmodel Anthropic endpoint when ZHIPU_API_KEY is set', () => {
    process.env['ZHIPU_API_KEY'] = 'zhipu-test-key'
    const d = detectProvider({})
    expect(d.provider).toBe('zhipu')
    expect(d.apiKey).toBe('zhipu-test-key')
    expect(d.baseURL).toBe('https://open.bigmodel.cn/api/anthropic')
    expect(d.defaultModel).toBe('glm-5.1')
    expect(d.fallbackModel).toBe('glm-4.6')
    expect(d.flashModel).toBe('glm-4.5-air')
  })

  it('accepts ZAI_API_KEY and GLM_API_KEY as aliases', () => {
    process.env['ZAI_API_KEY'] = 'zai-key'
    expect(detectProvider({}).provider).toBe('zhipu')
    delete process.env['ZAI_API_KEY']
    process.env['GLM_API_KEY'] = 'glm-key'
    expect(detectProvider({}).provider).toBe('zhipu')
  })

  it('prioritises ZHIPU over DEEPSEEK / QWEN / ANTHROPIC when several keys are set', () => {
    process.env['ZHIPU_API_KEY']    = 'zhipu-key'
    process.env['DEEPSEEK_API_KEY'] = 'ds-key'
    process.env['QWEN_API_KEY']     = 'qwen-key'
    process.env['ANTHROPIC_API_KEY'] = 'anthropic-key'
    const d = detectProvider({})
    expect(d.provider).toBe('zhipu')
    expect(d.defaultModel).toBe('glm-5.1')
  })

  it('infers zhipu from an explicit bigmodel / z.ai baseURL', () => {
    const a = detectProvider({ apiKey: 'k', baseURL: 'https://open.bigmodel.cn/api/anthropic' })
    expect(a.provider).toBe('zhipu')
    const b = detectProvider({ apiKey: 'k', baseURL: 'https://api.z.ai/api/anthropic' })
    expect(b.provider).toBe('zhipu')
  })

  it('does not treat the Zhipu endpoint as the native Anthropic provider', () => {
    // Gates Anthropic-only betas: must be false so they are not sent to GLM.
    expect(isAnthropicProvider('https://open.bigmodel.cn/api/anthropic')).toBe(false)
    expect(isAnthropicProvider('https://api.z.ai/api/anthropic')).toBe(false)
    expect(isAnthropicProvider('https://api.anthropic.com')).toBe(true)
  })
})

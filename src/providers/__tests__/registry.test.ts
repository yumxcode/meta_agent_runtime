import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getModelProtocol,
  getModelPricing,
  getModelContextWindow,
  getModelCapabilities,
  inferProviderFromURL,
  inferProviderFromModel,
  resolveProvider,
  DEFAULT_PRICING,
  DEFAULT_CONTEXT_WINDOW,
} from '../registry.js'

const PROVIDER_KEYS = ['ZHIPU_API_KEY', 'ZAI_API_KEY', 'GLM_API_KEY', 'DEEPSEEK_API_KEY', 'QWEN_API_KEY', 'ANTHROPIC_API_KEY'] as const

describe('provider registry', () => {
  let saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    saved = {}
    for (const k of PROVIDER_KEYS) { saved[k] = process.env[k]; delete process.env[k] }
  })
  afterEach(() => {
    for (const k of PROVIDER_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  describe('getModelProtocol', () => {
    it('routes deepseek models to openai protocol', () => {
      expect(getModelProtocol('deepseek-v4-flash')).toBe('openai')
      expect(getModelProtocol('deepseek-chat')).toBe('openai')
    })
    it('routes glm / claude / qwen to anthropic protocol', () => {
      expect(getModelProtocol('glm-5.1')).toBe('anthropic')
      expect(getModelProtocol('claude-opus-4-6')).toBe('anthropic')
      expect(getModelProtocol('qwen-plus')).toBe('anthropic')
    })
    it('lets baseURL override an ambiguous model name', () => {
      // Unusual model name but a deepseek.com endpoint → openai.
      expect(getModelProtocol('my-custom-model', 'https://api.deepseek.com/v1')).toBe('openai')
      // glm endpoint forces anthropic even with an unknown model name.
      expect(getModelProtocol('mystery', 'https://open.bigmodel.cn/api/anthropic')).toBe('anthropic')
    })
    it('defaults to anthropic for unknown model + no url', () => {
      expect(getModelProtocol('totally-unknown')).toBe('anthropic')
    })
  })

  describe('inference helpers', () => {
    it('infers provider from url', () => {
      expect(inferProviderFromURL('https://api.deepseek.com')).toBe('deepseek')
      expect(inferProviderFromURL('https://open.bigmodel.cn/api/anthropic')).toBe('zhipu')
      expect(inferProviderFromURL('https://api.z.ai/api/anthropic')).toBe('zhipu')
      expect(inferProviderFromURL('https://dashscope.aliyuncs.com/apps/anthropic')).toBe('qwen')
      expect(inferProviderFromURL('https://api.anthropic.com')).toBe('anthropic')
      expect(inferProviderFromURL('https://example.com')).toBe('unknown')
      expect(inferProviderFromURL(undefined)).toBe('unknown')
    })
    it('infers provider from model name', () => {
      expect(inferProviderFromModel('glm-4.6')).toBe('zhipu')
      expect(inferProviderFromModel('deepseek-r1')).toBe('deepseek')
      expect(inferProviderFromModel('claude-haiku-4-5')).toBe('anthropic')
      expect(inferProviderFromModel('qwen-max')).toBe('qwen')
      expect(inferProviderFromModel('gpt-4')).toBe('unknown')
    })
  })

  describe('resolveProvider precedence', () => {
    it('explicit baseURL drives detection (apiKey passed through)', () => {
      const r = resolveProvider({ apiKey: 'k', baseURL: 'https://open.bigmodel.cn/api/anthropic' })
      expect(r.provider).toBe('zhipu')
      expect(r.protocol).toBe('anthropic')
      expect(r.auth).toBe('bearer')
      expect(r.apiKey).toBe('k')
    })

    it('FIX #1: bare apiKey + provider model name routes to that provider, not Anthropic', () => {
      const r = resolveProvider({ apiKey: 'ds-key', model: 'deepseek-v4-flash' })
      expect(r.provider).toBe('deepseek')
      expect(r.protocol).toBe('openai')
      expect(r.baseURL).toBe('https://api.deepseek.com')
      expect(r.apiKey).toBe('ds-key')
    })

    it('bare apiKey with claude model stays anthropic', () => {
      const r = resolveProvider({ apiKey: 'sk-ant', model: 'claude-opus-4-6' })
      expect(r.provider).toBe('anthropic')
      expect(r.baseURL).toBe('https://api.anthropic.com')
    })

    it('env detection order: zhipu before anthropic', () => {
      process.env['ZHIPU_API_KEY'] = 'zk'
      process.env['ANTHROPIC_API_KEY'] = 'ak'
      const r = resolveProvider({})
      expect(r.provider).toBe('zhipu')
      expect(r.apiKey).toBe('zk')
      expect(r.defaultModel).toBe('glm-5.1')
    })

    it('falls back to anthropic default with empty key when nothing set', () => {
      const r = resolveProvider({})
      expect(r.provider).toBe('anthropic')
      expect(r.apiKey).toBe('')
    })
  })

  describe('pricing / context lookups', () => {
    it('longest-prefix match: glm-4.5-air is the cheap tier, not glm-4.5', () => {
      expect(getModelPricing('glm-4.5-air').input).toBe(0.11)
      expect(getModelPricing('glm-4.5').input).toBe(0.43)
      expect(getModelContextWindow('glm-4.5-air')).toBe(128_000)
      expect(getModelContextWindow('glm-5.1')).toBe(200_000)
    })
    it('deepseek 1M context, known pricing', () => {
      expect(getModelContextWindow('deepseek-v4-flash')).toBe(1_000_000)
      expect(getModelPricing('deepseek-v4-pro').output).toBeCloseTo(3.3333, 3)
    })
    it('qwen now has pricing + context (was Sonnet fallback before)', () => {
      expect(getModelPricing('qwen-plus').input).toBe(0.26)
      expect(getModelContextWindow('qwen-max')).toBe(262_144)
    })
    it('unknown model falls back to defaults', () => {
      expect(getModelPricing('mystery-model')).toEqual(DEFAULT_PRICING)
      expect(getModelContextWindow('mystery-model')).toBe(DEFAULT_CONTEXT_WINDOW)
    })
  })

  describe('capabilities', () => {
    it('anthropic supports betas + thinking', () => {
      const c = getModelCapabilities('claude-opus-4-6')
      expect(c.anthropicBetas).toBe(true)
      expect(c.anthropicThinkingParam).toBe(true)
    })
    it('zhipu: no betas, thinking allowed', () => {
      const c = getModelCapabilities('glm-5.1')
      expect(c.anthropicBetas).toBe(false)
      expect(c.anthropicThinkingParam).toBe(true)
    })
    it('deepseek: reasoning_effort, no anthropic thinking param', () => {
      const c = getModelCapabilities('deepseek-v4-flash')
      expect(c.reasoningEffort).toBe(true)
      expect(c.anthropicThinkingParam).toBe(false)
      expect(c.anthropicBetas).toBe(false)
    })
    it('qwen: thinking gated off', () => {
      const c = getModelCapabilities('qwen-plus')
      expect(c.anthropicThinkingParam).toBe(false)
      expect(c.anthropicBetas).toBe(false)
    })
  })
})

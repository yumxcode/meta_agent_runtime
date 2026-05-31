import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../config.js'
import { AgenticSession } from '../../modes/AgenticSession.js'
import { CampaignSession } from '../../modes/CampaignSession.js'
import { buildThinkingParam, isThinkingEnabled } from '../../kernel/utils/ThinkingConfig.js'
import type { ThinkingConfig } from '../../kernel/index.js'

describe('thinkingConfig — primary LLM defaults', () => {
  it('resolveConfig defaults to adaptive when caller did not specify', () => {
    const resolved = resolveConfig({ apiKey: 'test' })
    expect(resolved.thinkingConfig).toEqual({ type: 'adaptive' })
  })

  it('resolveConfig preserves an explicit disabled override', () => {
    const resolved = resolveConfig({
      apiKey: 'test',
      thinkingConfig: { type: 'disabled' },
    })
    expect(resolved.thinkingConfig).toEqual({ type: 'disabled' })
  })

  it('resolveConfig preserves an explicit enabled budget', () => {
    const resolved = resolveConfig({
      apiKey: 'test',
      thinkingConfig: { type: 'enabled', budgetTokens: 24_000 },
    })
    expect(resolved.thinkingConfig).toEqual({ type: 'enabled', budgetTokens: 24_000 })
  })
})

describe('buildThinkingParam — provider-side translation', () => {
  it('adaptive → enabled with default 16k budget', () => {
    const out = buildThinkingParam({ type: 'adaptive' })
    expect(out).toEqual({ type: 'enabled', budget_tokens: 16_000 })
  })

  it('disabled → undefined (no thinking param sent)', () => {
    expect(buildThinkingParam({ type: 'disabled' })).toBeUndefined()
  })

  it('enabled forwards the caller budget verbatim', () => {
    expect(buildThinkingParam({ type: 'enabled', budgetTokens: 64_000 }))
      .toEqual({ type: 'enabled', budget_tokens: 64_000 })
  })

  it('isThinkingEnabled is true for adaptive and enabled, false for disabled', () => {
    expect(isThinkingEnabled({ type: 'adaptive' })).toBe(true)
    expect(isThinkingEnabled({ type: 'enabled', budgetTokens: 8_000 })).toBe(true)
    expect(isThinkingEnabled({ type: 'disabled' })).toBe(false)
    expect(isThinkingEnabled(undefined)).toBe(false)
  })
})

describe('Sessions propagate thinkingConfig into the kernel', () => {
  function getKernelThinking(s: { _engine: unknown }): ThinkingConfig | undefined {
    return ((s._engine as { _config: { thinkingConfig?: ThinkingConfig } })._config.thinkingConfig)
  }

  it('AgenticSession defaults to adaptive', () => {
    const session = new AgenticSession({ apiKey: 'test', tools: [] })
    expect(getKernelThinking(session as unknown as { _engine: unknown }))
      .toEqual({ type: 'adaptive' })
  })

  it('AgenticSession honours an explicit disabled override', () => {
    const session = new AgenticSession({
      apiKey: 'test',
      tools: [],
      thinkingConfig: { type: 'disabled' },
    })
    expect(getKernelThinking(session as unknown as { _engine: unknown }))
      .toEqual({ type: 'disabled' })
  })

  it('CampaignSession defaults to adaptive', () => {
    const session = new CampaignSession({ apiKey: 'test', tools: [] })
    expect(getKernelThinking(session as unknown as { _engine: unknown }))
      .toEqual({ type: 'adaptive' })
  })

  it('CampaignSession honours an explicit enabled budget', () => {
    const session = new CampaignSession({
      apiKey: 'test',
      tools: [],
      thinkingConfig: { type: 'enabled', budgetTokens: 40_000 },
    })
    expect(getKernelThinking(session as unknown as { _engine: unknown }))
      .toEqual({ type: 'enabled', budgetTokens: 40_000 })
  })

  it('RoboticsSession defaults to adaptive and honours an explicit override', async () => {
    // Lazy-import so RoboticsSession's transitive deps don't load on every run
    const { RoboticsSession } = await import('../../robotics/RoboticsSession.js')

    const defaulted = new RoboticsSession({ apiKey: 'test', tools: [] })
    // RoboticsSession exposes `inner` (AgenticSession); reach through to the kernel.
    const innerDefault = (defaulted as unknown as { inner: { _engine: unknown } }).inner
    expect(getKernelThinking(innerDefault as unknown as { _engine: unknown }))
      .toEqual({ type: 'adaptive' })

    const disabled = new RoboticsSession({
      apiKey: 'test',
      tools: [],
      thinkingConfig: { type: 'disabled' },
    })
    const innerDisabled = (disabled as unknown as { inner: { _engine: unknown } }).inner
    expect(getKernelThinking(innerDisabled as unknown as { _engine: unknown }))
      .toEqual({ type: 'disabled' })
  })
})

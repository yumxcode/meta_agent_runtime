import { describe, it, expect } from 'vitest'
import type { SessionMode } from '../../core/modes.js'
import { SessionRouter } from '../SessionRouter.js'
import { MODE_WEIGHT } from '../types.js'

describe('SessionRouter — explicit mode selection', () => {
  it('defaults to agentic instead of detecting robotics/campaign from prompt text', async () => {
    const router = new SessionRouter()

    await expect(router.primeMode('帮我开发四足机器人的自主导航算法 ROS2')).resolves.toBe('agentic')
    await expect(router.primeMode('做参数扫描，找 Pareto 前沿')).resolves.toBe('agentic')
  })

  it.each<SessionMode>(['agentic', 'auto', 'simple_auto', 'campaign', 'robotics'])(
    'uses explicit %s mode',
    async mode => {
      const router = new SessionRouter({ mode })

      await expect(router.primeMode('prompt text should not change the selected mode')).resolves.toBe(mode)
    },
  )

  it('applies a finite default whole-session budget to autonomous modes', () => {
    const router = new SessionRouter({ mode: 'auto' })
    const config = router as unknown as { _cfg: { maxBudgetUsd: number } }
    expect(config._cfg.maxBudgetUsd).toBe(20)
  })
})

describe('MODE_WEIGHT', () => {
  it('auto has equal weight to agentic (sibling flavour, not heavier)', () => {
    expect(MODE_WEIGHT.auto).toBe(MODE_WEIGHT.agentic)
  })

  it('campaign and robotics still outrank auto/agentic', () => {
    expect(MODE_WEIGHT.campaign).toBeGreaterThan(MODE_WEIGHT.auto)
    expect(MODE_WEIGHT.robotics).toBeGreaterThan(MODE_WEIGHT.campaign)
  })
})

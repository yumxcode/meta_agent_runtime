import { describe, expect, it } from 'vitest'
import { AutoCostLedger } from '../AutoCostLedger.js'
import { resolveConfig } from '../../config.js'

describe('AutoCostLedger', () => {
  it('shares one cap between main spend and child reservations', () => {
    const ledger = new AutoCostLedger(10)
    ledger.recordMainCost(3)

    expect(ledger.tryReserveTask('worker-a', 5)).toBe(true)
    expect(ledger.tryReserveTask('judge-a', 3)).toBe(false)

    ledger.settleTask('worker-a', 0.5)
    expect(ledger.tryReserveTask('judge-a', 3)).toBe(true)

    const stats = ledger.getBreakdown()
    expect(stats.mainCostUsd).toBe(3)
    expect(stats.subAgentCostUsd).toBe(0.5)
    expect(stats.reservedSubAgentBudgetUsd).toBe(3)
    expect(stats.committedCostUsd).toBe(6.5)
    expect(stats.remainingBudgetUsd).toBe(3.5)
  })

  it('settles a task once and releases its reservation', () => {
    const ledger = new AutoCostLedger(2)
    expect(ledger.tryReserveTask('judge', 1)).toBe(true)
    ledger.settleTask('judge', 0.2)
    ledger.settleTask('judge', 0.8)

    expect(ledger.getBreakdown()).toMatchObject({
      subAgentCostUsd: 0.2,
      reservedSubAgentBudgetUsd: 0,
      totalCostUsd: 0.2,
    })
  })

  it('gives direct autonomous-session construction the same finite default', () => {
    expect(resolveConfig({ apiKey: 'test', promptMode: 'auto' }).maxBudgetUsd).toBe(20)
    expect(resolveConfig({ apiKey: 'test', promptMode: 'auto', maxBudgetUsd: 7 }).maxBudgetUsd).toBe(7)
  })
})

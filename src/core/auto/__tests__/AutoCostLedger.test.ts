import { describe, expect, it } from 'vitest'
import { AutoCostLedger } from '../AutoCostLedger.js'
import { resolveConfig } from '../../config.js'
import { DEFAULT_AUTO_SESSION_BUDGET_USD } from '../../../infra/budgets.js'

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

  it('seeds committed spend when a durable Auto segment resumes', () => {
    const ledger = new AutoCostLedger(10, 7.5)
    expect(ledger.getBreakdown()).toMatchObject({
      mainCostUsd: 7.5,
      committedCostUsd: 7.5,
      remainingBudgetUsd: 2.5,
    })
    expect(ledger.tryReserveTask('too-large', 3)).toBe(false)
  })

  it('gives direct autonomous-session construction the same finite default', () => {
    // Against the ladder, not a literal — see infra/budgets.ts. What matters is
    // that auto gets a FINITE default at all (an unbounded unattended run is
    // the failure this guards) and that an explicit value still wins.
    expect(resolveConfig({ apiKey: 'test', promptMode: 'auto' }).maxBudgetUsd)
      .toBe(DEFAULT_AUTO_SESSION_BUDGET_USD)
    expect(Number.isFinite(resolveConfig({ apiKey: 'test', promptMode: 'auto' }).maxBudgetUsd)).toBe(true)
    expect(resolveConfig({ apiKey: 'test', promptMode: 'auto', maxBudgetUsd: 7 }).maxBudgetUsd).toBe(7)
  })
})

/**
 * The budget ladder is an ARITHMETIC contract, not a list of preferences.
 *
 * `AutoCostLedger.tryReserveTask()` reserves a child's declared cap against the
 * session ledger before the child starts:
 *
 *     committedCost + childCap <= sessionBudget
 *
 * so the ratios decide how many children can ever run. Setting every tier to
 * the same number — the obvious reading of "raise all budgets to $50" — makes
 * the first reservation fail for the rest of the run, because the main loop has
 * already committed something. The run does not get more budget; it loses
 * sub-agents entirely.
 *
 * These tests state that contract so the next person to move the numbers finds
 * out here rather than in an unattended run.
 */

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_AUTO_SESSION_BUDGET_USD,
  DEFAULT_SUB_AGENT_POOL_BUDGET_USD,
  DEFAULT_SUB_AGENT_BUDGET_USD,
  DEFAULT_RESEARCH_BUDGET_USD,
  DEFAULT_GRAPH_SEGMENT_BUDGET_USD,
  DEFAULT_DISTILL_STAGE_BUDGET_USD,
  DEFAULT_VERIFY_BUDGET_USD,
  DEFAULT_DRIFT_BUDGET_USD,
  DEFAULT_REVIEW_BUDGET_USD,
  AUTO_CONCURRENT_SUB_AGENTS,
  DEFAULT_SUB_AGENT_MAX_TURNS,
  DEFAULT_JUDGE_MAX_TURNS,
  DEFAULT_RESEARCH_MAX_TURNS,
  OBSERVED_USD_PER_TURN,
} from '../budgets.js'
import { AutoCostLedger } from '../../core/auto/AutoCostLedger.js'

const PER_CHILD_TIERS = {
  DEFAULT_SUB_AGENT_BUDGET_USD,
  DEFAULT_RESEARCH_BUDGET_USD,
  DEFAULT_GRAPH_SEGMENT_BUDGET_USD,
  DEFAULT_DISTILL_STAGE_BUDGET_USD,
  DEFAULT_VERIFY_BUDGET_USD,
  DEFAULT_DRIFT_BUDGET_USD,
  DEFAULT_REVIEW_BUDGET_USD,
}

describe('budget ladder', () => {
  it('gives every tier at least $50', () => {
    // The floor the operator asked for (2026-08-28): under a token plan these
    // ceilings are runaway guards, not cost controls, and sub-$50 tiers were
    // halting real work mid-investigation.
    for (const [name, value] of Object.entries(PER_CHILD_TIERS)) {
      expect(value, `${name} is below the $50 floor`).toBeGreaterThanOrEqual(50)
    }
    expect(DEFAULT_SUB_AGENT_POOL_BUDGET_USD).toBeGreaterThanOrEqual(50)
    expect(DEFAULT_AUTO_SESSION_BUDGET_USD).toBeGreaterThanOrEqual(50)
  })

  it('orders session > pool > single child', () => {
    expect(DEFAULT_AUTO_SESSION_BUDGET_USD).toBeGreaterThan(DEFAULT_SUB_AGENT_POOL_BUDGET_USD)
    expect(DEFAULT_SUB_AGENT_POOL_BUDGET_USD).toBeGreaterThan(DEFAULT_SUB_AGENT_BUDGET_USD)
  })

  it('leaves room for the full concurrent fan-out plus main-loop spend', () => {
    // The reservation arithmetic, stated directly: N children at the default
    // cap must fit inside the session budget with headroom left over for the
    // main loop, which is spending the whole time they run.
    const fanOut = AUTO_CONCURRENT_SUB_AGENTS * DEFAULT_SUB_AGENT_BUDGET_USD
    expect(fanOut).toBeLessThan(DEFAULT_AUTO_SESSION_BUDGET_USD)
    expect(DEFAULT_AUTO_SESSION_BUDGET_USD - fanOut).toBeGreaterThanOrEqual(DEFAULT_SUB_AGENT_BUDGET_USD)
  })

  it('admits the full fan-out through the real ledger', () => {
    // Not a restatement of the inequality above — this drives the actual
    // reservation code, which is what the inequality is a model of.
    const ledger = new AutoCostLedger(DEFAULT_AUTO_SESSION_BUDGET_USD)
    ledger.recordMainCost(DEFAULT_SUB_AGENT_BUDGET_USD)   // main loop has spent some

    for (let i = 0; i < AUTO_CONCURRENT_SUB_AGENTS; i++) {
      expect(
        ledger.tryReserveTask(`task-${i}`, DEFAULT_SUB_AGENT_BUDGET_USD),
        `child ${i + 1} of ${AUTO_CONCURRENT_SUB_AGENTS} was refused`,
      ).toBe(true)
    }
  })

  it('would refuse the first child if the tiers were flattened', () => {
    // The failure mode this file exists to prevent, demonstrated: session cap
    // equal to child cap means no child can ever start once the main loop has
    // spent anything at all.
    const flat = new AutoCostLedger(DEFAULT_SUB_AGENT_BUDGET_USD)
    flat.recordMainCost(0.01)
    expect(flat.tryReserveTask('child', DEFAULT_SUB_AGENT_BUDGET_USD)).toBe(false)
  })

  it('keeps a gate from consuming the whole session on its own', () => {
    // verify and drift both run inside the session ledger. Either one must
    // leave the session able to continue afterwards.
    for (const gate of [DEFAULT_VERIFY_BUDGET_USD, DEFAULT_DRIFT_BUDGET_USD]) {
      expect(gate).toBeLessThan(DEFAULT_AUTO_SESSION_BUDGET_USD / 2)
    }
  })

  it('states concurrency in one place', () => {
    // Mirrored from SubAgentBridge; if that constant moves, the arithmetic
    // above stops describing reality.
    expect(AUTO_CONCURRENT_SUB_AGENTS).toBe(3)
  })
})

/**
 * Turns and money have to move together.
 *
 * Whichever limit binds first is the one that stops the work, so raising only
 * the USD ceiling buys nothing — it just relocates the wall. When the budgets
 * were raised on 2026-08-28 the turn caps were left behind, and a sub-agent
 * could reach ~5% of its new $50 ceiling before being force-stopped at 10 turns.
 */
describe('turn ceilings are proportionate to the budgets', () => {
  const TIERS = [
    { name: 'sub-agent', turns: DEFAULT_SUB_AGENT_MAX_TURNS, usd: DEFAULT_SUB_AGENT_BUDGET_USD },
    { name: 'verify judge', turns: DEFAULT_JUDGE_MAX_TURNS, usd: DEFAULT_VERIFY_BUDGET_USD },
    { name: 'drift judge', turns: DEFAULT_JUDGE_MAX_TURNS, usd: DEFAULT_DRIFT_BUDGET_USD },
    { name: 'research', turns: DEFAULT_RESEARCH_MAX_TURNS, usd: DEFAULT_RESEARCH_BUDGET_USD },
  ]

  it('lets each tier reach a meaningful share of its budget', () => {
    // Not "must spend it all" — the point is that the budget is reachable
    // enough to be a meaningful limit rather than decorative. At least a fifth
    // is the bar; below that the turn cap is unambiguously the only real
    // constraint and the USD number is theatre. The sub-agent tier sits exactly
    // on the line at 50 turns × $0.20 = $10 of $50, which is deliberate: it is
    // the tier most likely to be a small helper task, and its wall-clock cap
    // (30 min) binds well before either number in practice.
    for (const tier of TIERS) {
      const reachable = tier.turns * OBSERVED_USD_PER_TURN
      expect(
        reachable / tier.usd,
        `${tier.name}: ${tier.turns} turns can only reach $${reachable.toFixed(2)} of a $${tier.usd} ceiling`,
      ).toBeGreaterThanOrEqual(0.2)
    }
  })

  it('does not let turns alone blow past the budget either', () => {
    // The mirror-image mistake: turn caps so high that the USD ceiling is hit
    // mid-task, which is the truncation the budget warning exists to soften.
    // Some overshoot is fine and expected — the budget SHOULD be able to bind.
    for (const tier of TIERS) {
      const reachable = tier.turns * OBSERVED_USD_PER_TURN
      expect(reachable, `${tier.name} can overrun its ceiling on turns alone`)
        .toBeLessThanOrEqual(tier.usd * 2)
    }
  })

  it('gives research the most turns — it reads sources in full', () => {
    expect(DEFAULT_RESEARCH_MAX_TURNS).toBeGreaterThan(DEFAULT_JUDGE_MAX_TURNS)
    expect(DEFAULT_JUDGE_MAX_TURNS).toBeGreaterThan(DEFAULT_SUB_AGENT_MAX_TURNS)
  })

  it('keeps the per-turn estimate conservative', () => {
    // Rounded DOWN from the observed ~$0.24. A lower figure makes the
    // utilisation assertions above harder to pass, which is the safe direction.
    expect(OBSERVED_USD_PER_TURN).toBeGreaterThan(0)
    expect(OBSERVED_USD_PER_TURN).toBeLessThanOrEqual(0.24)
  })
})

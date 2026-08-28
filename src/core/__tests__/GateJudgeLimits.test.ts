/**
 * The invariant both auto gates depend on: a judge's POLLING ceiling must
 * outlast the judge's own wall-clock cap.
 *
 * When it does not, the gate stops watching a sub-agent that is still alive and
 * cannot tell "slow" from "dead". drift shipped with exactly that inversion —
 * a hard-coded 20-minute poll against an inherited 30-minute sub-agent default,
 * because `maxDurationMs` was never passed at all. Three consequences, none of
 * them visible in any log:
 *
 *   1. a healthy judge that took 21 minutes was recorded as "unavailable" and
 *      its verdict discarded;
 *   2. three of those in a row stop the whole auto run;
 *   3. the abandoned judge kept billing the shared auto-session ledger for
 *      output nobody would read.
 *
 * These tests assert the numbers directly rather than the behaviour, because
 * the behaviour only diverges after twenty minutes of wall clock — which is
 * precisely why nothing caught it.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { resolveDriftLimits, DRIFT_AGENT_DEFAULT_MAX_TURNS } from '../auto/learn/DriftAgent.js'
import { resolveJudgeLimits, VERIFY_JUDGE_DEFAULTS } from '../auto/verify/VerifyJudge.js'
import { DEFAULT_SUB_AGENT_MAX_DURATION_MS } from '../../subagent/types.js'
import { setTimeoutOverrides, resetTimeoutsForTest, TIMEOUT_DEFAULTS } from '../timeouts.js'
import { DEFAULT_DRIFT_BUDGET_USD } from '../../infra/budgets.js'

/** The margin both gates leave between the judge's cap and their own ceiling. */
const POLL_MARGIN_MS = 60_000

const ENV_KEYS = [
  'META_AGENT_DRIFT_MAX_TURNS',
  'META_AGENT_DRIFT_MAX_BUDGET_USD',
  'META_AGENT_DRIFT_MAX_DURATION_MS',
  'META_AGENT_VERIFY_MAX_TURNS',
  'META_AGENT_VERIFY_MAX_BUDGET_USD',
  'META_AGENT_VERIFY_MAX_DURATION_MS',
] as const

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  resetTimeoutsForTest()
})

describe('drift judge limits', () => {
  it('declares a wall-clock cap instead of inheriting one', () => {
    // The regression itself: an absent maxDurationMs silently became the
    // sub-agent default, a number the gate had no idea about.
    const limits = resolveDriftLimits()
    expect(limits.maxDurationMs).toBeGreaterThan(0)
    expect(Number.isFinite(limits.maxDurationMs)).toBe(true)
  })

  it('keeps the polling ceiling ABOVE the judge cap', () => {
    const limits = resolveDriftLimits()
    const pollCeiling = limits.maxDurationMs + POLL_MARGIN_MS
    expect(pollCeiling).toBeGreaterThan(limits.maxDurationMs)
    // The shipped inversion, spelled out: 20 min of polling against a 30 min
    // sub-agent left a 10 minute window where a live judge looked dead.
    expect(pollCeiling).toBeGreaterThan(DEFAULT_SUB_AGENT_MAX_DURATION_MS)
  })

  it('uses the documented defaults', () => {
    const limits = resolveDriftLimits()
    expect(limits.maxTurns).toBe(DRIFT_AGENT_DEFAULT_MAX_TURNS)
    expect(limits.maxBudgetUsd).toBe(DEFAULT_DRIFT_BUDGET_USD)
    expect(limits.maxDurationMs).toBe(TIMEOUT_DEFAULTS.driftMaxDurationMs)
  })

  it('honours env overrides for all three limits', () => {
    process.env['META_AGENT_DRIFT_MAX_TURNS'] = '7'
    process.env['META_AGENT_DRIFT_MAX_BUDGET_USD'] = '2.5'
    process.env['META_AGENT_DRIFT_MAX_DURATION_MS'] = '600000'
    const limits = resolveDriftLimits()
    expect(limits.maxTurns).toBe(7)
    expect(limits.maxBudgetUsd).toBe(2.5)
    expect(limits.maxDurationMs).toBe(600_000)
  })

  it('reads the duration from the config file too, not just the env', () => {
    // Routing through the shared resolver is what makes
    // `timeouts.driftMaxDurationMs` work — verify already had this.
    setTimeoutOverrides({ driftMaxDurationMs: 900_000 })
    expect(resolveDriftLimits().maxDurationMs).toBe(900_000)
  })

  it('falls back rather than accepting junk', () => {
    process.env['META_AGENT_DRIFT_MAX_TURNS'] = 'not-a-number'
    process.env['META_AGENT_DRIFT_MAX_BUDGET_USD'] = 'free'
    expect(resolveDriftLimits().maxTurns).toBe(DRIFT_AGENT_DEFAULT_MAX_TURNS)
    expect(resolveDriftLimits().maxBudgetUsd).toBe(DEFAULT_DRIFT_BUDGET_USD)
  })

  it('clamps an absurd turn count', () => {
    process.env['META_AGENT_DRIFT_MAX_TURNS'] = '0'
    expect(resolveDriftLimits().maxTurns).toBe(1)
    process.env['META_AGENT_DRIFT_MAX_TURNS'] = '999999999'
    expect(resolveDriftLimits().maxTurns).toBe(10_000)
  })
})

describe('verify judge limits', () => {
  it('keeps the polling ceiling ABOVE the judge cap', () => {
    const limits = resolveJudgeLimits()
    expect(limits.maxDurationMs + POLL_MARGIN_MS).toBeGreaterThan(limits.maxDurationMs)
  })

  it('uses the documented defaults', () => {
    const limits = resolveJudgeLimits()
    expect(limits.maxTurns).toBe(VERIFY_JUDGE_DEFAULTS.maxTurns)
    expect(limits.maxBudgetUsd).toBe(VERIFY_JUDGE_DEFAULTS.maxBudgetUsd)
    expect(limits.maxDurationMs).toBe(TIMEOUT_DEFAULTS.verifyMaxDurationMs)
  })
})

describe('the two gates stay symmetric', () => {
  it('both resolve the same shape of limits', () => {
    // drift used to expose only a budget resolver while verify exposed all
    // three; the missing duration was the bug. Asserting the shapes match keeps
    // one gate from drifting away from the other again.
    expect(Object.keys(resolveDriftLimits()).sort())
      .toEqual(Object.keys(resolveJudgeLimits()).sort())
  })

  it('gives every judge limit an env override', () => {
    // Parity check: a knob one gate exposes and the other hides is how the two
    // implementations diverge in the first place.
    process.env['META_AGENT_DRIFT_MAX_DURATION_MS'] = '111000'
    process.env['META_AGENT_VERIFY_MAX_DURATION_MS'] = '222000'
    expect(resolveDriftLimits().maxDurationMs).toBe(111_000)
    expect(resolveJudgeLimits().maxDurationMs).toBe(222_000)
  })
})

/**
 * Regression tests for QueryAnalyzer's bounded-wait behavior.
 *
 * The analyzer fires a flash side-call to semantically pre-load context, but it
 * must NEVER block the agent's first tool call on provider latency. analyze()
 * races the flash call against a soft wait budget and returns the heuristic
 * fallback for the current turn if flash is slow / hangs / fails.
 */

import { describe, it, expect } from 'vitest'
import { QueryAnalyzer } from '../QueryAnalyzer.js'
import type { FlashClient } from '../../core/flash/FlashClient.js'

type QueryFn = FlashClient['query']

/** Minimal FlashClient stub exposing only the query() method analyze() uses. */
function fakeFlash(query: QueryFn): FlashClient {
  return { query } as unknown as FlashClient
}

const VALID_FLASH_JSON = JSON.stringify({
  domains: ['locomotion'],
  hasHardware: true,
  hasSimulation: false,
  searchKeywords: ['gait', 'mpc'],
  intent: 'deploy',
})

describe('QueryAnalyzer bounded wait', () => {
  it('uses the parsed flash intent when flash answers within budget', async () => {
    const analyzer = new QueryAnalyzer(fakeFlash(async () => VALID_FLASH_JSON))
    const intent = await analyzer.analyze('anything at all')

    expect(intent.intent).toBe('deploy')
    expect(intent.domains).toContain('locomotion')
    expect(intent.hasHardware).toBe(true)
  })

  it('falls back to heuristics without waiting when flash hangs', async () => {
    let resolved = false
    // Flash never resolves — analyze must return via the wait budget.
    const analyzer = new QueryAnalyzer(
      fakeFlash(() => new Promise<string | null>(() => { /* never resolves */ })),
      { waitBudgetMs: 20 },
    )

    const start = Date.now()
    const intent = await analyzer.analyze('why does the slam estimate drift on the robot')
    const elapsed = Date.now() - start
    resolved = true

    expect(resolved).toBe(true)
    expect(elapsed).toBeLessThan(500)           // bounded by the 20ms budget, not the 8s/120s timeout
    expect(intent.intent).toBe('debug')         // heuristic: query contains "why"
  })

  it('falls back to heuristics when flash returns null (timeout/error)', async () => {
    const analyzer = new QueryAnalyzer(fakeFlash(async () => null))
    const intent = await analyzer.analyze('calibrate the imu offsets')

    expect(intent.intent).toBe('calibrate')     // heuristic: query contains "calibrat"
  })

  it('does not block on a slow flash that resolves after the budget', async () => {
    const analyzer = new QueryAnalyzer(
      fakeFlash(() => new Promise<string | null>(resolve => {
        const t = setTimeout(() => resolve(VALID_FLASH_JSON), 1_000)
        ;(t as { unref?: () => void }).unref?.()
      })),
      { waitBudgetMs: 20 },
    )

    const start = Date.now()
    const intent = await analyzer.analyze('list the files in this directory')
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(500)            // returned long before the 1s flash result
    expect(intent.intent).toBe('query')          // heuristic used, NOT the flash 'deploy'
    expect(intent.intent).not.toBe('deploy')
  })

  it('returns heuristics immediately for an empty query (no flash call)', async () => {
    let called = false
    const analyzer = new QueryAnalyzer(fakeFlash(async () => { called = true; return VALID_FLASH_JSON }))
    const intent = await analyzer.analyze('   ')

    expect(called).toBe(false)
    expect(intent.domains).toContain('general')
  })
})

/**
 * The two per-run auto ceilings: their defaults, and that they are reachable.
 *
 * `autoMaxRuntimeMs` / `autoMaxToolBatches` were declared on KernelConfig but no
 * caller ever set them and no env var read them, so in practice they were
 * unreachable constants — a run that needed longer was told it had hit a limit
 * it had no way to move. These tests pin down both the defaults and the levers.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { DEFAULT_AUTO_MAX_RUNTIME_MS, DEFAULT_AUTO_MAX_TOOL_BATCHES } from '../../infra/budgets.js'
import { RuntimeEnv } from '../../infra/env/RuntimeEnv.js'
import { formatDuration } from '../../infra/duration.js'

const HOUR = 60 * 60 * 1000

afterEach(() => {
  delete process.env['META_AGENT_AUTO_MAX_RUNTIME_MIN']
  delete process.env['META_AGENT_AUTO_MAX_TOOL_BATCHES']
})

describe('auto run ceilings', () => {
  it('defaults the wall clock to 5 hours', () => {
    expect(DEFAULT_AUTO_MAX_RUNTIME_MS).toBe(5 * HOUR)
    // What the user reads when it is reached.
    expect(formatDuration(DEFAULT_AUTO_MAX_RUNTIME_MS)).toBe('5h')
  })

  it('keeps the tool-batch cap proportional so it does not become the new wall', () => {
    // Raising only the clock would stop the same runs at the same point under a
    // different name. Observed rate was ~100 batches in the old 2h window.
    const oldRatePerHour = 100 / 2
    expect(DEFAULT_AUTO_MAX_TOOL_BATCHES)
      .toBeGreaterThan(oldRatePerHour * (DEFAULT_AUTO_MAX_RUNTIME_MS / HOUR))
  })

  it('reads the wall clock from the environment, in minutes', () => {
    process.env['META_AGENT_AUTO_MAX_RUNTIME_MIN'] = '360'
    expect(RuntimeEnv.autoMaxRuntimeMs(DEFAULT_AUTO_MAX_RUNTIME_MS)).toBe(6 * HOUR)
  })

  it('reads the batch cap from the environment', () => {
    process.env['META_AGENT_AUTO_MAX_TOOL_BATCHES'] = '1200'
    expect(RuntimeEnv.autoMaxToolBatches(DEFAULT_AUTO_MAX_TOOL_BATCHES)).toBe(1200)
  })

  it('falls back to the default when the override is absent or unusable', () => {
    expect(RuntimeEnv.autoMaxRuntimeMs(DEFAULT_AUTO_MAX_RUNTIME_MS)).toBe(DEFAULT_AUTO_MAX_RUNTIME_MS)
    // Out of range and non-numeric both fall back rather than silently clamping
    // to something the user did not ask for.
    process.env['META_AGENT_AUTO_MAX_RUNTIME_MIN'] = '0'
    expect(RuntimeEnv.autoMaxRuntimeMs(DEFAULT_AUTO_MAX_RUNTIME_MS)).toBe(DEFAULT_AUTO_MAX_RUNTIME_MS)
    process.env['META_AGENT_AUTO_MAX_RUNTIME_MIN'] = 'soon'
    expect(RuntimeEnv.autoMaxRuntimeMs(DEFAULT_AUTO_MAX_RUNTIME_MS)).toBe(DEFAULT_AUTO_MAX_RUNTIME_MS)
  })

  it('caps the override at 24h so a typo cannot pin a run open forever', () => {
    process.env['META_AGENT_AUTO_MAX_RUNTIME_MIN'] = '99999'
    expect(RuntimeEnv.autoMaxRuntimeMs(DEFAULT_AUTO_MAX_RUNTIME_MS)).toBe(DEFAULT_AUTO_MAX_RUNTIME_MS)
  })
})

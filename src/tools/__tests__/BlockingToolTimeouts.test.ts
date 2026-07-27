/**
 * Tools that BLOCK on a sub-agent must opt out of the kernel's per-tool timeout.
 *
 * `run_agent` waits up to DEFAULT_SUB_AGENT_MAX_DURATION_MS + 60 s (31 min) for
 * the sub-agent to reach a terminal state, but shipped without `timeoutMs: 0`,
 * so ToolExecution killed the call at the 3-minute default — a 10.3× mismatch.
 * The parent got `Tool timed out` while the sub-agent kept running detached, and
 * each occurrence counted toward the auto-mode timed-out-running-tools circuit.
 *
 * The three sibling dispatchers already had the opt-out; this pins all four so
 * the next blocking tool cannot regress the same way.
 */
import { describe, it, expect } from 'vitest'
import { createRunAgentTool } from '../agent/run_agent/index.js'
import { createResearchDispatchTool } from '../research/research_dispatch/index.js'
import { DEFAULT_SUB_AGENT_MAX_DURATION_MS } from '../../subagent/types.js'
import { TIMEOUT_DEFAULTS } from '../../core/timeouts.js'
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'

const stubDispatcher = {} as ISubAgentDispatcher

describe('blocking sub-agent tools opt out of the per-tool timeout', () => {
  it('run_agent declares timeoutMs: 0', async () => {
    const tool = await createRunAgentTool(stubDispatcher)
    expect(tool.timeoutMs).toBe(0)
  })

  it('research_dispatch declares timeoutMs: 0', () => {
    const tool = createResearchDispatchTool({ dispatcher: stubDispatcher } as never)
    expect(tool.timeoutMs).toBe(0)
  })

  it('the opt-out is necessary: the wait exceeds the kernel default by ~10x', () => {
    const runAgentWaitMs = DEFAULT_SUB_AGENT_MAX_DURATION_MS + 60_000
    expect(runAgentWaitMs).toBe(1_860_000)
    expect(runAgentWaitMs / TIMEOUT_DEFAULTS.toolMs).toBeGreaterThan(10)
  })
})

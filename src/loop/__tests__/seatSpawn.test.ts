/**
 * spawnAndWait — the outer poll wrapper. Regression guard for the wallclockMin
 * bug: the poll deadline (maxWaitMs) must be honoured, so a seat configured with
 * a longer wall-clock isn't abandoned at the default 31 min (which recorded
 * "no record" / worker ✗ / cost 0 while the seat was still running).
 */
import { describe, expect, it } from 'vitest'
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import type { SubAgentRecord, SubAgentStatus } from '../../subagent/types.js'
import { makeSubAgentTaskId } from '../../subagent/types.js'
import { spawnAndWait } from '../seatSpawn.js'

function rec(status: SubAgentStatus): SubAgentRecord {
  return {
    schemaVersion: '1.0', taskId: makeSubAgentTaskId(), parentSessionId: 't',
    status, config: { taskDescription: 't' } as SubAgentRecord['config'],
    createdAt: Date.now(), pendingHumanApproval: false,
  } as SubAgentRecord
}

/** Dispatcher whose task stays 'running' for `runningPolls` getStatus calls, then 'completed'. */
function slowDispatcher(runningPolls: number): ISubAgentDispatcher {
  let polls = 0
  const started = rec('running')
  return {
    async spawnSubAgent() { return started },
    async getStatus() {
      polls++
      return polls > runningPolls ? { ...started, status: 'completed' } : started
    },
    async cancelTask() { return true },
  }
}

describe('spawnAndWait maxWaitMs', () => {
  it('returns the terminal record when it completes before the deadline', async () => {
    const out = await spawnAndWait(
      slowDispatcher(3), { taskDescription: 't' }, new AbortController().signal,
      { pollMs: 2, maxWaitMs: 10_000 },
    )
    expect(out?.status).toBe('completed')
  })

  it('returns null (abandons) when the deadline elapses before terminal', async () => {
    const out = await spawnAndWait(
      slowDispatcher(1_000), { taskDescription: 't' }, new AbortController().signal,
      { pollMs: 2, maxWaitMs: 12 },
    )
    expect(out).toBeNull()
  })
})

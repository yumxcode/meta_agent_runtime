/**
 * seatSpawn — loop-owned sub-agent spawn/poll plumbing.
 *
 * Relocated from core/auto_orch/reviewer.ts per the v1 retirement plan
 * (spec §7 迁移清单): the loop runtime must not depend on the retired graph
 * engine. Semantics unchanged: spawn, poll until terminal, null on timeout.
 */
import type { ISubAgentDispatcher } from '../subagent/ISubAgentDispatcher.js'
import {
  DEFAULT_SUB_AGENT_MAX_DURATION_MS,
  TERMINAL_STATUSES,
  type SubAgentConfig,
  type SubAgentRecord,
} from '../subagent/types.js'

export interface SpawnWaitOptions {
  pollMs?: number
  maxWaitMs?: number
}

/** Spawn a sub-agent and poll until terminal (or abort/timeout). */
export async function spawnAndWait(
  dispatcher: ISubAgentDispatcher,
  config: Partial<SubAgentConfig> & Pick<SubAgentConfig, 'taskDescription'>,
  signal: AbortSignal,
  opts?: SpawnWaitOptions,
): Promise<SubAgentRecord | null> {
  const pollMs = opts?.pollMs ?? 500
  const maxWaitMs = opts?.maxWaitMs ?? DEFAULT_SUB_AGENT_MAX_DURATION_MS + 60_000
  const rec = await dispatcher.spawnSubAgent({ config, abortSignal: signal })
  const deadline = Date.now() + maxWaitMs
  let latest = rec
  while (!TERMINAL_STATUSES.has(latest.status)) {
    if (signal.aborted || Date.now() > deadline) break
    await new Promise(r => setTimeout(r, pollMs))
    const polled = await dispatcher.getStatus(rec.taskId)
    if (!polled) break
    latest = polled
  }
  return TERMINAL_STATUSES.has(latest.status) ? latest : null
}

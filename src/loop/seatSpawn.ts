/**
 * seatSpawn — loop-owned sub-agent spawn/poll plumbing.
 *
 * Shared plumbing for Agent nodes: spawn, observe terminal completion, and
 * fence timeout/abort cancellation before the graph can retry the work.
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
  /** Time allowed for a cancellation to become terminal. A caller must not
   * replay work while the previous task may still be alive. */
  cancelGraceMs?: number
}

export type SpawnWaitKind = 'terminal' | 'aborted' | 'timed_out' | 'lost' | 'cancellation_unconfirmed'

export interface SpawnWaitOutcome {
  kind: SpawnWaitKind
  taskId: string
  record: SubAgentRecord | null
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve()
  return new Promise(resolve => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

async function waitAfterCancel(
  dispatcher: ISubAgentDispatcher,
  taskId: string,
  timeoutMs: number,
  pollMs: number,
): Promise<SubAgentRecord | null> {
  if (dispatcher.waitForTerminal) {
    const record = await dispatcher.waitForTerminal(taskId, { timeoutMs }).catch(() => null)
    if (record && TERMINAL_STATUSES.has(record.status)) return record
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const record = await dispatcher.getStatus(taskId).catch(() => null)
    if (record && TERMINAL_STATUSES.has(record.status)) return record
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))))
  }
  return null
}

/** Detailed variant used by the Loop kernel. It does not report an abort as
 * safely replayable until cancellation is observed terminal. */
export async function spawnAndWaitDetailed(
  dispatcher: ISubAgentDispatcher,
  config: Partial<SubAgentConfig> & Pick<SubAgentConfig, 'taskDescription'>,
  signal: AbortSignal,
  opts?: SpawnWaitOptions,
): Promise<SpawnWaitOutcome> {
  const pollMs = opts?.pollMs ?? 500
  const maxWaitMs = opts?.maxWaitMs ?? DEFAULT_SUB_AGENT_MAX_DURATION_MS + 60_000
  const cancelGraceMs = opts?.cancelGraceMs ?? 5_000
  const rec = await dispatcher.spawnSubAgent({ config, abortSignal: signal })
  const deadline = Date.now() + maxWaitMs
  let latest = rec
  let stopped: 'aborted' | 'timed_out' | 'lost' | null = null
  while (!TERMINAL_STATUSES.has(latest.status)) {
    if (signal.aborted) { stopped = 'aborted'; break }
    if (Date.now() > deadline) { stopped = 'timed_out'; break }
    await abortableDelay(pollMs, signal)
    if (signal.aborted) { stopped = 'aborted'; break }
    const polled = await dispatcher.getStatus(rec.taskId)
    if (!polled) { stopped = 'lost'; break }
    latest = polled
  }
  if (!stopped) return { kind: 'terminal', taskId: rec.taskId, record: latest }

  await dispatcher.cancelTask(rec.taskId, `loop seat ${stopped}`).catch(() => false)
  const terminal = await waitAfterCancel(dispatcher, rec.taskId, cancelGraceMs, pollMs)
  if (!terminal) return { kind: 'cancellation_unconfirmed', taskId: rec.taskId, record: latest }
  return { kind: stopped, taskId: rec.taskId, record: terminal }
}

/** Spawn a sub-agent and poll until terminal (or abort/timeout). */
export async function spawnAndWait(
  dispatcher: ISubAgentDispatcher,
  config: Partial<SubAgentConfig> & Pick<SubAgentConfig, 'taskDescription'>,
  signal: AbortSignal,
  opts?: SpawnWaitOptions,
): Promise<SubAgentRecord | null> {
  const outcome = await spawnAndWaitDetailed(dispatcher, config, signal, opts)
  return outcome.kind === 'terminal' ? outcome.record : null
}

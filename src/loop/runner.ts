/**
 * runner — claim-and-run glue between WakeStore and LoopKernel (spec C8, M1
 * subset: no daemon yet — `tickOnce` is what `meta-agent loop tick` and the
 * foreground waiter call; the M2 daemon wraps the same function in a poll
 * loop + child-process dispatch).
 */
import type { ISubAgentDispatcher } from '../subagent/ISubAgentDispatcher.js'
import { WakeStore } from './wake/WakeStore.js'
import { loadInstance } from './instance/InstanceStore.js'
import { runRound, type RoundOutcome } from './kernel/LoopKernel.js'
import { handleProbeWake, ingestEvents } from './effects/WaitOps.js'

export interface TickDeps {
  dispatcher: ISubAgentDispatcher
  projectDir: string
  signal?: AbortSignal
}

export interface TickResult {
  claimed: number
  outcomes: Array<{ loopId: string; outcome?: RoundOutcome; probe?: string; error?: string }>
}

/**
 * Claim every due wake for this workspace and handle it:
 *   probe wakes → pure-code probe (cheap, in-process, no LLM);
 *   timer/event/manual → a full kernel round (LLM seats).
 * Event files are ingested up front so a dropped completion event converts
 * into a harvest wake within the same tick.
 */
export async function tickOnce(deps: TickDeps, now = Date.now()): Promise<TickResult> {
  const wakeStore = new WakeStore(deps.projectDir)
  await wakeStore.reconcileOrphans(now)

  // Event ingestion for every instance that currently has any wake or is
  // waiting: cheap directory scans, idempotent.
  const known = new Set((await wakeStore.list()).map(w => w.loopId))
  for (const loopId of known) {
    const instance = await loadInstance(deps.projectDir, loopId)
    if (instance) {
      await ingestEvents(instance, { wakeStore, projectDir: deps.projectDir }).catch(() => 0)
    }
  }

  const due = await wakeStore.claimDue(now)
  const outcomes: TickResult['outcomes'] = []
  for (const wake of due) {
    try {
      const instance = await loadInstance(deps.projectDir, wake.loopId)
      if (!instance) {
        await wakeStore.release(wake.wakeId, 'cancelled')
        outcomes.push({ loopId: wake.loopId, error: 'instance not found' })
        continue
      }
      if (instance.record.status === 'done' || instance.record.status === 'failed' ||
          instance.record.status === 'paused_attention') {
        await wakeStore.release(wake.wakeId, 'cancelled')
        outcomes.push({ loopId: wake.loopId, error: `instance is ${instance.record.status}` })
        continue
      }
      if (wake.kind === 'probe') {
        const probe = await handleProbeWake(instance, wake, { wakeStore, projectDir: deps.projectDir })
        outcomes.push({ loopId: wake.loopId, probe: `${probe.verdict}→${probe.action}` })
        continue
      }
      const outcome = await runRound(instance, wake, {
        dispatcher: deps.dispatcher,
        projectDir: deps.projectDir,
        signal: deps.signal ?? new AbortController().signal,
        wakeStore,
      })
      outcomes.push({ loopId: wake.loopId, outcome })
    } catch (err) {
      // A crashed round re-queues its wake (claim TTL would also recover it,
      // but an in-process failure can requeue immediately and cheaply).
      await wakeStore.release(wake.wakeId, 'pending').catch(() => undefined)
      outcomes.push({ loopId: wake.loopId, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { claimed: due.length, outcomes }
}

/** Run ticks until no wake is due right now (M1 "无人值守" driver for tests/CLI). */
export async function runUntilQuiescent(
  deps: TickDeps,
  opts?: { maxTicks?: number },
): Promise<TickResult[]> {
  const results: TickResult[] = []
  const maxTicks = opts?.maxTicks ?? 100
  for (let i = 0; i < maxTicks; i++) {
    const result = await tickOnce(deps)
    results.push(result)
    if (result.claimed === 0) break
  }
  return results
}

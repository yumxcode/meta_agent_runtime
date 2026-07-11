/**
 * WaitOps — probe execution, event ingestion, and waiting-state reconciliation
 * (spec T2.2/T2.3/T2.5). All pure code, all idempotent:
 *
 *   probe path : probe wake due → adapter verdict → rule table → action
 *   event path : events/<file> dropped → conclude(effectKey) → harvest wake
 *   reconcile  : any process at any time can repair {pending_round × effect ×
 *                wake} to a consistent trio — this is what makes kill -9 boring.
 *
 * Both paths funnel through EffectLedger.conclude(), whose first-wins
 * semantics is THE dedup point: event-then-probe or probe-then-event, the
 * harvest wake is scheduled exactly once.
 */
import { readdir, readFile, rename, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { atomicWriteJson, readJsonFile } from '../../infra/persist/index.js'
import type { LoopInstance } from '../instance/InstanceStore.js'
import { WakeStore } from '../wake/WakeStore.js'
import type { PendingRound } from '../types.js'
import { EffectLedger } from './EffectLedger.js'

export interface WaitOpsDeps {
  wakeStore: WakeStore
  /** Workspace root event ingestion resolves relative paths against. */
  projectDir: string
}

export function effectLedgerFor(instance: LoopInstance): EffectLedger {
  return new EffectLedger(instance.ledger, instance.paths)
}

export async function readPendingRound(instance: LoopInstance): Promise<PendingRound | null> {
  return readJsonFile<PendingRound>(instance.paths.pendingRoundJson)
}

export async function writePendingRound(instance: LoopInstance, pending: PendingRound): Promise<void> {
  await atomicWriteJson(instance.paths.pendingRoundJson, pending)
}

export async function clearPendingRound(instance: LoopInstance): Promise<void> {
  await rm(instance.paths.pendingRoundJson, { force: true }).catch(() => undefined)
}

async function scheduleHarvestWake(
  instance: LoopInstance,
  deps: WaitOpsDeps,
  effectKey: string,
): Promise<void> {
  // Kind 'event' = harvest trigger. Duplicate scheduling is harmless: the
  // second harvest wake finds no pending_round and is cancelled by the runner.
  await deps.wakeStore.schedule({
    loopId: instance.record.instanceId,
    kind: 'event',
    fireAt: Date.now(),
    effectKey,
  })
}

// ── event path ────────────────────────────────────────────────────────────────

/** Ingest dropped event files: `events/*.json` with {effectKey, verdict, data}. */
export async function ingestEvents(instance: LoopInstance, deps: WaitOpsDeps): Promise<number> {
  let files: string[]
  try {
    files = (await readdir(instance.paths.eventsDir)).filter(f => f.endsWith('.json')).sort()
  } catch {
    return 0
  }
  const effects = effectLedgerFor(instance)
  await mkdir(instance.paths.eventsProcessedDir, { recursive: true })
  let concluded = 0
  for (const file of files) {
    const from = join(instance.paths.eventsDir, file)
    let raw: string
    try {
      raw = await readFile(from, 'utf-8')
    } catch {
      continue // vanished (a concurrent ingester won the race) — nothing to do
    }
    let parsed: { effectKey?: unknown; verdict?: unknown; data?: unknown }
    try {
      parsed = JSON.parse(raw) as { effectKey?: unknown; verdict?: unknown; data?: unknown }
    } catch (err) {
      // Quarantine LOUDLY: silently retrying an unparseable event every round
      // forever hides the producer's bug. `.bad` files fall out of the .json
      // filter above, so this is a one-time action.
      console.error(
        `[loop] unparseable event file ${from} — quarantined as .bad:`,
        err instanceof Error ? err.message : String(err),
      )
      await rename(from, `${from}.bad`).catch(() => undefined)
      continue
    }
    try {
      if (typeof parsed.effectKey === 'string' && parsed.effectKey) {
        const verdict = typeof parsed.verdict === 'string' ? parsed.verdict : 'done'
        if (await effects.conclude(parsed.effectKey, verdict, 'event', parsed.data)) {
          await scheduleHarvestWake(instance, deps, parsed.effectKey)
          concluded++
        }
      }
      await rename(from, join(instance.paths.eventsProcessedDir, file))
    } catch {
      // Concluded/renamed by a concurrent ingester — leave as is.
    }
  }
  return concluded
}

// ── reconciliation (T2.5) ─────────────────────────────────────────────────────

/**
 * Repair the {pending_round, effect, wake} trio after any crash:
 *   self_timer pending          → re-arm the timer wake if lost
 *   pending + effect concluded  → ensure a harvest wake exists
 *   pending + effect submitted   → event wait: nothing to schedule (waits for an
 *                                 external events/ file; ingestEvents concludes it)
 *   pending + effect missing     → submit segment crashed pre-register: drop the
 *                                 pending round and reschedule a fresh timer
 *   no pending + effect concluded → harvest finished its ledger writes but
 *                                 crashed before markHarvested: settle it
 * Returns a human-readable action list (observability / tests).
 */
export async function reconcileWaiting(instance: LoopInstance, deps: WaitOpsDeps): Promise<string[]> {
  const actions: string[] = []
  const effects = effectLedgerFor(instance)
  const pending = await readPendingRound(instance)
  const wakes = (await deps.wakeStore.list()).filter(
    w => w.loopId === instance.record.instanceId && (w.status === 'pending' || w.status === 'claimed'),
  )

  if (pending && pending.kind === 'self_timer') {
    // Self-timer park has no effect ledger — just a timer wake at fireAt. If that
    // wake was lost to a crash, re-arm it (immediately if already overdue).
    const hasTimer = wakes.some(w => w.kind === 'timer')
    if (!hasTimer) {
      await deps.wakeStore.schedule({
        loopId: instance.record.instanceId, kind: 'timer',
        fireAt: pending.fireAt ?? Date.now(),
      })
      actions.push(`re-armed missing self-timer wake (round ${pending.round}, reason ${pending.reason ?? '?'})`)
    }
  } else if (pending) {
    const effect = await effects.get(pending.effectKey!)
    if (!effect) {
      await clearPendingRound(instance)
      await deps.wakeStore.schedule({ loopId: instance.record.instanceId, kind: 'timer', fireAt: Date.now() })
      actions.push(`dropped orphan pending_round (round ${pending.round}, no effect record)`)
    } else if (effect.status === 'concluded') {
      if (!wakes.some(w => w.kind === 'event' && w.effectKey === pending.effectKey)) {
        await scheduleHarvestWake(instance, deps, pending.effectKey!)
        actions.push(`scheduled missing harvest wake for ${pending.effectKey}`)
      }
    } else if (effect.status === 'submitted' || effect.status === 'probing') {
      // Event wait: nothing to re-arm — it concludes when an external events/
      // file arrives (ingested at the top of every round). Just keep waiting.
    } else {
      // failed/harvested with a pending round left behind → drop and move on.
      await clearPendingRound(instance)
      await deps.wakeStore.schedule({ loopId: instance.record.instanceId, kind: 'timer', fireAt: Date.now() })
      actions.push(`cleared pending_round for ${effect.status} effect ${pending.effectKey}`)
    }
  } else {
    for (const effect of await effects.pending()) {
      if (effect.status === 'concluded') {
        await effects.markHarvested(effect.effectKey)
        actions.push(`settled post-harvest effect ${effect.effectKey}`)
      }
    }
  }
  return actions
}

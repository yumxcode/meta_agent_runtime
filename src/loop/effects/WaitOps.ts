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
import type { WakeRecord } from '../wake/WakeStore.js'
import { WakeStore } from '../wake/WakeStore.js'
import type { PendingRound } from '../types.js'
import { EffectLedger } from './EffectLedger.js'
import { getProbeAdapter } from './ProbeAdapters.js'
import type { WaitSpec } from '../charter/CharterTypes.js'

export interface WaitOpsDeps {
  wakeStore: WakeStore
  /** Workspace root probes resolve relative paths against. */
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

function waitSpecFor(instance: LoopInstance, waitName: string): WaitSpec | null {
  return instance.charter.waits?.[waitName] ?? null
}

// ── probe path ────────────────────────────────────────────────────────────────

export interface ProbeOutcome {
  verdict: string
  action: string
}

/** Execute one due probe wake. Never spawns an LLM. */
export async function handleProbeWake(
  instance: LoopInstance,
  wake: WakeRecord,
  deps: WaitOpsDeps,
): Promise<ProbeOutcome> {
  const effects = effectLedgerFor(instance)
  try {
    const effectKey = wake.effectKey
    if (!effectKey) return { verdict: 'invalid', action: 'drop' }
    const effect = await effects.get(effectKey)
    if (!effect || effect.status === 'harvested' || effect.status === 'failed') {
      return { verdict: 'stale', action: 'drop' }
    }
    if (effect.status === 'concluded') {
      // Event beat this probe; make sure a harvest wake exists, then retire.
      await scheduleHarvestWake(instance, deps, effectKey)
      return { verdict: 'concluded', action: 'wake_harvest' }
    }
    const wait = waitSpecFor(instance, effect.waitName)
    if (!wait) {
      await effects.markFailed(effectKey, `wait '${effect.waitName}' missing from charter`)
      return { verdict: 'invalid', action: 'fail' }
    }
    const adapter = getProbeAdapter(wait.kind)
    if (!adapter) {
      await effects.markFailed(effectKey, `no probe adapter for kind '${wait.kind}'`)
      return { verdict: 'invalid', action: 'fail' }
    }

    const probeInput = { effect, params: wait.params ?? {}, projectDir: deps.projectDir }
    const result = await adapter.probe(probeInput)
    await effects.recordProbe(effectKey, result.verdict, result.data)

    const rule = wait.rules.find(r => r.when === result.verdict)
    const action = rule?.do ?? 'sleep'
    switch (action) {
      case 'wake_harvest': {
        if (await effects.conclude(effectKey, result.verdict, 'probe', result.data)) {
          await scheduleHarvestWake(instance, deps, effectKey)
        }
        return { verdict: result.verdict, action }
      }
      case 'terminate_and_harvest': {
        await adapter.terminate?.(probeInput)
        if (await effects.conclude(effectKey, result.verdict, 'probe', result.data)) {
          await scheduleHarvestWake(instance, deps, effectKey)
        }
        return { verdict: result.verdict, action }
      }
      case 'rotate_and_resubmit': {
        const resub = await adapter.resubmit?.(probeInput)
        await effects.recordResubmit(effectKey, resub?.payload)
        await scheduleNextProbe(instance, deps, effectKey, wait)
        return { verdict: result.verdict, action }
      }
      case 'sleep':
      default:
        await scheduleNextProbe(instance, deps, effectKey, wait)
        return { verdict: result.verdict, action: 'sleep' }
    }
  } finally {
    await deps.wakeStore.release(wake.wakeId, 'done').catch(() => undefined)
  }
}

export async function scheduleNextProbe(
  instance: LoopInstance,
  deps: WaitOpsDeps,
  effectKey: string,
  wait: WaitSpec,
): Promise<void> {
  await deps.wakeStore.schedule({
    loopId: instance.record.instanceId,
    kind: 'probe',
    fireAt: Date.now() + wait.probeEveryMs,
    effectKey,
  })
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
    try {
      const parsed = JSON.parse(await readFile(from, 'utf-8')) as {
        effectKey?: unknown; verdict?: unknown; data?: unknown
      }
      if (typeof parsed.effectKey === 'string' && parsed.effectKey) {
        const verdict = typeof parsed.verdict === 'string' ? parsed.verdict : 'done'
        if (await effects.conclude(parsed.effectKey, verdict, 'event', parsed.data)) {
          await scheduleHarvestWake(instance, deps, parsed.effectKey)
          concluded++
        }
      }
      await rename(from, join(instance.paths.eventsProcessedDir, file))
    } catch {
      // Unreadable event: leave in place; a human or the sender can fix it.
    }
  }
  return concluded
}

// ── reconciliation (T2.5) ─────────────────────────────────────────────────────

/**
 * Repair the {pending_round, effect, wake} trio after any crash:
 *   pending + effect concluded  → ensure a harvest wake exists
 *   pending + effect probing    → ensure a probe wake exists
 *   pending + effect missing    → submit segment crashed pre-register: drop the
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

  if (pending) {
    const effect = await effects.get(pending.effectKey)
    if (!effect) {
      await clearPendingRound(instance)
      await deps.wakeStore.schedule({ loopId: instance.record.instanceId, kind: 'timer', fireAt: Date.now() })
      actions.push(`dropped orphan pending_round (round ${pending.round}, no effect record)`)
    } else if (effect.status === 'concluded') {
      if (!wakes.some(w => w.kind === 'event' && w.effectKey === pending.effectKey)) {
        await scheduleHarvestWake(instance, deps, pending.effectKey)
        actions.push(`scheduled missing harvest wake for ${pending.effectKey}`)
      }
    } else if (effect.status === 'submitted' || effect.status === 'probing') {
      if (!wakes.some(w => w.kind === 'probe' && w.effectKey === pending.effectKey)) {
        const wait = waitSpecFor(instance, effect.waitName)
        if (wait) {
          await scheduleNextProbe(instance, deps, pending.effectKey, wait)
          actions.push(`scheduled missing probe wake for ${pending.effectKey}`)
        }
      }
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

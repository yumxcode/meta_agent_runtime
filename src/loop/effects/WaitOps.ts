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
import { readdir, readFile, rename, mkdir, rm, stat } from 'fs/promises'
import { join } from 'path'
import { atomicWriteJson, readJsonFile } from '../../infra/persist/index.js'
import type { LoopInstance } from '../instance/InstanceStore.js'
import { setInstanceStatus } from '../instance/InstanceStore.js'
import { WakeStore } from '../wake/WakeStore.js'
import type { PendingRound } from '../types.js'
import { EffectLedger } from './EffectLedger.js'
import {
  defaultEffectAdapterRegistry,
  EffectConfigurationError,
  EVENT_EFFECT_ADAPTER_ID,
  type EffectAdapterRegistry,
} from './EffectAdapter.js'
import { advanceEffect } from './EffectRuntime.js'
import { consumeEventNonce, verifyEffectEvent } from './EventAuth.js'

const MAX_EVENT_FILES_PER_INGEST = 256
const MAX_EVENT_FILE_BYTES = 1_048_576

export interface WaitOpsDeps {
  wakeStore: WakeStore
  /** Workspace root event ingestion resolves relative paths against. */
  projectDir: string
  effectAdapters?: EffectAdapterRegistry
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
    files = (await readdir(instance.paths.eventsDir))
      .filter(f => f.endsWith('.json')).sort().slice(0, MAX_EVENT_FILES_PER_INGEST)
  } catch (error) {
    if (isMissingFile(error)) return 0
    throw error
  }
  if (files.length === 0) return 0
  const effects = effectLedgerFor(instance)
  await mkdir(instance.paths.eventsProcessedDir, { recursive: true })
  let concluded = 0
  for (const file of files) {
    const from = join(instance.paths.eventsDir, file)
    let raw: string
    try {
      const size = (await stat(from)).size
      if (size > MAX_EVENT_FILE_BYTES) {
        console.error(`[loop] oversized event file ${from} (${size} bytes) — quarantined`)
        await renameUnlessMissing(from, `${from}.oversize`)
        continue
      }
      raw = await readFile(from, 'utf-8')
    } catch (error) {
      // A concurrent ingester may win between readdir and stat/read. Other I/O
      // failures are operational faults and must remain visible to the daemon.
      if (isMissingFile(error)) continue
      throw error
    }
    let parsed: { effectKey?: unknown; verdict?: unknown; data?: unknown; signature?: unknown }
    try {
      parsed = JSON.parse(raw) as { effectKey?: unknown; verdict?: unknown; data?: unknown; signature?: unknown }
    } catch (err) {
      // Quarantine LOUDLY: silently retrying an unparseable event every round
      // forever hides the producer's bug. `.bad` files fall out of the .json
      // filter above, so this is a one-time action.
      console.error(
        `[loop] unparseable event file ${from} — quarantined as .bad:`,
        err instanceof Error ? err.message : String(err),
      )
      await renameUnlessMissing(from, `${from}.bad`)
      continue
    }
    if (typeof parsed.effectKey === 'string' && parsed.effectKey) {
      const effect = await effects.get(parsed.effectKey)
      let accepted = parsed
      if (effect?.authRequired || typeof parsed.signature === 'string') {
        const verified = await verifyEffectEvent(instance, parsed)
        if (!verified.ok) {
          console.error(`[loop] unauthorized event file ${from}: ${verified.reason}`)
          await renameUnlessMissing(from, `${from}.unauthorized`)
          continue
        }
        // Replay protection: each authenticated nonce is consumed exactly
        // once. Without this, a captured signed event could conclude a LATER
        // wait that reuses the same effectKey inside the signature's expiry.
        if (!await consumeEventNonce(instance, verified.event)) {
          console.error(`[loop] replayed authenticated event ${from} (nonce already consumed)`)
          await renameUnlessMissing(from, `${from}.replayed`)
          continue
        }
        const event = verified.event
        const auth = {
          principal: event.principal, roles: event.roles,
          keyId: event.keyId, nonce: event.nonce,
          issuedAt: event.issuedAt, expiresAt: event.expiresAt,
        }
        accepted = {
          ...event,
          data: isRecord(event.data) ? { ...event.data, _auth: auth } : { value: event.data, _auth: auth },
        }
      }
      const verdict = typeof accepted.verdict === 'string' ? accepted.verdict : 'done'
      if (await effects.conclude(parsed.effectKey, verdict, 'event', accepted.data)) {
        await scheduleHarvestWake(instance, deps, parsed.effectKey)
        concluded++
      }
    }
    try {
      await rename(from, join(instance.paths.eventsProcessedDir, file))
    } catch (error) {
      // A concurrent ingester can move the same first-wins event after both
      // readers observe it. Permission and storage failures must not vanish.
      if (!isMissingFile(error)) throw error
    }
  }
  return concluded
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

async function renameUnlessMissing(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
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
    } else if (['dispatching', 'submitted', 'probing', 'retry_wait', 'cancelling'].includes(effect.status)) {
      const hasPollWake = wakes.some(w => w.kind === 'effect_poll' && w.effectKey === effect.effectKey)
      if (effect.adapterId !== EVENT_EFFECT_ADAPTER_ID && !hasPollWake) {
        try {
          await advanceEffect(
            instance, deps.wakeStore, effect.effectKey,
            deps.effectAdapters ?? defaultEffectAdapterRegistry(), 'reconcile',
          )
        } catch (error) {
          if (!(error instanceof EffectConfigurationError)) throw error
          await setInstanceStatus(instance, 'failed', `effect configuration failed: ${error.message}`)
          await deps.wakeStore.cancelForLoop(instance.record.instanceId)
          actions.push(`fail-stopped on effect configuration error: ${error.message}`)
          return actions
        }
      }
      const refreshed = await effects.get(pending.effectKey!)
      if (refreshed?.status === 'concluded') {
        if (!wakes.some(w => w.kind === 'event' && w.effectKey === pending.effectKey)) {
          await scheduleHarvestWake(instance, deps, pending.effectKey!)
        }
        actions.push(`reconciled and scheduled harvest wake for ${pending.effectKey}`)
        return actions
      }
      if (refreshed?.status === 'failed') {
        await setInstanceStatus(
          instance, 'failed',
          `effect ${pending.effectKey} failed: ${refreshed.lastError ?? 'operator reconciliation required'}`,
        )
        await deps.wakeStore.cancelForLoop(instance.record.instanceId)
        actions.push(`fail-stopped on failed effect ${pending.effectKey}`)
        return actions
      }
      const expiresAt = pending.expiresAt ?? pending.createdAt + 7 * 24 * 60 * 60_000
      if (effect.adapterId === EVENT_EFFECT_ADAPTER_ID && Date.now() >= expiresAt) {
        if (!pending.timedOutAt) {
          await writePendingRound(instance, { ...pending, timedOutAt: Date.now() })
        }
        if (!wakes.some(w => w.kind === 'event' && w.effectKey === pending.effectKey)) {
          await scheduleHarvestWake(instance, deps, pending.effectKey!)
        }
        actions.push(`event wait timed out for ${pending.effectKey}`)
      }
      // Otherwise nothing to re-arm: the external events/ file owns progress.
    } else if (effect.status === 'failed') {
      await setInstanceStatus(
        instance, 'failed',
        `effect ${pending.effectKey} failed: ${effect.lastError ?? 'operator reconciliation required'}`,
      )
      await deps.wakeStore.cancelForLoop(instance.record.instanceId)
      actions.push(`fail-stopped on failed effect ${pending.effectKey}`)
    } else {
      // cancelled/harvested with a pending round left behind → drop and move on.
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
    // Self-heal a 'waiting' instance with NO pending round (e.g. a crash
    // between `loop stop`'s clearPendingRound and its terminal write): nothing
    // else would ever schedule a wake for it, so it would stay wedged forever
    // — and keep the daemon alive polling it. Flip to idle and let the
    // scheduler run a fresh round.
    if (instance.record.status === 'waiting') {
      try {
        await setInstanceStatus(instance, 'idle', 'reconcile: waiting without pending_round', {
          expectFrom: ['waiting'],
        })
        await deps.wakeStore.schedule({
          loopId: instance.record.instanceId, kind: 'timer', fireAt: Date.now(),
        })
        actions.push('healed waiting instance with no pending_round → idle')
      } catch { /* concurrent transition owns the status — nothing to heal */ }
    }
  }
  return actions
}

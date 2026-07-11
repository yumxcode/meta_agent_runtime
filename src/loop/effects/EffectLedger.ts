/**
 * EffectLedger — the external-side-effect ledger (spec C5, D8 third channel).
 *
 * External effects (remote training, account ops) are neither files nor
 * rollback-able, so they get their own book: EVENT-SOURCED over
 * ledger/effects.jsonl. Every state change APPENDS a record; the current
 * state of an effect is the fold of its records (last-wins per field,
 * probes accumulated). Append-only keeps the crash story trivial — a torn
 * tail line loses at most the newest transition, never history — and the
 * idempotency key (`effectKey`) is what event ingestion and harvest claims
 * reconcile against so one training run is never harvested twice (D12).
 *
 * Status machine: submitted → probing → concluded(outcome) → harvested
 *                            ↘ resubmitted (rotate) → probing …
 */
import type { Ledger } from '../ledger/LedgerApi.js'
import type { InstancePaths } from '../types.js'
import { withFileLock } from '../../infra/persist/index.js'

export type EffectStatus = 'submitted' | 'probing' | 'concluded' | 'harvested' | 'failed'

export interface EffectRecord {
  effectKey: string
  kind: string
  /** Wait policy name in the charter this effect runs under. */
  waitName: string
  status: EffectStatus
  /** Payload the worker registered at submit (task id, exp name, …). */
  payload?: Record<string, unknown>
  /** Probe observations, accumulated in order. */
  probes: Array<{ at: number; verdict: string; data?: unknown }>
  /** Outcome recorded when concluded (probe verdict or ingested event). */
  outcome?: { verdict: string; data?: unknown; via: 'probe' | 'event' }
  submittedAt: number
  updatedAt: number
  resubmits: number
}

type EffectEvent =
  | { t: 'submit'; effectKey: string; kind: string; waitName: string; payload?: Record<string, unknown>; at: number }
  | { t: 'probe'; effectKey: string; verdict: string; data?: unknown; at: number }
  | { t: 'resubmit'; effectKey: string; payload?: Record<string, unknown>; at: number }
  | { t: 'conclude'; effectKey: string; verdict: string; data?: unknown; via: 'probe' | 'event'; at: number }
  | { t: 'harvested'; effectKey: string; at: number }
  | { t: 'failed'; effectKey: string; reason: string; at: number }

export class EffectLedger {
  constructor(private readonly ledger: Ledger, private readonly paths: InstancePaths) {}

  private async append(event: EffectEvent): Promise<void> {
    await this.ledger.appendJsonl(this.paths.effectsJsonl, event)
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(this.paths.effectsJsonl, fn)
  }

  async submit(input: {
    effectKey: string; kind: string; waitName: string; payload?: Record<string, unknown>
  }): Promise<void> {
    await this.locked(async () => {
      const existing = await this.get(input.effectKey)
      if (existing) return // idempotent: re-registering an effect is a no-op
      await this.append({ t: 'submit', ...input, at: Date.now() })
    })
  }

  async recordProbe(effectKey: string, verdict: string, data?: unknown): Promise<void> {
    await this.locked(() => this.append({ t: 'probe', effectKey, verdict, data, at: Date.now() }))
  }

  async recordResubmit(effectKey: string, payload?: Record<string, unknown>): Promise<void> {
    await this.locked(() => this.append({ t: 'resubmit', effectKey, payload, at: Date.now() }))
  }

  /** Conclude exactly once: the first conclude wins, later ones are no-ops.
   * This is the probe/event idempotency point (both paths call it). */
  async conclude(effectKey: string, verdict: string, via: 'probe' | 'event', data?: unknown): Promise<boolean> {
    return this.locked(async () => {
      const current = await this.get(effectKey)
      if (!current || current.status === 'concluded' || current.status === 'harvested' || current.status === 'failed') {
        return false
      }
      await this.append({ t: 'conclude', effectKey, verdict, data, via, at: Date.now() })
      return true
    })
  }

  async markHarvested(effectKey: string): Promise<void> {
    await this.locked(() => this.append({ t: 'harvested', effectKey, at: Date.now() }))
  }

  async markFailed(effectKey: string, reason: string): Promise<void> {
    await this.locked(() => this.append({ t: 'failed', effectKey, reason, at: Date.now() }))
  }

  async get(effectKey: string): Promise<EffectRecord | null> {
    return (await this.fold()).get(effectKey) ?? null
  }

  async pending(): Promise<EffectRecord[]> {
    return [...(await this.fold()).values()]
      .filter(e => e.status === 'submitted' || e.status === 'probing' || e.status === 'concluded')
  }

  private async fold(): Promise<Map<string, EffectRecord>> {
    const events = await this.ledger.readJsonl<EffectEvent>(this.paths.effectsJsonl)
    const out = new Map<string, EffectRecord>()
    for (const ev of events) {
      const cur = out.get(ev.effectKey)
      switch (ev.t) {
        case 'submit':
          if (!cur) {
            out.set(ev.effectKey, {
              effectKey: ev.effectKey, kind: ev.kind, waitName: ev.waitName,
              status: 'submitted', payload: ev.payload, probes: [],
              submittedAt: ev.at, updatedAt: ev.at, resubmits: 0,
            })
          }
          break
        case 'probe':
          if (cur && (cur.status === 'submitted' || cur.status === 'probing')) {
            cur.status = 'probing'
            cur.probes.push({ at: ev.at, verdict: ev.verdict, data: ev.data })
            cur.updatedAt = ev.at
          }
          break
        case 'resubmit':
          if (cur && cur.status !== 'harvested' && cur.status !== 'failed') {
            cur.status = 'probing'
            cur.payload = ev.payload ?? cur.payload
            cur.resubmits += 1
            cur.updatedAt = ev.at
          }
          break
        case 'conclude':
          if (cur && (cur.status === 'submitted' || cur.status === 'probing')) {
            cur.status = 'concluded'
            cur.outcome = { verdict: ev.verdict, data: ev.data, via: ev.via }
            cur.updatedAt = ev.at
          }
          break
        case 'harvested':
          if (cur && cur.status === 'concluded') {
            cur.status = 'harvested'
            cur.updatedAt = ev.at
          }
          break
        case 'failed':
          if (cur && cur.status !== 'harvested') {
            cur.status = 'failed'
            cur.updatedAt = ev.at
          }
          break
      }
    }
    return out
  }
}

import type { Ledger } from '../ledger/LedgerApi.js'
import type { InstancePaths } from '../types.js'
import { withFileLock } from '../../infra/persist/index.js'
import { EVENT_EFFECT_ADAPTER_ID } from './EffectAdapter.js'

export type EffectStatus =
  | 'dispatching' | 'submitted' | 'probing' | 'retry_wait' | 'cancelling'
  | 'concluded' | 'harvested' | 'cancelled' | 'failed'

export interface EffectRetryPolicy {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  callTimeoutMs: number
}

export interface EffectRecord {
  effectKey: string
  kind: string
  waitName: string
  adapterId: string
  effectBindingId?: string
  status: EffectStatus
  payload?: Record<string, unknown>
  receipt?: Record<string, unknown>
  /** Durable adapter_ack, independent of whether the adapter has a receipt. */
  adapterAcknowledged: boolean
  probes: Array<{ at: number; verdict: string; data?: unknown }>
  ruleEvaluations: Array<{
    at: number; bindingId: string; ruleIndex?: number; action: string;
    observations: Record<string, string | number | boolean>; diagnostic?: string
  }>
  outcome?: { verdict: string; data?: unknown; via: 'probe' | 'poll' | 'event' }
  submittedAt: number
  updatedAt: number
  deadlineAt: number
  nextInspectAt?: number
  attempts: number
  retryPolicy: EffectRetryPolicy
  admission?: { maxConcurrentCalls: number; minIntervalMs: number }
  authRequired: boolean
  lastError?: string
  lastOperation?: string
  resubmits: number
}

type EffectEvent =
  | {
      t: 'submit'; effectKey: string; kind: string; waitName: string;
      adapterId?: string; effectBindingId?: string; payload?: Record<string, unknown>; deadlineAt?: number;
      retryPolicy?: EffectRetryPolicy; authRequired?: boolean; dispatchRequired?: boolean; at: number
      admission?: { maxConcurrentCalls: number; minIntervalMs: number }
    }
  | { t: 'adapter_ack'; effectKey: string; receipt?: Record<string, unknown>; nextInspectAt?: number; at: number }
  | { t: 'adapter_error'; effectKey: string; operation: string; error: string; nextAttemptAt?: number; at: number }
  | { t: 'probe'; effectKey: string; verdict: string; data?: unknown; at: number }
  | { t: 'inspection'; effectKey: string; data?: unknown; nextInspectAt?: number; at: number }
  | {
      t: 'rule_evaluated'; effectKey: string; bindingId: string; ruleIndex?: number;
      action: string; observations: Record<string, string | number | boolean>;
      diagnostic?: string; at: number
    }
  | { t: 'resubmit'; effectKey: string; payload?: Record<string, unknown>; at: number }
  | { t: 'cancel_requested'; effectKey: string; at: number }
  | { t: 'cancelled'; effectKey: string; data?: unknown; at: number }
  | { t: 'conclude'; effectKey: string; verdict: string; data?: unknown; via: 'probe' | 'poll' | 'event'; at: number }
  | { t: 'harvested'; effectKey: string; at: number }
  | { t: 'failed'; effectKey: string; reason: string; at: number }

const LEGACY_RETRY: EffectRetryPolicy = {
  maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000, callTimeoutMs: 30_000,
}

export class EffectLedger {
  constructor(private readonly ledger: Ledger, private readonly paths: InstancePaths) {}

  private append(event: EffectEvent): Promise<void> {
    return this.ledger.appendJsonl(this.paths.effectsJsonl, event)
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(this.paths.effectsJsonl, fn)
  }

  /** Durable submit intent. Re-registering the same key is idempotent. */
  async submit(input: {
    effectKey: string; kind: string; waitName: string; adapterId?: string;
    effectBindingId?: string; payload?: Record<string, unknown>; deadlineAt?: number;
    retryPolicy?: EffectRetryPolicy; authRequired?: boolean
    admission?: { maxConcurrentCalls: number; minIntervalMs: number }
  }): Promise<void> {
    await this.locked(async () => {
      if (await this.get(input.effectKey)) return
      await this.append({
        t: 'submit', ...input, at: Date.now(),
        adapterId: input.adapterId ?? EVENT_EFFECT_ADAPTER_ID,
        dispatchRequired: input.adapterId !== undefined,
        deadlineAt: input.deadlineAt ?? Date.now() + 7 * 24 * 60 * 60_000,
        retryPolicy: input.retryPolicy ?? LEGACY_RETRY,
        authRequired: input.authRequired ?? false,
      })
    })
  }

  async acknowledgeAdapter(
    effectKey: string,
    input: { receipt?: Record<string, unknown>; nextInspectAt?: number },
  ): Promise<void> {
    await this.locked(async () => {
      const current = await this.get(effectKey)
      if (!current || terminal(current.status) || current.adapterAcknowledged) return
      await this.append({ t: 'adapter_ack', effectKey, ...input, at: Date.now() })
    })
  }

  async recordAdapterError(
    effectKey: string,
    operation: string,
    error: string,
    nextAttemptAt?: number,
  ): Promise<void> {
    await this.locked(() => this.append({
      t: 'adapter_error', effectKey, operation, error, nextAttemptAt, at: Date.now(),
    }))
  }

  async recordInspection(effectKey: string, data?: unknown, nextInspectAt?: number): Promise<void> {
    await this.locked(async () => {
      const current = await this.get(effectKey)
      if (!current || terminal(current.status)) return
      await this.append({ t: 'inspection', effectKey, data, nextInspectAt, at: Date.now() })
    })
  }

  async recordRuleEvaluation(
    effectKey: string,
    input: {
      bindingId: string; ruleIndex?: number; action: string;
      observations: Record<string, string | number | boolean>; diagnostic?: string
    },
  ): Promise<void> {
    await this.locked(async () => {
      const current = await this.get(effectKey)
      if (!current || terminal(current.status)) return
      await this.append({ t: 'rule_evaluated', effectKey, ...input, at: Date.now() })
    })
  }

  async requestCancel(effectKey: string): Promise<void> {
    await this.locked(async () => {
      const current = await this.get(effectKey)
      if (!current || terminal(current.status)) return
      await this.append({ t: 'cancel_requested', effectKey, at: Date.now() })
    })
  }

  async markCancelled(effectKey: string, data?: unknown): Promise<void> {
    await this.locked(async () => {
      const current = await this.get(effectKey)
      if (!current || terminal(current.status)) return
      await this.append({ t: 'cancelled', effectKey, data, at: Date.now() })
    })
  }

  /** Single first-wins terminal CAS shared by event and polling. */
  async conclude(
    effectKey: string,
    verdict: string,
    via: 'probe' | 'poll' | 'event',
    data?: unknown,
  ): Promise<boolean> {
    return this.locked(async () => {
      const current = await this.get(effectKey)
      if (!current || terminal(current.status)) return false
      await this.append({ t: 'conclude', effectKey, verdict, data, via, at: Date.now() })
      return true
    })
  }

  async markHarvested(effectKey: string): Promise<void> {
    await this.locked(async () => {
      const current = await this.get(effectKey)
      if (current?.status === 'concluded') await this.append({ t: 'harvested', effectKey, at: Date.now() })
    })
  }

  async markFailed(effectKey: string, reason: string): Promise<void> {
    await this.locked(async () => {
      const current = await this.get(effectKey)
      if (current && !terminal(current.status)) await this.append({ t: 'failed', effectKey, reason, at: Date.now() })
    })
  }

  async get(effectKey: string): Promise<EffectRecord | null> {
    return (await this.fold()).get(effectKey) ?? null
  }

  async pending(): Promise<EffectRecord[]> {
    return [...(await this.fold()).values()]
      .filter(effect => !['harvested', 'cancelled', 'failed'].includes(effect.status))
  }

  private async fold(): Promise<Map<string, EffectRecord>> {
    const events = await this.ledger.readJsonl<EffectEvent>(this.paths.effectsJsonl)
    const out = new Map<string, EffectRecord>()
    for (const event of events) {
      const current = out.get(event.effectKey)
      switch (event.t) {
        case 'submit':
          if (!current) out.set(event.effectKey, {
            effectKey: event.effectKey, kind: event.kind, waitName: event.waitName,
            adapterId: event.adapterId ?? EVENT_EFFECT_ADAPTER_ID,
            effectBindingId: event.effectBindingId,
            status: (event.dispatchRequired ?? event.kind === 'adapter') ? 'dispatching' : 'submitted',
            payload: event.payload,
            adapterAcknowledged: !(event.dispatchRequired ?? event.kind === 'adapter'),
            probes: [], ruleEvaluations: [], submittedAt: event.at, updatedAt: event.at,
            deadlineAt: event.deadlineAt ?? event.at + 7 * 24 * 60 * 60_000,
            attempts: (event.dispatchRequired ?? event.kind === 'adapter') ? 1 : 0,
            retryPolicy: event.retryPolicy ?? LEGACY_RETRY,
            admission: event.admission,
            authRequired: event.authRequired ?? false,
            resubmits: 0,
          })
          break
        case 'adapter_ack':
          if (current && !terminal(current.status)) {
            current.status = 'submitted'; current.receipt = event.receipt
            current.adapterAcknowledged = true
            current.nextInspectAt = event.nextInspectAt; current.updatedAt = event.at
          }
          break
        case 'adapter_error':
          if (current && !terminal(current.status)) {
            current.status = event.nextAttemptAt
              ? (event.operation.startsWith('cancel') ? 'cancelling' : 'retry_wait')
              : 'failed'
            current.nextInspectAt = event.nextAttemptAt; current.lastError = event.error
            current.lastOperation = event.operation
            current.attempts++; current.updatedAt = event.at
          }
          break
        case 'inspection':
          if (current && !terminal(current.status)) {
            current.status = current.status === 'cancelling' ? 'cancelling' : 'probing'
            current.nextInspectAt = event.nextInspectAt; current.updatedAt = event.at
            current.probes.push({ at: event.at, verdict: 'pending', data: event.data })
          }
          break
        case 'rule_evaluated':
          if (current && !terminal(current.status)) {
            current.ruleEvaluations.push({
              at: event.at, bindingId: event.bindingId, ruleIndex: event.ruleIndex,
              action: event.action, observations: event.observations,
              diagnostic: event.diagnostic,
            })
            current.updatedAt = event.at
          }
          break
        case 'probe':
          if (current && !terminal(current.status)) {
            current.status = 'probing'; current.probes.push({ at: event.at, verdict: event.verdict, data: event.data })
            current.updatedAt = event.at
          }
          break
        case 'resubmit':
          if (current && !terminal(current.status)) {
            current.status = 'probing'; current.payload = event.payload ?? current.payload
            current.resubmits++; current.updatedAt = event.at
          }
          break
        case 'cancel_requested':
          if (current && !terminal(current.status)) { current.status = 'cancelling'; current.updatedAt = event.at }
          break
        case 'cancelled':
          if (current && !terminal(current.status)) { current.status = 'cancelled'; current.updatedAt = event.at }
          break
        case 'conclude':
          if (current && !terminal(current.status)) {
            current.status = 'concluded'; current.outcome = {
              verdict: event.verdict, data: event.data, via: event.via,
            }; current.updatedAt = event.at
          }
          break
        case 'harvested':
          if (current?.status === 'concluded') { current.status = 'harvested'; current.updatedAt = event.at }
          break
        case 'failed':
          if (current && !terminal(current.status)) {
            current.status = 'failed'; current.lastError = event.reason; current.updatedAt = event.at
          }
          break
      }
    }
    return out
  }
}

function terminal(status: EffectStatus): boolean {
  return ['concluded', 'harvested', 'cancelled', 'failed'].includes(status)
}

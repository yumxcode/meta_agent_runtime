import {
  HostSchedulerCoordinator,
  adapterResourceId,
} from '../host/HostSchedulerCoordinator.js'
import type { ExecutionScope } from '../workspace/WorkspaceIdentity.js'

export interface EffectAdapterContext {
  workspaceId: string
  instanceId: string
  effectKey: string
  /** Stable adapter-facing idempotency identity; never use bare effectKey cross-workspace. */
  externalIdempotencyKey: string
  payload?: Record<string, unknown>
  receipt?: Record<string, unknown>
  attempt: number
  deadlineAt: number
  signal: AbortSignal
}

export interface EffectAdmissionPolicy {
  maxConcurrentCalls: number
  minIntervalMs: number
}

export interface EffectSubmitResult {
  receipt?: Record<string, unknown>
  /** Omit for event-only adapters. */
  inspectAfterMs?: number
}

export type EffectInspection =
  | { state: 'pending'; data?: unknown; inspectAfterMs?: number }
  | { state: 'succeeded'; verdict: string; data?: unknown }
  | { state: 'failed'; verdict: string; data?: unknown }

export type EffectCancellation =
  | { state: 'cancelled'; data?: unknown }
  | { state: 'pending'; inspectAfterMs?: number; data?: unknown }
  | { state: 'failed'; reason: string; data?: unknown }

export interface EffectAdapter {
  readonly id: string
  /** Non-secret host credential/profile identity used for shared admission. */
  readonly credentialProfile?: string
  /** Host-wide safety ceiling; frozen bindings may only tighten it. */
  readonly admission?: Partial<EffectAdmissionPolicy>
  submit(context: EffectAdapterContext): Promise<EffectSubmitResult>
  inspect(context: EffectAdapterContext): Promise<EffectInspection>
  cancel(context: EffectAdapterContext): Promise<EffectCancellation>
  /** Recover ambiguous submit/inspect state after process death. Defaults to inspect. */
  reconcile?(context: EffectAdapterContext): Promise<EffectInspection>
}

export class EffectConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EffectConfigurationError'
  }
}

export class EffectAdapterRegistry {
  private readonly adapters = new Map<string, EffectAdapter>()
  private readonly admission = new Map<string, AdmissionState>()
  private readonly hostCoordinator: HostSchedulerCoordinator

  constructor(adapters: readonly EffectAdapter[] = [], hostCoordinator = new HostSchedulerCoordinator()) {
    this.hostCoordinator = hostCoordinator
    for (const adapter of adapters) this.register(adapter)
  }

  register(adapter: EffectAdapter): void {
    if (!adapter.id?.trim()) throw new Error('EffectAdapter.id is required')
    if (this.adapters.has(adapter.id)) throw new Error(`EffectAdapter '${adapter.id}' is already registered`)
    this.adapters.set(adapter.id, adapter)
    this.admission.set(adapter.id, {
      active: 0,
      maxConcurrentCalls: boundedConcurrency(adapter.admission?.maxConcurrentCalls ?? 8),
      minIntervalMs: boundedInterval(adapter.admission?.minIntervalMs ?? 0),
      lastStartedAt: 0,
      queue: [],
    })
  }

  resolve(id: string): EffectAdapter {
    const adapter = this.adapters.get(id)
    if (!adapter) throw new EffectConfigurationError(`EffectAdapter '${id}' is not registered`)
    return adapter
  }

  ids(): readonly string[] { return [...this.adapters.keys()].sort() }

  /**
   * FIFO, abortable per-adapter admission. A binding's limits tighten the
   * host ceiling FOR ITS OWN CALLS ONLY (effective = min/max of host and
   * requested, computed per request): the shared adapter state is never
   * mutated, so one charter with maxConcurrentCalls:1 cannot permanently
   * throttle every other loop in the process.
   */
  async runWithAdmission<T>(
    id: string,
    requested: Partial<EffectAdmissionPolicy> | undefined,
    signal: AbortSignal,
    call: () => Promise<T>,
    scope?: ExecutionScope,
  ): Promise<T> {
    const adapter = this.resolve(id)
    const state = this.admission.get(id)!
    const effective: EffectAdmissionPolicy = {
      maxConcurrentCalls: requested?.maxConcurrentCalls !== undefined
        ? Math.min(state.maxConcurrentCalls, boundedConcurrency(requested.maxConcurrentCalls))
        : state.maxConcurrentCalls,
      minIntervalMs: requested?.minIntervalMs !== undefined
        ? Math.max(state.minIntervalMs, boundedInterval(requested.minIntervalMs))
        : state.minIntervalMs,
    }
    const runLocal = (activeSignal: AbortSignal): Promise<T> => new Promise<T>((resolve, reject) => {
      const request: AdmissionRequest<T> = { signal: activeSignal, call, resolve, reject, limits: effective }
      state.queue.push(request as AdmissionRequest<unknown>)
      activeSignal.addEventListener('abort', () => {
        const index = state.queue.indexOf(request as AdmissionRequest<unknown>)
        if (index >= 0) state.queue.splice(index, 1)
        reject(activeSignal.reason ?? new Error(`EffectAdapter '${id}' admission aborted`))
      }, { once: true })
      this.pumpAdmission(state)
    })
    if (!scope) return runLocal(signal)
    const coordinationAbort = new AbortController()
    const forwardAbort = (): void => coordinationAbort.abort(signal.reason)
    if (signal.aborted) forwardAbort()
    else signal.addEventListener('abort', forwardAbort, { once: true })
    const handle = await this.hostCoordinator.acquireAdapterCall(
      scope,
      adapterResourceId(id, adapter.credentialProfile ?? 'default'),
      effective.maxConcurrentCalls,
      effective.minIntervalMs,
      coordinationAbort.signal,
    )
    const heartbeat = setInterval(() => {
      void handle.heartbeat().then(ok => {
        if (!ok) coordinationAbort.abort(new Error('host adapter-call lease lost'))
      }).catch(() => coordinationAbort.abort(new Error('host adapter-call heartbeat failed')))
    }, this.hostCoordinator.heartbeatIntervalMs)
    heartbeat.unref?.()
    try {
      return await runLocal(coordinationAbort.signal)
    } finally {
      clearInterval(heartbeat)
      signal.removeEventListener('abort', forwardAbort)
      await handle.release().catch(() => undefined)
    }
  }

  private pumpAdmission(state: AdmissionState): void {
    if (state.timer || state.queue.length === 0) return
    // FIFO: the HEAD request's effective limits gate the next start (a
    // tighter binding briefly gating a looser one behind it is the price of
    // strict FIFO fairness — and strictly better than the old global ratchet).
    const head = state.queue[0]!
    if (state.active >= head.limits.maxConcurrentCalls) return
    const waitMs = Math.max(0, state.lastStartedAt + head.limits.minIntervalMs - Date.now())
    if (waitMs > 0) {
      state.timer = setTimeout(() => {
        state.timer = undefined
        this.pumpAdmission(state)
      }, waitMs)
      state.timer.unref?.()
      return
    }
    const request = state.queue.shift()!
    if (request.signal.aborted) { this.pumpAdmission(state); return }
    state.active++
    state.lastStartedAt = Date.now()
    void request.call().then(request.resolve, request.reject).finally(() => {
      state.active--
      this.pumpAdmission(state)
    })
    // Fill remaining concurrency slots; minIntervalMs will gate starts if set.
    this.pumpAdmission(state)
  }
}

interface AdmissionRequest<T> {
  signal: AbortSignal
  call: () => Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
  /** Per-request effective limits (host ceiling ∩ binding request). */
  limits: EffectAdmissionPolicy
}

interface AdmissionState {
  active: number
  maxConcurrentCalls: number
  minIntervalMs: number
  lastStartedAt: number
  queue: AdmissionRequest<unknown>[]
  timer?: ReturnType<typeof setTimeout>
}

function boundedConcurrency(value: number): number {
  return Number.isInteger(value) ? Math.max(1, Math.min(1_000, value)) : 8
}

function boundedInterval(value: number): number {
  return Number.isInteger(value) ? Math.max(0, Math.min(60_000, value)) : 0
}

export const EVENT_EFFECT_ADAPTER_ID = 'builtin/event@1'

const eventAdapter: EffectAdapter = {
  id: EVENT_EFFECT_ADAPTER_ID,
  async submit() { return {} },
  async inspect() { return { state: 'pending' } },
  async cancel() { return { state: 'cancelled' } },
}

const DEFAULT_REGISTRY = new EffectAdapterRegistry([eventAdapter])

export function defaultEffectAdapterRegistry(): EffectAdapterRegistry {
  return DEFAULT_REGISTRY
}

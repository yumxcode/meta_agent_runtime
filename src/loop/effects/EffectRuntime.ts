import type { LoopInstance } from '../instance/InstanceStore.js'
import type { WakeStore } from '../wake/WakeStore.js'
import {
  defaultEffectAdapterRegistry,
  EVENT_EFFECT_ADAPTER_ID,
  type EffectAdapterContext,
  type EffectAdapterRegistry,
  type EffectInspection,
} from './EffectAdapter.js'
import { EffectLedger, type EffectRecord, type EffectRetryPolicy } from './EffectLedger.js'
import { evaluateEffectRules, type EffectRuleDecision } from './EffectRules.js'
import type { FrozenEffectBinding } from '../charter/CharterTypes.js'

const MAX_ADAPTER_RESULT_BYTES = 1_048_576
// Host admission is durable and polls the filesystem. Keep its safety budget
// independent from the adapter execution timeout, especially for the
// best-effort cancellation that runs after an effect deadline.
const MIN_HOST_ADMISSION_TIMEOUT_MS = 1_000

export interface SubmitEffectInput {
  effectKey: string
  adapterId: string
  effectBindingId?: string
  payload?: Record<string, unknown>
  deadlineAt: number
  retryPolicy: EffectRetryPolicy
  authRequired: boolean
  admission?: { maxConcurrentCalls: number; minIntervalMs?: number }
}

export async function submitEffect(
  instance: LoopInstance,
  wakeStore: WakeStore,
  input: SubmitEffectInput,
  registry: EffectAdapterRegistry = defaultEffectAdapterRegistry(),
): Promise<EffectRecord> {
  const ledger = new EffectLedger(instance.ledger, instance.paths)
  const binding = input.effectBindingId ? instance.charter.effects[input.effectBindingId] : undefined
  if (input.effectBindingId && !binding) throw new Error(`EffectBinding '${input.effectBindingId}' is not frozen`)
  if (binding && binding.adapter !== input.adapterId) {
    throw new Error(`EffectBinding '${input.effectBindingId}' is bound to '${binding.adapter}', not '${input.adapterId}'`)
  }
  await ledger.submit({
    effectKey: input.effectKey, kind: 'adapter', waitName: 'effect_adapter',
    adapterId: input.adapterId, payload: input.payload, deadlineAt: input.deadlineAt,
    effectBindingId: input.effectBindingId,
    retryPolicy: input.retryPolicy, authRequired: input.authRequired,
    admission: {
      maxConcurrentCalls: Math.min(
        input.admission?.maxConcurrentCalls ?? 8,
        binding?.admission?.maxConcurrentCalls ?? 8,
      ),
      minIntervalMs: Math.max(
        input.admission?.minIntervalMs ?? 0,
        binding?.admission?.minIntervalMs ?? 0,
      ),
    },
  })
  await dispatchSubmit(instance, ledger, input.effectKey, registry)
  const effect = (await ledger.get(input.effectKey))!
  if (effect.status === 'concluded') {
    await wakeStore.schedule({
      loopId: instance.record.instanceId, kind: 'event',
      effectKey: effect.effectKey, fireAt: Date.now(),
    })
  } else {
    await scheduleNext(instance, wakeStore, effect)
  }
  return effect
}

/** Executes one bounded adapter transition. Never runs an LLM seat. */
export async function advanceEffect(
  instance: LoopInstance,
  wakeStore: WakeStore,
  effectKey: string,
  registry: EffectAdapterRegistry = defaultEffectAdapterRegistry(),
  operation: 'inspect' | 'reconcile' = 'inspect',
): Promise<EffectRecord | null> {
  const ledger = new EffectLedger(instance.ledger, instance.paths)
  let effect = await ledger.get(effectKey)
  if (!effect || isTerminal(effect.status)) return effect
  if (Date.now() >= effect.deadlineAt) {
    await cancelAtDeadline(instance, ledger, effect, registry)
    return ledger.get(effectKey)
  }
  if (effect.status === 'dispatching') {
    if ((effect.nextInspectAt ?? 0) <= Date.now()) {
      if (operation === 'reconcile' && registry.resolve(effect.adapterId).reconcile) {
        // A crash may have happened after the remote submit but before adapter_ack.
        // Reconcile by the stable effectKey before considering another submit.
        await runInspection(instance, ledger, effect, registry, 'reconcile')
      } else {
        await dispatchSubmit(instance, ledger, effectKey, registry)
      }
    }
  } else if (effect.status === 'retry_wait') {
    if ((effect.nextInspectAt ?? 0) <= Date.now()) {
      const retryReconcile = effect.lastOperation === 'reconcile' && registry.resolve(effect.adapterId).reconcile
      if (retryReconcile) await runInspection(instance, ledger, effect, registry, 'reconcile')
      else if (effect.adapterAcknowledged) await runInspection(instance, ledger, effect, registry, 'inspect')
      else await dispatchSubmit(instance, ledger, effectKey, registry)
    }
  } else if (effect.status === 'cancelling') {
    await runCancel(instance, ledger, effect, registry, false)
  } else {
    await runInspection(instance, ledger, effect, registry, operation)
  }
  effect = await ledger.get(effectKey)
  if (effect) await scheduleNext(instance, wakeStore, effect)
  return effect
}

export async function cancelEffect(
  instance: LoopInstance,
  effectKey: string,
  registry: EffectAdapterRegistry = defaultEffectAdapterRegistry(),
  wakeStore?: WakeStore,
): Promise<EffectRecord | null> {
  const ledger = new EffectLedger(instance.ledger, instance.paths)
  const effect = await ledger.get(effectKey)
  if (!effect || isTerminal(effect.status)) return effect
  await ledger.requestCancel(effectKey)
  await runCancel(instance, ledger, { ...effect, status: 'cancelling' }, registry, true)
  const updated = await ledger.get(effectKey)
  if (updated && wakeStore) await scheduleNext(instance, wakeStore, updated)
  return updated
}

async function dispatchSubmit(
  instance: LoopInstance,
  ledger: EffectLedger,
  effectKey: string,
  registry: EffectAdapterRegistry,
): Promise<void> {
  const effect = await ledger.get(effectKey)
  if (!effect || isTerminal(effect.status) || effect.adapterAcknowledged) return
  const adapter = registry.resolve(effect.adapterId)
  try {
    const result = await adapterCall(instance, effect, registry, signal => adapter.submit(context(instance, effect, signal)))
    validateSubmitResult(result)
    await ledger.acknowledgeAdapter(effectKey, {
      receipt: result.receipt,
      nextInspectAt: result.inspectAfterMs === undefined
        ? undefined : Date.now() + pollDelay(result.inspectAfterMs),
    })
  } catch (error) {
    await handleAdapterError(ledger, effect, 'submit', error)
  }
}

async function runInspection(
  instance: LoopInstance,
  ledger: EffectLedger,
  effect: EffectRecord,
  registry: EffectAdapterRegistry,
  operation: 'inspect' | 'reconcile',
): Promise<void> {
  const adapter = registry.resolve(effect.adapterId)
  try {
    const result = await adapterCall(instance, effect, registry, signal =>
      operation === 'reconcile' && adapter.reconcile
        ? adapter.reconcile(context(instance, effect, signal))
        : adapter.inspect(context(instance, effect, signal)))
    validateInspection(result)
    const latest = await ledger.get(effect.effectKey)
    if (!latest || isTerminal(latest.status)) return
    if (operation === 'reconcile' && result.state === 'pending') {
      await ledger.acknowledgeAdapter(effect.effectKey, {})
    }
    const binding = effectBinding(instance, effect)
    if (effect.effectBindingId && !binding) {
      await ledger.markFailed(effect.effectKey, `frozen EffectBinding '${effect.effectBindingId}' is unavailable`)
      return
    }
    if (binding) {
      const decision = evaluateEffectRules(binding, result)
      await ledger.recordRuleEvaluation(effect.effectKey, {
        bindingId: effect.effectBindingId!, ruleIndex: decision.ruleIndex,
        action: decision.action?.act ?? (decision.diagnostic?.startsWith('fail_stop:') ? 'fail_stop' : 'no_match'),
        observations: decision.observations, diagnostic: decision.diagnostic,
      })
      if (decision.diagnostic?.startsWith('fail_stop:')) {
        await ledger.markFailed(effect.effectKey, `Effect Rule fail-stop: ${decision.diagnostic.slice('fail_stop: '.length)}`)
        return
      }
      if (decision.action) {
        await applyRuleDecision(instance, ledger, effect, registry, result, decision)
        return
      }
    }
    await applyInspection(ledger, effect, result)
  } catch (error) {
    await handleAdapterError(ledger, effect, operation, error)
  }
}

async function applyRuleDecision(
  instance: LoopInstance,
  ledger: EffectLedger,
  effect: EffectRecord,
  registry: EffectAdapterRegistry,
  result: EffectInspection,
  decision: EffectRuleDecision,
): Promise<void> {
  const action = decision.action!
  const data = {
    adapterObservation: result,
    effectObservations: decision.observations,
    effectRule: { bindingId: effect.effectBindingId, ruleIndex: decision.ruleIndex },
  }
  if (action.act === 'harvest') {
    await ledger.conclude(effect.effectKey, action.verdict, 'poll', data)
    return
  }
  if (action.act === 'escalate') {
    await ledger.conclude(effect.effectKey, 'effect_rule_escalate', 'poll', { ...data, reason: action.reason })
    return
  }
  if (action.act === 'continue_waiting') {
    await ledger.recordInspection(
      effect.effectKey, data,
      Date.now() + pollDelay(result.state === 'pending'
        ? result.inspectAfterMs ?? effect.retryPolicy.baseDelayMs
        : effect.retryPolicy.baseDelayMs),
    )
    return
  }
  const adapter = registry.resolve(effect.adapterId)
  try {
    const cancellation = await adapterCall(instance, effect, registry, signal => adapter.cancel(context(instance, effect, signal)))
    validateCancellation(cancellation)
    if (cancellation.state === 'cancelled') {
      await ledger.conclude(effect.effectKey, action.verdict, 'poll', {
        ...data, cancellation: 'confirmed', cancellationData: cancellation.data,
      })
    } else {
      await ledger.markFailed(
        effect.effectKey,
        cancellation.state === 'failed'
          ? `Effect Rule cancellation failed: ${cancellation.reason}`
          : 'Effect Rule cancellation remains pending; operator reconciliation required',
      )
    }
  } catch (error) {
    await ledger.markFailed(
      effect.effectKey,
      `Effect Rule cancellation unconfirmed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function effectBinding(instance: LoopInstance, effect: EffectRecord): FrozenEffectBinding | null {
  return effect.effectBindingId ? instance.charter.effects[effect.effectBindingId] ?? null : null
}

async function applyInspection(
  ledger: EffectLedger,
  effect: EffectRecord,
  result: EffectInspection,
): Promise<void> {
  if (result.state === 'pending') {
    await ledger.recordInspection(
      effect.effectKey, result.data,
      Date.now() + pollDelay(result.inspectAfterMs ?? effect.retryPolicy.baseDelayMs),
    )
  } else {
    await ledger.conclude(effect.effectKey, result.verdict, 'poll', result.data)
  }
}

async function cancelAtDeadline(
  instance: LoopInstance,
  ledger: EffectLedger,
  effect: EffectRecord,
  registry: EffectAdapterRegistry,
): Promise<void> {
  const adapter = registry.resolve(effect.adapterId)
  try {
    const result = await adapterCall(
      instance, effect, registry, signal => adapter.cancel(context(instance, effect, signal)), true,
    )
    validateCancellation(result)
    if (result.state === 'cancelled') {
      await ledger.conclude(effect.effectKey, 'deadline_exceeded', 'poll', {
        cancellation: 'confirmed', deadlineAt: effect.deadlineAt, data: result.data,
      })
    } else {
      await ledger.markFailed(
        effect.effectKey,
        result.state === 'failed'
          ? `deadline cancellation failed: ${result.reason}`
          : 'deadline cancellation remains pending; operator reconciliation required',
      )
    }
  } catch (error) {
    await ledger.markFailed(
      effect.effectKey,
      `deadline cancellation unconfirmed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function runCancel(
  instance: LoopInstance,
  ledger: EffectLedger,
  effect: EffectRecord,
  registry: EffectAdapterRegistry,
  terminalCancel: boolean,
): Promise<void> {
  const adapter = registry.resolve(effect.adapterId)
  try {
    const result = await adapterCall(instance, effect, registry, signal => adapter.cancel(context(instance, effect, signal)))
    validateCancellation(result)
    if (result.state === 'cancelled') await ledger.markCancelled(effect.effectKey, result.data)
    else if (result.state === 'failed') await ledger.markFailed(effect.effectKey, result.reason)
    else await ledger.recordInspection(
      effect.effectKey, result.data,
      Date.now() + pollDelay(result.inspectAfterMs ?? effect.retryPolicy.baseDelayMs),
    )
  } catch (error) {
    if (terminalCancel) await handleAdapterError(ledger, effect, 'cancel', error)
    else await handleAdapterError(ledger, effect, 'cancel-reconcile', error)
  }
}

async function handleAdapterError(
  ledger: EffectLedger,
  effect: EffectRecord,
  operation: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  const exhausted = effect.attempts >= effect.retryPolicy.maxAttempts || Date.now() >= effect.deadlineAt
  if (exhausted) {
    await ledger.conclude(effect.effectKey, 'adapter_error', 'poll', { operation, message })
    return
  }
  const delay = Math.min(
    effect.retryPolicy.maxDelayMs,
    effect.retryPolicy.baseDelayMs * 2 ** Math.max(0, effect.attempts - 1),
  )
  await ledger.recordAdapterError(effect.effectKey, operation, message, Date.now() + pollDelay(delay))
}

async function scheduleNext(
  instance: LoopInstance,
  wakeStore: WakeStore,
  effect: EffectRecord,
): Promise<void> {
  if (isTerminal(effect.status)) return
  const fireAt = effect.nextInspectAt ?? (
    effect.adapterId === EVENT_EFFECT_ADAPTER_ID ? undefined : effect.deadlineAt
  )
  if (fireAt === undefined) return
  await wakeStore.schedule({
    loopId: instance.record.instanceId, kind: 'effect_poll',
    effectKey: effect.effectKey, fireAt: Math.min(fireAt, effect.deadlineAt),
  })
}

function context(instance: LoopInstance, effect: EffectRecord, signal: AbortSignal): EffectAdapterContext {
  const workspaceId = instance.record.workspaceId
  if (!workspaceId) throw new Error(`instance ${instance.record.instanceId} has no workspace identity`)
  return {
    workspaceId,
    instanceId: instance.record.instanceId,
    effectKey: effect.effectKey,
    externalIdempotencyKey: `${workspaceId}/${instance.record.instanceId}/${effect.effectKey}`,
    payload: effect.payload, receipt: effect.receipt,
    attempt: effect.attempts, deadlineAt: effect.deadlineAt, signal,
  }
}

async function adapterCall<T>(
  instance: LoopInstance,
  effect: EffectRecord,
  registry: EffectAdapterRegistry,
  call: (signal: AbortSignal) => Promise<T>,
  allowPastDeadline = false,
): Promise<T> {
  const executionTimeoutMs = allowPastDeadline
    ? Math.max(1, effect.retryPolicy.callTimeoutMs)
    : Math.max(1, Math.min(
        effect.retryPolicy.callTimeoutMs,
        Math.max(1, effect.deadlineAt - Date.now()),
      ))
  const admissionTimeoutMs = allowPastDeadline
    ? Math.max(MIN_HOST_ADMISSION_TIMEOUT_MS, effect.retryPolicy.callTimeoutMs)
    : Math.max(1, effect.deadlineAt - Date.now())
  const admissionController = new AbortController()
  let admissionTimer: ReturnType<typeof setTimeout> | undefined
  try {
    admissionTimer = setTimeout(() => {
      admissionController.abort(new Error(
        `EffectAdapter '${effect.adapterId}' admission timed out after ${admissionTimeoutMs}ms`,
      ))
    }, admissionTimeoutMs)
    admissionTimer.unref?.()
    const result = await registry.runWithAdmission(
      effect.adapterId,
      effect.admission,
      admissionController.signal,
      async () => {
        if (admissionTimer) clearTimeout(admissionTimer)
        admissionTimer = undefined
        const executionController = new AbortController()
        let executionTimer: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            call(executionController.signal),
            new Promise<never>((_, reject) => {
              executionTimer = setTimeout(() => {
                executionController.abort(new Error('EffectAdapter call timed out'))
                reject(new Error(
                  `EffectAdapter '${effect.adapterId}' timed out after ${executionTimeoutMs}ms`,
                ))
              }, executionTimeoutMs)
              executionTimer.unref?.()
            }),
          ])
        } finally {
          if (executionTimer) clearTimeout(executionTimer)
        }
      },
      {
        workspaceId: instance.record.workspaceId!,
        instanceId: instance.record.instanceId,
      },
    )
    const encoded = JSON.stringify(result)
    if (encoded === undefined) throw new Error(`EffectAdapter '${effect.adapterId}' returned a non-JSON value`)
    if (Buffer.byteLength(encoded, 'utf-8') > MAX_ADAPTER_RESULT_BYTES) {
      throw new Error(`EffectAdapter '${effect.adapterId}' result exceeds ${MAX_ADAPTER_RESULT_BYTES} bytes`)
    }
    return result
  } finally {
    if (admissionTimer) clearTimeout(admissionTimer)
  }
}

function pollDelay(value: number): number {
  return Math.max(10, Math.min(24 * 60 * 60_000, Math.floor(value)))
}

function isTerminal(status: EffectRecord['status']): boolean {
  return ['concluded', 'harvested', 'cancelled', 'failed'].includes(status)
}

function validateSubmitResult(value: unknown): asserts value is {
  receipt?: Record<string, unknown>; inspectAfterMs?: number
} {
  if (!isRecord(value) || (value.receipt !== undefined && !isRecord(value.receipt)) ||
      (value.inspectAfterMs !== undefined && !validDelay(value.inspectAfterMs))) {
    throw new Error('EffectAdapter submit returned an invalid result')
  }
}

function validateInspection(value: unknown): asserts value is EffectInspection {
  if (!isRecord(value) || !['pending', 'succeeded', 'failed'].includes(String(value.state))) {
    throw new Error('EffectAdapter inspect/reconcile returned an invalid result')
  }
  if (value.state === 'pending') {
    if (value.inspectAfterMs !== undefined && !validDelay(value.inspectAfterMs)) {
      throw new Error('EffectAdapter inspection returned an invalid inspectAfterMs')
    }
  } else if (typeof value.verdict !== 'string' || !value.verdict) {
    throw new Error('EffectAdapter terminal inspection requires a verdict')
  }
}

function validateCancellation(value: unknown): asserts value is {
  state: 'cancelled' | 'pending' | 'failed'; inspectAfterMs?: number; data?: unknown; reason?: string
} {
  if (!isRecord(value) || !['cancelled', 'pending', 'failed'].includes(String(value.state))) {
    throw new Error('EffectAdapter cancel returned an invalid result')
  }
  if (value.state === 'pending' && value.inspectAfterMs !== undefined && !validDelay(value.inspectAfterMs)) {
    throw new Error('EffectAdapter cancellation returned an invalid inspectAfterMs')
  }
  if (value.state === 'failed' && (typeof value.reason !== 'string' || !value.reason)) {
    throw new Error('EffectAdapter failed cancellation requires a reason')
  }
}

function validDelay(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

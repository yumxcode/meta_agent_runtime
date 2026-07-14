import { mkdtemp, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'
import type { Charter, EffectBinding } from '../../charter/CharterTypes.js'
import { createInstance } from '../../instance/InstanceStore.js'
import { WakeStore } from '../../wake/WakeStore.js'
import {
  EffectAdapterRegistry,
  type EffectAdapter,
} from '../EffectAdapter.js'
import { EffectLedger } from '../EffectLedger.js'
import { advanceEffect, cancelEffect, submitEffect } from '../EffectRuntime.js'
import { eventAuthSecretPath, signEffectEvent, verifyEffectEvent } from '../EventAuth.js'

const retryPolicy = {
  maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 20, callTimeoutMs: 50,
}

function charter(id: string, effects?: Record<string, EffectBinding>): Charter {
  return {
    id, version: 1, goal: 'exercise effect adapter ABI', observables: [],
    meters: [{ name: 'iteration', inc: 'every_round' }],
    tripwires: [{ when: 'iteration >= 1', then: { act: 'finalize' } }],
    gates: {}, seats: { worker: { context: 'lineage_round', prompt: 'work' } },
    ...(effects ? { effects } : {}),
  }
}

async function fixture(name: string, effects?: Record<string, EffectBinding>) {
  const projectDir = await mkdtemp(join(tmpdir(), `${name}-`))
  const wakeStore = new WakeStore(projectDir)
  const instance = await createInstance({
    projectDir, instanceId: `${name}-v1`, charter: charter(name, effects), wakeStore,
  })
  return { projectDir, wakeStore, instance, ledger: new EffectLedger(instance.ledger, instance.paths) }
}

describe('EffectAdapter ABI', () => {
  it('registers adapters deterministically and rejects duplicate/unknown ids', () => {
    const adapter = pendingAdapter('test/registry@1')
    const registry = new EffectAdapterRegistry([adapter])
    expect(registry.ids()).toEqual(['test/registry@1'])
    expect(registry.resolve(adapter.id)).toBe(adapter)
    expect(() => registry.register(adapter)).toThrow(/already registered/)
    expect(() => registry.resolve('missing')).toThrow(/not registered/)
  })

  it('admits adapter calls FIFO under host-wide concurrency and pacing bounds', async () => {
    const adapter = { ...pendingAdapter('test/admission@1'), admission: { maxConcurrentCalls: 1, minIntervalMs: 8 } }
    const registry = new EffectAdapterRegistry([adapter])
    let active = 0
    let maxActive = 0
    const starts: number[] = []
    const order: number[] = []
    const run = (id: number) => registry.runWithAdmission(
      adapter.id, undefined, new AbortController().signal, async () => {
        active++
        maxActive = Math.max(maxActive, active)
        starts.push(Date.now())
        order.push(id)
        await delay(10)
        active--
        return id
      },
    )
    expect(await Promise.all([run(1), run(2), run(3)])).toEqual([1, 2, 3])
    expect(order).toEqual([1, 2, 3])
    expect(maxActive).toBe(1)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(8)
  })

  it('binds adapter idempotency and authenticated events to the full workspace scope', async () => {
    const a = await fixture('effect-scope-a')
    const b = await fixture('effect-scope-b')
    let observed: { workspaceId: string; instanceId: string; externalIdempotencyKey: string } | undefined
    const adapter: EffectAdapter = {
      ...pendingAdapter('test/scoped@1'),
      async submit(context) {
        observed = context
        return {}
      },
    }
    await submitEffect(a.instance, a.wakeStore, input('same-key', adapter.id), new EffectAdapterRegistry([adapter]))
    expect(observed).toMatchObject({
      workspaceId: a.instance.record.workspaceId,
      instanceId: a.instance.record.instanceId,
      externalIdempotencyKey: `${a.instance.record.workspaceId}/${a.instance.record.instanceId}/same-key`,
    })
    const event = await signEffectEvent(a.instance, {
      principal: 'alice', roles: ['approver'], effectKey: 'same-key', verdict: 'approved',
    })
    await expect(verifyEffectEvent(b.instance, event)).resolves.toEqual({
      ok: false, reason: 'authenticated event workspace/instance scope mismatch',
    })
  })

  it('uses one ledger CAS for poll/event first-wins in both orders', async () => {
    const { instance, wakeStore, ledger } = await fixture('effect-first-wins')
    let inspections = 0
    const adapter: EffectAdapter = {
      ...pendingAdapter('test/first-wins@1'),
      async submit() { return { receipt: { remoteId: 'r-1' }, inspectAfterMs: 10 } },
      async inspect() {
        inspections++
        return { state: 'succeeded', verdict: 'remote_done', data: { source: 'poll' } }
      },
    }
    const registry = new EffectAdapterRegistry([adapter])
    await submitEffect(instance, wakeStore, input('poll-first', adapter.id), registry)
    await advanceEffect(instance, wakeStore, 'poll-first', registry)
    expect(await ledger.conclude('poll-first', 'late_event', 'event')).toBe(false)
    expect((await ledger.get('poll-first'))?.outcome).toMatchObject({ verdict: 'remote_done', via: 'poll' })

    await submitEffect(instance, wakeStore, input('event-first', adapter.id), registry)
    expect(await ledger.conclude('event-first', 'approved', 'event', { source: 'event' })).toBe(true)
    await advanceEffect(instance, wakeStore, 'event-first', registry)
    expect((await ledger.get('event-first'))?.outcome).toMatchObject({ verdict: 'approved', via: 'event' })
    expect(inspections).toBe(1)
  })

  it('evaluates a frozen typed Effect Rule and audits the first-match decision', async () => {
    const adapterId = 'test/rules@1'
    const { instance, wakeStore, ledger } = await fixture('effect-runtime-rules', {
      training: {
        adapter: adapterId,
        observations: {
          state: { pointer: '/state', type: 'string' },
          balance: { pointer: '/data/balance', type: 'number' },
        },
        rules: [{
          when: 'balance <= 0',
          then: { act: 'cancel_and_harvest', verdict: 'balance_exhausted' },
          onAbsent: 'fail_stop', onError: 'fail_stop',
        }],
      },
    })
    let cancellations = 0
    const adapter: EffectAdapter = {
      ...pendingAdapter(adapterId),
      async submit() { return { inspectAfterMs: 10 } },
      async inspect() { return { state: 'pending', data: { balance: 0 }, inspectAfterMs: 10 } },
      async cancel() { cancellations++; return { state: 'cancelled', data: { remote: 'stopped' } } },
    }
    const registry = new EffectAdapterRegistry([adapter])
    await submitEffect(instance, wakeStore, {
      ...input('rule-effect', adapter.id), effectBindingId: 'training',
    }, registry)
    await advanceEffect(instance, wakeStore, 'rule-effect', registry)
    const effect = await ledger.get('rule-effect')
    expect(cancellations).toBe(1)
    expect(effect?.outcome).toMatchObject({ verdict: 'balance_exhausted', via: 'poll' })
    expect(effect?.ruleEvaluations).toEqual([expect.objectContaining({
      bindingId: 'training', ruleIndex: 0, action: 'cancel_and_harvest',
      observations: { state: 'pending', balance: 0 },
    })])
  })

  it('retries bounded submit calls with the same stable effectKey', async () => {
    const { instance, wakeStore, ledger } = await fixture('effect-retry')
    const keys: string[] = []
    const adapter: EffectAdapter = {
      ...pendingAdapter('test/retry@1'),
      async submit(context) {
        keys.push(context.effectKey)
        if (keys.length < 3) throw new Error(`transient-${keys.length}`)
        return { receipt: { remoteId: 'one-logical-job' } }
      },
    }
    const registry = new EffectAdapterRegistry([adapter])
    await submitEffect(instance, wakeStore, input('stable-key', adapter.id), registry)
    await delay(25)
    await advanceEffect(instance, wakeStore, 'stable-key', registry)
    await delay(45)
    await advanceEffect(instance, wakeStore, 'stable-key', registry)
    expect(keys).toEqual(['stable-key', 'stable-key', 'stable-key'])
    expect(await ledger.get('stable-key')).toMatchObject({ status: 'submitted', attempts: 3 })
  })

  it('retries inspect without resubmitting even when submit returned no receipt', async () => {
    const { instance, wakeStore, ledger } = await fixture('effect-inspect-retry')
    let submits = 0
    let inspections = 0
    const adapter: EffectAdapter = {
      ...pendingAdapter('test/inspect-retry@1'),
      async submit() { submits++; return { inspectAfterMs: 10 } },
      async inspect() {
        inspections++
        if (inspections === 1) throw new Error('transient inspect failure')
        return { state: 'succeeded', verdict: 'done' }
      },
    }
    const registry = new EffectAdapterRegistry([adapter])
    await submitEffect(instance, wakeStore, input('inspect-retry', adapter.id), registry)
    await advanceEffect(instance, wakeStore, 'inspect-retry', registry)
    await delay(12)
    await advanceEffect(instance, wakeStore, 'inspect-retry', registry)
    expect({ submits, inspections }).toEqual({ submits: 1, inspections: 2 })
    expect((await ledger.get('inspect-retry'))?.outcome?.verdict).toBe('done')
  })

  it('bounds a hung adapter call and concludes after retry exhaustion', async () => {
    const { instance, wakeStore, ledger } = await fixture('effect-timeout')
    const adapter: EffectAdapter = {
      ...pendingAdapter('test/timeout@1'),
      async submit(context) {
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
        })
        return {}
      },
    }
    const registry = new EffectAdapterRegistry([adapter])
    await submitEffect(instance, wakeStore, {
      ...input('timeout', adapter.id),
      retryPolicy: { ...retryPolicy, maxAttempts: 1, callTimeoutMs: 10 },
    }, registry)
    expect((await ledger.get('timeout'))?.outcome).toMatchObject({ verdict: 'adapter_error', via: 'poll' })
    expect((await wakeStore.list()).some(wake =>
      wake.kind === 'event' && wake.effectKey === 'timeout' && wake.status === 'pending',
    )).toBe(true)
  })

  it('rejects invalid adapter output and wakes a non-polling adapter at its deadline', async () => {
    const { instance, wakeStore, ledger } = await fixture('effect-deadline')
    let cancellations = 0
    const adapter: EffectAdapter = {
      ...pendingAdapter('test/deadline@1'),
      async submit() { return {} },
      async cancel() { cancellations++; return { state: 'cancelled' } },
    }
    const registry = new EffectAdapterRegistry([adapter])
    // Leave room for the durable host-admission filesystem round-trip; the
    // property under test is deadline scheduling/cancellation, not sub-10ms latency.
    const deadlineAt = Date.now() + 100
    await submitEffect(instance, wakeStore, {
      ...input('deadline', adapter.id), deadlineAt,
    }, registry)
    expect((await wakeStore.list()).some(wake =>
      wake.kind === 'effect_poll' && wake.effectKey === 'deadline' && wake.fireAt === deadlineAt,
    )).toBe(true)
    await delay(120)
    await advanceEffect(instance, wakeStore, 'deadline', registry)
    expect(cancellations).toBe(1)
    expect((await ledger.get('deadline'))?.outcome?.verdict).toBe('deadline_exceeded')

    const invalid: EffectAdapter = {
      ...pendingAdapter('test/invalid@1'),
      async submit() { return null as never },
    }
    await submitEffect(instance, wakeStore, {
      ...input('invalid', invalid.id),
      retryPolicy: { ...retryPolicy, maxAttempts: 1 },
    }, new EffectAdapterRegistry([invalid]))
    expect((await ledger.get('invalid'))?.outcome?.verdict).toBe('adapter_error')
  })

  it('fail-stops an effect when deadline cancellation is not confirmed', async () => {
    const { instance, wakeStore, ledger } = await fixture('effect-cancel-unconfirmed')
    const adapter: EffectAdapter = {
      ...pendingAdapter('test/cancel-unconfirmed@1'),
      async submit() { return {} },
      async cancel() { return { state: 'pending', inspectAfterMs: 10 } },
    }
    const registry = new EffectAdapterRegistry([adapter])
    const deadlineAt = Date.now() + 100
    await submitEffect(instance, wakeStore, {
      ...input('cancel-unconfirmed', adapter.id), deadlineAt,
    }, registry)
    await delay(Math.max(0, deadlineAt - Date.now()) + 20)
    await advanceEffect(instance, wakeStore, 'cancel-unconfirmed', registry)
    expect(await ledger.get('cancel-unconfirmed')).toMatchObject({
      status: 'failed', lastError: expect.stringContaining('operator reconciliation required'),
    })
  })

  it('reconciles ambiguous dispatch before resubmitting and supports cancellation', async () => {
    const { instance, wakeStore, ledger } = await fixture('effect-reconcile')
    let submits = 0
    let reconciles = 0
    const adapter: EffectAdapter = {
      ...pendingAdapter('test/reconcile@1'),
      async submit() { submits++; return { receipt: { remoteId: 'r' } } },
      async reconcile(context) {
        reconciles++
        expect(context.effectKey).toBe('ambiguous')
        return { state: 'succeeded', verdict: 'recovered' }
      },
    }
    const registry = new EffectAdapterRegistry([adapter])
    await ledger.submit({
      effectKey: 'ambiguous', kind: 'adapter', waitName: 'effect_adapter', adapterId: adapter.id,
      deadlineAt: Date.now() + 10_000, retryPolicy, authRequired: false,
    })
    await advanceEffect(instance, wakeStore, 'ambiguous', registry, 'reconcile')
    expect({ submits, reconciles }).toEqual({ submits: 0, reconciles: 1 })
    expect((await ledger.get('ambiguous'))?.outcome?.verdict).toBe('recovered')

    await submitEffect(instance, wakeStore, input('cancel-me', adapter.id), registry)
    await cancelEffect(instance, 'cancel-me', registry)
    expect((await ledger.get('cancel-me'))?.status).toBe('cancelled')
  })

  it('keeps approval signing material outside the instance workspace', async () => {
    const { projectDir, instance } = await fixture('effect-auth-secret')
    const secretPath = eventAuthSecretPath(instance.paths)
    expect(relative(projectDir, secretPath).startsWith('..')).toBe(true)
    await expect(stat(secretPath)).rejects.toBeTruthy()
    await expect(signEffectEvent(instance, {
      principal: 'alice', roles: ['approver'], effectKey: ' ', verdict: 'approved',
    })).rejects.toThrow(/effectKey must be/)
    // Invalid host input is rejected before any signing material is created.
    await expect(stat(secretPath)).rejects.toBeTruthy()
    await signEffectEvent(instance, {
      principal: 'alice', roles: ['approver'], effectKey: 'x', verdict: 'approved',
    })
    expect((await stat(secretPath)).mode & 0o777).toBe(0o600)
    await expect(signEffectEvent(instance, {
      principal: 'alice', roles: ['approver'], effectKey: 'x', verdict: 'approved',
      nonce: '../../escape',
    })).rejects.toThrow(/nonce is invalid/)
  })
})

function pendingAdapter(id: string): EffectAdapter {
  return {
    id,
    async submit() { return {} },
    async inspect() { return { state: 'pending', inspectAfterMs: 10 } },
    async cancel() { return { state: 'cancelled' } },
  }
}

function input(effectKey: string, adapterId: string) {
  return {
    effectKey, adapterId, deadlineAt: Date.now() + 10_000,
    retryPolicy, authRequired: false,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

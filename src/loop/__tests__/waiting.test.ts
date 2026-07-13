/**
 * The waiting round (event-driven): submit segment → the worker parks on an
 * EVENT (no code probe), an external system drops an events/ file to conclude
 * it → harvest segment resumes the SAME round. Plus event idempotency and the
 * RECONCILE crash matrix. Seats are scripted.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import type { SubAgentRecord } from '../../subagent/types.js'
import { makeSubAgentTaskId } from '../../subagent/types.js'
import { createInstance, loadInstance, setInstanceStatus } from '../instance/InstanceStore.js'
import { WakeStore } from '../wake/WakeStore.js'
import { tickOnce } from '../runner.js'
import { instancePaths, type RoundEntry } from '../types.js'
import { EffectLedger } from '../effects/EffectLedger.js'
import { Ledger } from '../ledger/LedgerApi.js'
import { reconcileWaiting, readPendingRound, writePendingRound } from '../effects/WaitOps.js'
import { EffectAdapterRegistry, type EffectAdapter } from '../effects/EffectAdapter.js'
import { walkResearchCharter } from './testCharter.js'

type SeatScript = (task: string) => Promise<Record<string, unknown>>

function scriptedDispatcher(script: SeatScript): ISubAgentDispatcher & { spawns: string[] } {
  const spawns: string[] = []
  return {
    spawns,
    async spawnSubAgent({ config }) {
      spawns.push(config.taskDescription)
      const output = await script(config.taskDescription)
      return {
        schemaVersion: '1.0', taskId: makeSubAgentTaskId(), parentSessionId: 't',
        status: 'completed', config: config as SubAgentRecord['config'],
        createdAt: Date.now(), completedAt: Date.now(), pendingHumanApproval: false,
        result: {
          success: true, summary: 'scripted', output,
          turnsUsed: 1, inputTokens: 0, outputTokens: 0, costUsd: 0.1, durationMs: 1,
        },
      } satisfies SubAgentRecord
    },
    async getStatus() { return null },
    async cancelTask() { return true },
  }
}

const isWorker = (t: string) => t.includes('产出契约')
const isJudge = (t: string) => t.includes('隔离评审座位')
const isHarvest = (t: string) => t.includes('收割段')

async function pump(
  deps: { dispatcher: ISubAgentDispatcher; projectDir: string },
  cond: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await tickOnce(deps)
    if (await cond()) return
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error('pump timed out')
}

function setup(charterOverrides?: Parameters<typeof walkResearchCharter>[0]) {
  return (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-wait-'))
    const paths = instancePaths(dir, 'walk-research-v1')
    const charter = walkResearchCharter({
      tripwires: [{ when: 'iteration >= 1', then: { act: 'finalize' } }],
      ...charterOverrides,
    })
    await createInstance({ projectDir: dir, charter, wakeStore: new WakeStore(dir) })
    return { dir, paths }
  })()
}

/** Submit an event wait, then (on resume) harvest with drafts + a passing judge. */
function trainingScript(paths: ReturnType<typeof instancePaths>): SeatScript {
  return async task => {
    if (isWorker(task) && !isHarvest(task)) {
      return { label: 'wait', effectKey: 'exp-42', payload: { taskId: 'gm-1' }, note: '提交了 exp-42' }
    }
    if (isHarvest(task)) {
      await mkdir(paths.draftsDir, { recursive: true })
      await writeFile(join(paths.draftsDir, 'direction.json'), JSON.stringify({ key: 'dir-1' }), 'utf-8')
      await writeFile(join(paths.draftsDir, 'findings_draft.json'),
        JSON.stringify([{ claim: 'trained to 0.61', evidence: 'curve' }]), 'utf-8')
      return { label: 'ok' }
    }
    if (isJudge(task)) {
      return { verdict: 'pass', new_findings_count: 1, metric_delta: 0.1, metric: 0.61, messages: [] }
    }
    throw new Error('unexpected seat: ' + task.slice(0, 40))
  }
}

async function dropEvent(paths: ReturnType<typeof instancePaths>, name: string, body: unknown): Promise<void> {
  await mkdir(paths.eventsDir, { recursive: true })
  await writeFile(join(paths.eventsDir, name), JSON.stringify(body), 'utf-8')
}

describe('waiting rounds — event driven', () => {
  it('effect_poll advances hard state without spawning an LLM seat until terminal', async () => {
    const { dir, paths } = await setup({
      effects: {
        kernel_poll: {
          adapter: 'test/kernel-poll@1', observations: {}, rules: [],
          admission: { maxConcurrentCalls: 1 },
        },
      },
    })
    const base = trainingScript(paths)
    const dispatcher = scriptedDispatcher(async task => {
      const result = await base(task)
      return isWorker(task) && !isHarvest(task)
        ? { ...result, adapterId: 'test/kernel-poll@1' }
        : result
    })
    let inspections = 0
    const adapter: EffectAdapter = {
      id: 'test/kernel-poll@1',
      async submit() { return { inspectAfterMs: 10 } },
      async inspect() {
        inspections++
        return inspections === 1
          ? { state: 'pending', inspectAfterMs: 10 }
          : { state: 'succeeded', verdict: 'done', data: { final: 0.61 } }
      },
      async cancel() { return { state: 'cancelled' } },
    }
    const deps = {
      dispatcher, projectDir: dir,
      effectAdapters: new EffectAdapterRegistry([adapter]),
    }
    await tickOnce(deps)
    expect(dispatcher.spawns).toHaveLength(1)
    await new Promise(resolve => setTimeout(resolve, 12))
    await tickOnce(deps)
    expect(inspections).toBe(1)
    expect(dispatcher.spawns).toHaveLength(1)
    await new Promise(resolve => setTimeout(resolve, 12))
    await pump(deps, async () => JSON.parse(await readFile(paths.instanceJson, 'utf-8')).status === 'done')
    expect(inspections).toBe(2)
    expect(dispatcher.spawns.filter(isHarvest)).toHaveLength(1)
  })

  it('routes a frozen Effect Rule escalation directly to paused_attention', async () => {
    const { dir, paths } = await setup({
      effects: {
        quota_guard: {
          adapter: 'test/quota@1',
          observations: { exhausted: { pointer: '/data/exhausted', type: 'boolean' } },
          rules: [{
            when: 'exhausted', then: { act: 'escalate', reason: 'remote quota exhausted' },
            onAbsent: 'fail_stop', onError: 'fail_stop',
          }],
          admission: { maxConcurrentCalls: 1 },
        },
      },
    })
    const dispatcher = scriptedDispatcher(async task => {
      if (isWorker(task) && !isHarvest(task)) {
        return { label: 'wait', effectKey: 'quota-job', effectBinding: 'quota_guard' }
      }
      throw new Error('Effect Rule escalation must not spawn another seat')
    })
    const adapter: EffectAdapter = {
      id: 'test/quota@1',
      async submit() { return { inspectAfterMs: 10 } },
      async inspect() { return { state: 'pending', data: { exhausted: true }, inspectAfterMs: 10 } },
      async cancel() { return { state: 'cancelled' } },
    }
    const deps = {
      dispatcher, projectDir: dir,
      effectAdapters: new EffectAdapterRegistry([adapter]),
    }
    await tickOnce(deps)
    await new Promise(resolve => setTimeout(resolve, 12))
    const tick = await tickOnce(deps)
    expect(tick.outcomes[0]?.outcome).toMatchObject({
      route: 'escalate:remote quota exhausted', status: 'paused_attention',
    })
    expect(JSON.parse(await readFile(paths.instanceJson, 'utf-8')).status).toBe('paused_attention')
    expect(dispatcher.spawns).toHaveLength(1)
  })

  it('fail-stops immediately when a frozen EffectBinding has no host adapter registration', async () => {
    const { dir, paths } = await setup({
      effects: {
        unavailable: {
          adapter: 'test/unavailable@1', observations: {}, rules: [],
          admission: { maxConcurrentCalls: 1 },
        },
      },
    })
    const dispatcher = scriptedDispatcher(async task => {
      if (isWorker(task)) return {
        label: 'wait', effectKey: 'unavailable-job', effectBinding: 'unavailable',
      }
      throw new Error('host configuration errors are not model-correctable')
    })
    const tick = await tickOnce({ projectDir: dir, dispatcher })
    expect(tick.outcomes[0]?.error).toContain("EffectAdapter 'test/unavailable@1' is not registered")
    expect(JSON.parse(await readFile(paths.instanceJson, 'utf-8'))).toMatchObject({
      status: 'failed', statusReason: expect.stringContaining('effect configuration failed'),
    })
    expect(dispatcher.spawns).toHaveLength(1)
    expect((await new WakeStore(dir).list()).filter(wake =>
      wake.status === 'pending' || wake.status === 'claimed',
    )).toHaveLength(0)
  })

  it('submit(event wait) → external event concludes → harvest completes the SAME round', async () => {
    const { dir, paths } = await setup()
    const dispatcher = scriptedDispatcher(trainingScript(paths))
    const deps = { dispatcher, projectDir: dir }
    const effects = new EffectLedger(new Ledger(paths), paths)

    // Tick 1: submit → waiting on an event (no probe scheduled).
    await tickOnce(deps)
    expect((await readPendingRound((await loadInstance(dir, 'walk-research-v1'))!))!.round).toBe(1)
    expect(JSON.parse(await readFile(paths.instanceJson, 'utf-8')).status).toBe('waiting')
    expect(dispatcher.spawns.filter(isHarvest)).toHaveLength(0)

    // External system drops a completion event → conclude → harvest.
    await dropEvent(paths, 'evt-1.json', { effectKey: 'exp-42', verdict: 'done', data: { final: 0.61 } })
    await pump(deps, async () => JSON.parse(await readFile(paths.instanceJson, 'utf-8')).status === 'done')

    const rounds = (await readFile(paths.roundsJsonl, 'utf-8')).trim().split('\n').map(l => JSON.parse(l) as RoundEntry)
    expect(rounds).toHaveLength(1)
    expect(rounds[0]!.round).toBe(1)
    expect(rounds[0]!.route).toMatchObject({ kind: 'finalize', cause: 'tripwire' })
    expect((await effects.get('exp-42'))!.status).toBe('harvested')
    expect(await readPendingRound((await loadInstance(dir, 'walk-research-v1'))!)).toBeNull()
    const harvestTask = dispatcher.spawns.find(isHarvest)!
    expect(harvestTask).toContain('提交段摘要')
    expect(harvestTask).toContain('done')
  })

  it('duplicate events cannot double-harvest', async () => {
    const { dir, paths } = await setup()
    const dispatcher = scriptedDispatcher(trainingScript(paths))
    const deps = { dispatcher, projectDir: dir }
    await tickOnce(deps) // submit → waiting
    await dropEvent(paths, 'a.json', { effectKey: 'exp-42', verdict: 'done' })
    await dropEvent(paths, 'b.json', { effectKey: 'exp-42', verdict: 'done' })
    await pump(deps, async () => JSON.parse(await readFile(paths.instanceJson, 'utf-8')).status === 'done')
    expect(dispatcher.spawns.filter(isHarvest)).toHaveLength(1)
    const rounds = (await readFile(paths.roundsJsonl, 'utf-8')).trim().split('\n')
    expect(rounds).toHaveLength(1)
  })

  it('a coalesced timer during waiting does not start a new round', async () => {
    const { dir, paths } = await setup()
    const dispatcher = scriptedDispatcher(trainingScript(paths))
    const deps = { dispatcher, projectDir: dir }
    await tickOnce(deps) // waiting on event
    await new WakeStore(dir).schedule({ loopId: 'walk-research-v1', kind: 'timer', fireAt: Date.now() })
    await tickOnce(deps)
    expect(JSON.parse(await readFile(paths.instanceJson, 'utf-8')).status).toBe('waiting')
    expect(dispatcher.spawns.filter(t => isWorker(t) && !isHarvest(t))).toHaveLength(1)
  })
})

describe('waiting rounds — RECONCILE crash matrix', () => {
  async function crashedInstance() {
    const { dir, paths } = await setup()
    const dispatcher = scriptedDispatcher(trainingScript(paths))
    await tickOnce({ dispatcher, projectDir: dir }) // reach waiting state
    const instance = (await loadInstance(dir, 'walk-research-v1'))!
    const wakeStore = new WakeStore(dir)
    const effects = new EffectLedger(new Ledger(paths), paths)
    return { dir, paths, instance, wakeStore, effects, dispatcher }
  }

  it('fail-stops in the same reconciliation pass when recovered typed observations are invalid', async () => {
    const { dir, paths } = await setup({
      effects: {
        recovered: {
          adapter: 'test/recovered@1',
          observations: { balance: { pointer: '/data/balance', type: 'number' } },
          rules: [{
            when: 'balance <= 0', then: { act: 'harvest', verdict: 'empty' },
            onAbsent: 'fail_stop', onError: 'fail_stop',
          }],
        },
      },
    })
    const instance = (await loadInstance(dir, 'walk-research-v1'))!
    const wakeStore = new WakeStore(dir)
    await wakeStore.cancelForLoop(instance.record.instanceId)
    const effects = new EffectLedger(new Ledger(paths), paths)
    await effects.submit({
      effectKey: 'recovered-job', kind: 'adapter', waitName: 'effect_adapter',
      adapterId: 'test/recovered@1', effectBindingId: 'recovered',
      deadlineAt: Date.now() + 60_000,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 20, callTimeoutMs: 100 },
    })
    await writePendingRound(instance, {
      round: 1, mode: 'normal', kind: 'effect', effectKey: 'recovered-job',
      waitName: 'event', expiresAt: Date.now() + 60_000, startedAt: Date.now(),
      costUsdSoFar: 0, seatSummaries: {}, correctiveRetries: 0,
      submitSummary: 'crashed after remote submit', createdAt: Date.now(),
    })
    await setInstanceStatus(instance, 'waiting')
    const adapter: EffectAdapter = {
      id: 'test/recovered@1',
      async submit() { throw new Error('must reconcile before any resubmit') },
      async inspect() { return { state: 'pending', inspectAfterMs: 10 } },
      async reconcile() { return { state: 'pending', data: { balance: 'invalid' }, inspectAfterMs: 10 } },
      async cancel() { return { state: 'cancelled' } },
    }
    const actions = await reconcileWaiting(instance, {
      wakeStore, projectDir: dir, effectAdapters: new EffectAdapterRegistry([adapter]),
    })
    expect(actions).toContain('fail-stopped on failed effect recovered-job')
    expect((await loadInstance(dir, instance.record.instanceId))?.record.status).toBe('failed')
    expect((await effects.get('recovered-job'))?.lastError).toContain('Effect Rule fail-stop')
  })

  it('heals a lost harvest wake (effect concluded, wake gone)', async () => {
    const { instance, wakeStore, effects, dir } = await crashedInstance()
    await effects.conclude('exp-42', 'done', 'event')
    await wakeStore.cancelForLoop('walk-research-v1')
    const actions = await reconcileWaiting(instance, { wakeStore, projectDir: dir })
    expect(actions.some(a => a.includes('missing harvest wake'))).toBe(true)
    const live = (await wakeStore.list()).filter(w => w.status === 'pending')
    expect(live.some(w => w.kind === 'event' && w.effectKey === 'exp-42')).toBe(true)
  })

  it('drops an orphan pending_round with no effect record and reschedules a timer', async () => {
    const { instance, wakeStore, paths, dir } = await crashedInstance()
    const pending = (await readPendingRound(instance))!
    const { atomicWriteJson } = await import('../../infra/persist/index.js')
    await atomicWriteJson(paths.pendingRoundJson, { ...pending, effectKey: 'ghost' })
    await wakeStore.cancelForLoop('walk-research-v1')
    const actions = await reconcileWaiting(instance, { wakeStore, projectDir: dir })
    expect(actions.some(a => a.includes('orphan pending_round'))).toBe(true)
    expect(await readPendingRound(instance)).toBeNull()
    expect((await wakeStore.list()).some(w => w.kind === 'timer' && w.status === 'pending')).toBe(true)
  })

  it('settles a concluded effect left behind after a post-harvest crash', async () => {
    const { instance, wakeStore, effects, dir } = await crashedInstance()
    await effects.conclude('exp-42', 'done', 'event')
    const { rm } = await import('fs/promises')
    await rm(instance.paths.pendingRoundJson, { force: true })
    const actions = await reconcileWaiting(instance, { wakeStore, projectDir: dir })
    expect(actions.some(a => a.includes('settled post-harvest'))).toBe(true)
    expect((await effects.get('exp-42'))!.status).toBe('harvested')
  })

  it('deterministically escalates an event wait whose deadline expired', async () => {
    const { instance, wakeStore, paths, dir, dispatcher, effects } = await crashedInstance()
    const pending = (await readPendingRound(instance))!
    const { atomicWriteJson } = await import('../../infra/persist/index.js')
    await atomicWriteJson(paths.pendingRoundJson, { ...pending, expiresAt: Date.now() - 1 })

    const actions = await reconcileWaiting(instance, { wakeStore, projectDir: dir })
    expect(actions.some(a => a.includes('event wait timed out'))).toBe(true)
    await tickOnce({ dispatcher, projectDir: dir })

    expect(JSON.parse(await readFile(paths.instanceJson, 'utf-8')).status).toBe('paused_attention')
    expect(await readPendingRound(instance)).toBeNull()
    expect((await effects.get('exp-42'))!.status).toBe('failed')
    await expect(readFile(join(paths.reportsDir, 'attention_report.md'), 'utf-8'))
      .resolves.toContain('did not arrive before its deadline')
  })
})

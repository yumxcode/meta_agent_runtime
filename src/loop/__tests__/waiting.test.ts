/**
 * M2 acceptance — the waiting round: submit segment → probes (sleep / rotate /
 * plateau-terminate) → harvest segment; event fast path; probe/event dedup;
 * the RECONCILE crash matrix. Seats are scripted; probes are the REAL file
 * adapter reading a simulated training status file.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import type { SubAgentRecord } from '../../subagent/types.js'
import { makeSubAgentTaskId } from '../../subagent/types.js'
import { createInstance, loadInstance } from '../instance/InstanceStore.js'
import { WakeStore } from '../wake/WakeStore.js'
import { tickOnce } from '../runner.js'
import { instancePaths, type RoundEntry } from '../types.js'
import { EffectLedger } from '../effects/EffectLedger.js'
import { Ledger } from '../ledger/LedgerApi.js'
import { reconcileWaiting, readPendingRound } from '../effects/WaitOps.js'
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

/** Drive ticks (real clock, tiny probe cadence) until cond or timeout. */
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
      tripwires: [{ when: 'iteration >= 1', then: { mode: 'finalize', stop: true } }],
      ...charterOverrides,
    })
    await createInstance({ projectDir: dir, charter, wakeStore: new WakeStore(dir) })
    return { dir, paths }
  })()
}

/** Standard scripted seats: submit-then-harvest worker + passing judge. */
function trainingScript(dir: string, paths: ReturnType<typeof instancePaths>): SeatScript {
  return async task => {
    if (isWorker(task) && !isHarvest(task)) {
      await writeFile(join(dir, 'sim_training.json'),
        JSON.stringify({ state: 'running', metricHistory: [0.1] }), 'utf-8')
      return {
        label: 'wait', wait: 'training', effectKey: 'exp-42',
        payload: { statusFile: 'sim_training.json' },
        note: '提交了 exp-42',
      }
    }
    if (isHarvest(task)) {
      await mkdir(paths.draftsDir, { recursive: true })
      await writeFile(join(paths.draftsDir, 'direction.json'),
        JSON.stringify({ key: 'dir-1' }), 'utf-8')
      await writeFile(join(paths.draftsDir, 'findings_draft.json'),
        JSON.stringify([{ claim: 'plateau at 0.5', evidence: 'curve' }]), 'utf-8')
      return { label: 'ok' }
    }
    if (isJudge(task)) {
      return { verdict: 'pass', new_findings_count: 1, metric_delta: 0.1, metric: 0.5, messages: [] }
    }
    throw new Error('unexpected seat')
  }
}

describe('M2 acceptance — waiting rounds', () => {
  it('submit → probe(sleep) → no_balance(rotate) → plateau(terminate) → harvest completes the SAME round', async () => {
    const { dir, paths } = await setup()
    const dispatcher = scriptedDispatcher(trainingScript(dir, paths))
    const deps = { dispatcher, projectDir: dir }
    const statusFile = join(dir, 'sim_training.json')
    const effects = new EffectLedger(new Ledger(paths), paths)

    // Tick 1: submit segment → waiting.
    await tickOnce(deps)
    expect((await readPendingRound((await loadInstance(dir, 'walk-research-v1'))!))!.round).toBe(1)
    expect(JSON.parse(await readFile(paths.instanceJson, 'utf-8')).status).toBe('waiting')

    // Probe 1: running → sleep (worker did NOT wake).
    await pump(deps, async () => (await effects.get('exp-42'))!.probes.length >= 1)
    expect((await effects.get('exp-42'))!.probes[0]!.verdict).toBe('running')
    expect(dispatcher.spawns.filter(isHarvest)).toHaveLength(0)

    // Balance dies → probe rotates via CODE, still no seat wakes.
    await writeFile(statusFile, JSON.stringify({ state: 'running', metricHistory: [0.1, 0.2], balanceOk: false }), 'utf-8')
    await pump(deps, async () => (await effects.get('exp-42'))!.resubmits >= 1)
    expect(JSON.parse(await readFile(statusFile, 'utf-8')).balanceOk).toBe(true) // adapter healed it
    expect(dispatcher.spawns.filter(isHarvest)).toHaveLength(0)

    // Metrics flatten → plateau → terminate → harvest wake → harvest segment.
    await writeFile(statusFile, JSON.stringify({ state: 'running', metricHistory: [0.5, 0.5, 0.5, 0.5] }), 'utf-8')
    await pump(deps, async () =>
      JSON.parse(await readFile(paths.instanceJson, 'utf-8')).status === 'done')

    // Same round completed: one round entry, findings admitted, effect settled.
    const rounds = (await readFile(paths.roundsJsonl, 'utf-8')).trim().split('\n')
      .map(l => JSON.parse(l) as RoundEntry)
    expect(rounds).toHaveLength(1)
    expect(rounds[0]!.round).toBe(1)
    expect(rounds[0]!.route).toBe('finalize+stop')
    expect((await effects.get('exp-42'))!.status).toBe('harvested')
    expect(await readPendingRound((await loadInstance(dir, 'walk-research-v1'))!)).toBeNull()
    // The harvest task carried the lineage digest + outcome.
    const harvestTask = dispatcher.spawns.find(isHarvest)!
    expect(harvestTask).toContain('提交段摘要')
    expect(harvestTask).toContain('plateau')
    // Terminated remotely by code, not by a seat.
    expect(JSON.parse(await readFile(statusFile, 'utf-8')).terminated).toBe(true)
  })

  it('event fast path concludes the effect; a later probe cannot double-harvest', async () => {
    const { dir, paths } = await setup()
    const dispatcher = scriptedDispatcher(trainingScript(dir, paths))
    const deps = { dispatcher, projectDir: dir }
    const effects = new EffectLedger(new Ledger(paths), paths)

    await tickOnce(deps) // submit → waiting
    // External system drops a completion event (bypasses probes entirely).
    await mkdir(paths.eventsDir, { recursive: true })
    await writeFile(join(paths.eventsDir, 'evt-1.json'),
      JSON.stringify({ effectKey: 'exp-42', verdict: 'done', data: { final: 0.61 } }), 'utf-8')

    await pump(deps, async () =>
      JSON.parse(await readFile(paths.instanceJson, 'utf-8')).status === 'done')

    const rec = (await effects.get('exp-42'))!
    expect(rec.status).toBe('harvested')
    expect(rec.outcome!.via).toBe('event')
    // Exactly one harvest happened even though probe wakes were also in flight.
    expect(dispatcher.spawns.filter(isHarvest)).toHaveLength(1)
    const rounds = (await readFile(paths.roundsJsonl, 'utf-8')).trim().split('\n')
    expect(rounds).toHaveLength(1)
  })

  it('a coalesced timer during waiting does not start a new round', async () => {
    const { dir, paths } = await setup()
    const dispatcher = scriptedDispatcher(trainingScript(dir, paths))
    const deps = { dispatcher, projectDir: dir }
    await tickOnce(deps) // waiting
    // Someone schedules a timer (e.g. an old coalesced tick).
    await new WakeStore(dir).schedule({ loopId: 'walk-research-v1', kind: 'timer', fireAt: Date.now() })
    await tickOnce(deps)
    expect(JSON.parse(await readFile(paths.instanceJson, 'utf-8')).status).toBe('waiting')
    // Only the original submit worker ran — no second submit segment.
    expect(dispatcher.spawns.filter(t => isWorker(t) && !isHarvest(t))).toHaveLength(1)
  })
})

describe('M2 acceptance — RECONCILE crash matrix', () => {
  async function crashedInstance() {
    const { dir, paths } = await setup()
    const dispatcher = scriptedDispatcher(trainingScript(dir, paths))
    await tickOnce({ dispatcher, projectDir: dir }) // reach waiting state
    const instance = (await loadInstance(dir, 'walk-research-v1'))!
    const wakeStore = new WakeStore(dir)
    const effects = new EffectLedger(new Ledger(paths), paths)
    return { dir, paths, instance, wakeStore, effects, dispatcher }
  }

  it('heals a lost probe wake (crash after submit, before probe scheduling persisted)', async () => {
    const { instance, wakeStore, dir } = await crashedInstance()
    await wakeStore.cancelForLoop('walk-research-v1') // simulate lost wakes
    const actions = await reconcileWaiting(instance, { wakeStore, projectDir: dir })
    expect(actions.some(a => a.includes('missing probe wake'))).toBe(true)
    const live = (await wakeStore.list()).filter(w => w.status === 'pending')
    expect(live.some(w => w.kind === 'probe' && w.effectKey === 'exp-42')).toBe(true)
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
    // Corrupt state: pending_round points at an effect that was never recorded.
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
    await effects.conclude('exp-42', 'done', 'probe')
    // Simulate: harvest finished its ledger writes + cleared pending, then died
    // before markHarvested.
    const { rm } = await import('fs/promises')
    await rm(instance.paths.pendingRoundJson, { force: true })
    const actions = await reconcileWaiting(instance, { wakeStore, projectDir: dir })
    expect(actions.some(a => a.includes('settled post-harvest'))).toBe(true)
    expect((await effects.get('exp-42'))!.status).toBe('harvested')
  })
})

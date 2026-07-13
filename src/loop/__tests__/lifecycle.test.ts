/**
 * Manual lifecycle (pause / resume / stop) — v3 lifecycle extension.
 *
 *   • pause is a real freeze: wakes culled, rounds don't run, and external
 *     events stay UNCONSUMED in events/ until resume;
 *   • resume rebuilds wakes from durable state (pending_round + effect ledger
 *     + events/) via the same machinery that heals a crash — no snapshots;
 *   • resume on paused_attention is the light ack: meters reset, no charter
 *     version bump, and the loop genuinely runs again;
 *   • stop is a graceful terminate: terminal RoundEntry {finalize, manual},
 *     final_report.md, completed/done, abandoned segment cost accounted;
 *   • migrate refuses paused_manual (would strand an idle loop with no wake).
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import type { SubAgentRecord } from '../../subagent/types.js'
import { makeSubAgentTaskId } from '../../subagent/types.js'
import { createInstance, loadInstance } from '../instance/InstanceStore.js'
import { migrateInstance } from '../instance/Migrate.js'
import { pauseInstance, resumeInstance, stopInstance, type LifecycleEntry } from '../instance/Lifecycle.js'
import { WakeStore } from '../wake/WakeStore.js'
import { tickOnce, runUntilQuiescent } from '../runner.js'
import { instancePaths, type RoundEntry } from '../types.js'
import { readPendingRound } from '../effects/WaitOps.js'
import { EffectAdapterRegistry } from '../effects/EffectAdapter.js'
import { walkResearchCharter } from './testCharter.js'

function scriptedDispatcher(
  script: (task: string) => Promise<Record<string, unknown>>,
): ISubAgentDispatcher & { spawns: string[] } {
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

async function writeDrafts(draftsDir: string, key: string): Promise<void> {
  await mkdir(draftsDir, { recursive: true })
  await writeFile(join(draftsDir, 'direction.json'), JSON.stringify({ key }), 'utf-8')
  await writeFile(join(draftsDir, 'findings_draft.json'),
    JSON.stringify([{ claim: `c-${key}`, evidence: 'e' }]), 'utf-8')
}

async function readLifecycle(paths: ReturnType<typeof instancePaths>): Promise<LifecycleEntry[]> {
  return (await readFile(paths.lifecycleJsonl, 'utf-8')).trim().split('\n').map(l => JSON.parse(l) as LifecycleEntry)
}

const ID = 'walk-research-v1'

describe('pause / resume — idle instance', () => {
  it('pause freezes the loop (no rounds run); resume schedules and it runs again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-lc-idle-'))
    const paths = instancePaths(dir, ID)
    let workerRound = 0
    const dispatcher = scriptedDispatcher(async task => {
      if (isWorker(task)) {
        workerRound++
        await writeDrafts(paths.draftsDir, `d${workerRound}`)
        return { label: 'ok' }
      }
      if (isJudge(task)) return { verdict: 'pass', new_findings_count: 1, metric_delta: 0.1, metric: 0.5, messages: [] }
      throw new Error('unexpected seat')
    })
    const charter = walkResearchCharter({
      tripwires: [{ when: 'iteration >= 5', then: { act: 'finalize' } }],
    })
    await createInstance({ projectDir: dir, charter, wakeStore: new WakeStore(dir) })
    const deps = { dispatcher, projectDir: dir }
    const lifecycleDeps = { wakeStore: new WakeStore(dir), projectDir: dir }

    await tickOnce(deps) // round 1 → idle, next wake scheduled
    expect(workerRound).toBe(1)

    const inst = (await loadInstance(dir, ID))!
    const paused = await pauseInstance(inst, lifecycleDeps, '午休')
    expect(paused.status).toBe('paused_manual')
    // Frozen: repeated ticks run nothing.
    await tickOnce(deps)
    await tickOnce(deps)
    expect(workerRound).toBe(1)
    expect((await loadInstance(dir, ID))!.record.status).toBe('paused_manual')
    // Pause is idempotent.
    expect((await pauseInstance((await loadInstance(dir, ID))!, lifecycleDeps)).message).toContain('no-op')

    const resumed = await resumeInstance((await loadInstance(dir, ID))!, lifecycleDeps)
    expect(resumed.status).toBe('idle')
    await tickOnce(deps) // round 2 runs again
    expect(workerRound).toBe(2)

    const audit = await readLifecycle(paths)
    expect(audit.map(e => e.action)).toEqual(['pause', 'resume'])
    expect(audit[0]).toMatchObject({ fromStatus: 'idle', toStatus: 'paused_manual', reason: '午休' })
  })

  it('rejects pause/resume in wrong states', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-lc-guard-'))
    const charter = walkResearchCharter({
      tripwires: [{ when: 'iteration >= 5', then: { act: 'finalize' } }],
    })
    const inst = await createInstance({ projectDir: dir, charter, wakeStore: new WakeStore(dir) })
    const lifecycleDeps = { wakeStore: new WakeStore(dir), projectDir: dir }
    await expect(resumeInstance(inst, lifecycleDeps)).rejects.toThrow(/cannot resume while 'idle'/)
  })
})

describe('pause / resume — waiting instance (event wait)', () => {
  async function waitingSetup() {
    const dir = await mkdtemp(join(tmpdir(), 'loop-lc-wait-'))
    const paths = instancePaths(dir, ID)
    const dispatcher = scriptedDispatcher(async task => {
      if (isWorker(task) && !isHarvest(task)) {
        return { label: 'wait', effectKey: 'exp-9', note: '提交了 exp-9' }
      }
      if (isHarvest(task)) {
        await writeDrafts(paths.draftsDir, 'dir-1')
        return { label: 'ok' }
      }
      if (isJudge(task)) return { verdict: 'pass', new_findings_count: 1, metric_delta: 0.1, metric: 0.6, messages: [] }
      throw new Error('unexpected seat: ' + task.slice(0, 40))
    })
    const charter = walkResearchCharter({
      tripwires: [{ when: 'iteration >= 1', then: { act: 'finalize' } }],
    })
    await createInstance({ projectDir: dir, charter, wakeStore: new WakeStore(dir) })
    const deps = { dispatcher, projectDir: dir }
    await tickOnce(deps) // submit → waiting on event
    expect((await loadInstance(dir, ID))!.record.status).toBe('waiting')
    return { dir, paths, deps, dispatcher }
  }

  it('a paused loop does NOT consume events; resume ingests them and the SAME round harvests', async () => {
    const { dir, paths, deps, dispatcher } = await waitingSetup()
    const lifecycleDeps = { wakeStore: new WakeStore(dir), projectDir: dir }

    await pauseInstance((await loadInstance(dir, ID))!, lifecycleDeps, '外部系统维护')
    // Event arrives WHILE paused.
    await mkdir(paths.eventsDir, { recursive: true })
    await writeFile(join(paths.eventsDir, 'evt.json'),
      JSON.stringify({ effectKey: 'exp-9', verdict: 'done', data: { final: 0.6 } }), 'utf-8')

    await tickOnce(deps)
    await tickOnce(deps)
    // Frozen: no harvest ran, the event file is still unconsumed in events/.
    expect(dispatcher.spawns.filter(isHarvest)).toHaveLength(0)
    expect((await readdir(paths.eventsDir)).filter(f => f.endsWith('.json'))).toContain('evt.json')

    const resumed = await resumeInstance((await loadInstance(dir, ID))!, lifecycleDeps)
    expect(resumed.status).toBe('waiting')
    await runUntilQuiescent(deps)

    // Same round harvested to completion.
    const record = (await loadInstance(dir, ID))!.record
    expect(record.status).toBe('done')
    const rounds = (await readFile(paths.roundsJsonl, 'utf-8')).trim().split('\n').map(l => JSON.parse(l) as RoundEntry)
    expect(rounds).toHaveLength(1)
    expect(rounds[0]!.round).toBe(1)
    expect(dispatcher.spawns.filter(isHarvest)).toHaveLength(1)
  })
})

describe('resume — light ack of paused_attention', () => {
  it('resets the escalating meters and the loop genuinely runs again (no charter bump)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-lc-ack-'))
    const paths = instancePaths(dir, ID)
    let workerRound = 0
    const dispatcher = scriptedDispatcher(async task => {
      if (isWorker(task)) {
        workerRound++
        await writeDrafts(paths.draftsDir, `d${workerRound}`)
        return { label: 'ok' }
      }
      if (isJudge(task)) {
        return { verdict: 'pass', new_findings_count: 0, metric_delta: -0.1, metric: null, messages: [] }
      }
      throw new Error('unexpected seat')
    })
    const charter = walkResearchCharter({
      tripwires: [
        { when: 'stale_count >= 2', then: { act: 'escalate', reason: 'stuck' } },
        { when: 'iteration >= 10', then: { act: 'finalize' } },
      ],
    })
    await createInstance({ projectDir: dir, charter, wakeStore: new WakeStore(dir) })
    const deps = { dispatcher, projectDir: dir }
    await runUntilQuiescent(deps) // 2 stale rounds → escalate → paused_attention

    let inst = (await loadInstance(dir, ID))!
    expect(inst.record.status).toBe('paused_attention')
    expect(inst.record.lastEscalation).toMatchObject({ tripwireIndex: 0 })

    const result = await resumeInstance(inst, { wakeStore: new WakeStore(dir), projectDir: dir }, '看过报告了')
    expect(result.status).toBe('idle')
    expect(result.message).toContain('stale_count')

    inst = (await loadInstance(dir, ID))!
    expect(inst.record.lastEscalation).toBeUndefined()
    let progress = await inst.ledger.readProgress()
    expect(progress.meters['stale_count']).toBe(0)
    expect(progress.status).toBe('healthy')

    const before = workerRound
    await tickOnce(deps) // a REAL round runs — no instant re-pause
    expect(workerRound).toBe(before + 1)
    inst = (await loadInstance(dir, ID))!
    expect(inst.record.status).toBe('idle')
    progress = await inst.ledger.readProgress()
    expect(progress.status).toBe('stale') // stale 1 again, not 2

    const audit = await readLifecycle(paths)
    expect(audit.at(-1)).toMatchObject({ action: 'ack', resetMeters: ['stale_count'], toStatus: 'idle' })
  })
})

describe('stop — graceful manual terminate', () => {
  it('stop(idle): terminal manual entry + final report + completed/done; idempotent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-lc-stop-'))
    const paths = instancePaths(dir, ID)
    const dispatcher = scriptedDispatcher(async task => {
      if (isWorker(task)) { await writeDrafts(paths.draftsDir, 'd1'); return { label: 'ok' } }
      if (isJudge(task)) return { verdict: 'pass', new_findings_count: 1, metric_delta: 0.1, metric: 0.5, messages: [] }
      throw new Error('unexpected seat')
    })
    const charter = walkResearchCharter({
      tripwires: [{ when: 'iteration >= 5', then: { act: 'finalize' } }],
    })
    await createInstance({ projectDir: dir, charter, wakeStore: new WakeStore(dir) })
    const deps = { dispatcher, projectDir: dir }
    await tickOnce(deps) // round 1 → idle

    const wakeStore = new WakeStore(dir)
    const result = await stopInstance((await loadInstance(dir, ID))!, { wakeStore, projectDir: dir }, '不需要再研究了')
    expect(result.status).toBe('done')

    const inst = (await loadInstance(dir, ID))!
    expect(inst.record.status).toBe('done')
    expect(inst.record.statusReason).toContain('不需要再研究了')
    expect((await inst.ledger.readProgress()).status).toBe('completed')
    const rounds = (await readFile(paths.roundsJsonl, 'utf-8')).trim().split('\n').map(l => JSON.parse(l) as RoundEntry)
    expect(rounds.at(-1)!.route).toMatchObject({ kind: 'finalize', cause: 'manual', reason: '不需要再研究了' })
    await expect(readFile(join(paths.reportsDir, 'final_report.md'), 'utf-8'))
      .resolves.toContain('不需要再研究了')
    // Wakes cancelled — nothing ever fires again.
    expect((await wakeStore.claimDue(Date.now() + 1e9)).length).toBe(0)
    // Idempotent.
    expect((await stopInstance((await loadInstance(dir, ID))!, { wakeStore, projectDir: dir })).message).toContain('no-op')
  })

  it('stop(waiting): abandons the parked round but folds its cost into the terminal entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-lc-stopwait-'))
    const paths = instancePaths(dir, ID)
    const dispatcher = scriptedDispatcher(async task => {
      if (isWorker(task)) return { label: 'wait', effectKey: 'exp-7', note: '提交' }
      throw new Error('unexpected seat')
    })
    const charter = walkResearchCharter({
      tripwires: [{ when: 'iteration >= 1', then: { act: 'finalize' } }],
    })
    await createInstance({ projectDir: dir, charter, wakeStore: new WakeStore(dir) })
    await tickOnce({ dispatcher, projectDir: dir }) // submit → waiting (worker cost 0.1)

    const inst = (await loadInstance(dir, ID))!
    expect(inst.record.status).toBe('waiting')
    await stopInstance(inst, { wakeStore: new WakeStore(dir), projectDir: dir })

    const reloaded = (await loadInstance(dir, ID))!
    expect(reloaded.record.status).toBe('done')
    expect(await readPendingRound(reloaded)).toBeNull()
    const rounds = (await readFile(paths.roundsJsonl, 'utf-8')).trim().split('\n').map(l => JSON.parse(l) as RoundEntry)
    expect(rounds).toHaveLength(1)
    expect(rounds[0]!).toMatchObject({ round: 1, costUsd: 0.1 })
    expect(rounds[0]!.route).toMatchObject({ kind: 'finalize', cause: 'manual' })
    expect((await reloaded.ledger.readProgress()).totalCostUsd).toBeCloseTo(0.1)
  })

  it('stop(waiting) fail-stops when the host can no longer resolve the frozen adapter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-lc-stop-missing-adapter-'))
    const dispatcher = scriptedDispatcher(async task => {
      if (isWorker(task)) return {
        label: 'wait', effectKey: 'remote-1', effectBinding: 'remote',
      }
      throw new Error('unexpected seat')
    })
    const charter = walkResearchCharter({
      tripwires: [{ when: 'iteration >= 1', then: { act: 'finalize' } }],
      effects: {
        remote: {
          adapter: 'test/stop-remote@1', observations: {}, rules: [],
          admission: { maxConcurrentCalls: 1 },
        },
      },
    })
    const wakeStore = new WakeStore(dir)
    await createInstance({ projectDir: dir, charter, wakeStore })
    const registry = new EffectAdapterRegistry([{
      id: 'test/stop-remote@1',
      async submit() { return {} },
      async inspect() { return { state: 'pending' } },
      async cancel() { return { state: 'cancelled' } },
    }])
    await tickOnce({ dispatcher, projectDir: dir, effectAdapters: registry })
    const waiting = (await loadInstance(dir, ID))!
    await expect(stopInstance(waiting, { wakeStore, projectDir: dir }))
      .rejects.toThrow(/cancellation could not start/)
    const failed = (await loadInstance(dir, ID))!
    expect(failed.record.status).toBe('failed')
    expect(await readPendingRound(failed)).not.toBeNull()
    expect((await wakeStore.list()).filter(wake =>
      wake.status === 'pending' || wake.status === 'claimed',
    )).toHaveLength(0)
  })
})

describe('migrate × paused_manual', () => {
  it('refuses to migrate a manually paused instance (resume first)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-lc-mig-'))
    const inst = await createInstance({ projectDir: dir, charter: walkResearchCharter(), wakeStore: new WakeStore(dir) })
    await pauseInstance(inst, { wakeStore: new WakeStore(dir), projectDir: dir })
    await expect(migrateInstance(inst, walkResearchCharter({ version: 2 }), { projectDir: dir }))
      .rejects.toThrow(/resume/)
  })
})

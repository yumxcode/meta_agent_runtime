/**
 * Regression tests for the 2026-07-10 loop-mechanism review fixes
 * (docs/reviews/loop-mechanism-review-2026-07-10.md):
 *   M1 — pivot rounds consume the inbox ONCE (feedback reaches the worker)
 *   M2 — harvest replay guard (already-accounted round never re-runs seats)
 *   M4 — status transitions re-validate on disk (pause vs daemon race)
 *   M6 — a crashed judge is retried once and fails CLOSED (no unreviewed admit)
 *   M7 — migrate without opts re-arms wakes in the WORKSPACE wake store
 *   L1 — an early-fired self-timer wake re-arms the real resume wake
 *   L2 — an event wait without effectKey gets one corrective retry
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, access } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import type { SubAgentRecord } from '../../subagent/types.js'
import { makeSubAgentTaskId } from '../../subagent/types.js'
import { atomicWriteJson } from '../../infra/persist/index.js'
import { createInstance, loadInstance, setInstanceStatus } from '../instance/InstanceStore.js'
import { pauseInstance } from '../instance/Lifecycle.js'
import { migrateInstance } from '../instance/Migrate.js'
import { WakeStore } from '../wake/WakeStore.js'
import { tickOnce } from '../runner.js'
import { instancePaths, type PendingRound, type RoundEntry } from '../types.js'
import { EffectLedger } from '../effects/EffectLedger.js'
import { Ledger, type ProgressView } from '../ledger/LedgerApi.js'
import { readPendingRound } from '../effects/WaitOps.js'
import { walkResearchCharter } from './testCharter.js'

/** Scripted dispatcher whose script may also fail a seat (success:false). */
type SeatScript = (task: string) => Promise<{ output: Record<string, unknown>; success?: boolean }>

function scriptedDispatcher(script: SeatScript): ISubAgentDispatcher & { spawns: string[] } {
  const spawns: string[] = []
  return {
    spawns,
    async spawnSubAgent({ config }) {
      spawns.push(config.taskDescription)
      const { output, success = true } = await script(config.taskDescription)
      return {
        schemaVersion: '1.0', taskId: makeSubAgentTaskId(), parentSessionId: 't',
        status: 'completed', config: config as SubAgentRecord['config'],
        createdAt: Date.now(), completedAt: Date.now(), pendingHumanApproval: false,
        result: {
          success, summary: success ? 'scripted' : '', output,
          ...(success ? {} : { error: 'scripted crash' }),
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
const isPivoter = (t: string) => t.includes('结构性转向座位')
const isHarvest = (t: string) => t.includes('收割段')

const INSTANCE_ID = 'walk-research-v1'

async function setup(charterOverrides?: Parameters<typeof walkResearchCharter>[0]) {
  const dir = await mkdtemp(join(tmpdir(), 'loop-fix-'))
  const paths = instancePaths(dir, INSTANCE_ID)
  const charter = walkResearchCharter({
    tripwires: [{ when: 'iteration >= 1', then: { act: 'finalize' } }],
    ...charterOverrides,
  })
  await createInstance({ projectDir: dir, charter, wakeStore: new WakeStore(dir) })
  return { dir, paths }
}

async function writeDrafts(paths: ReturnType<typeof instancePaths>, key = 'dir-1'): Promise<void> {
  await mkdir(paths.draftsDir, { recursive: true })
  await writeFile(join(paths.draftsDir, 'direction.json'), JSON.stringify({ key }), 'utf-8')
  await writeFile(
    join(paths.draftsDir, 'findings_draft.json'),
    JSON.stringify([{ claim: 'c', evidence: 'e' }]), 'utf-8',
  )
}

const PASSING_JUDGE = { verdict: 'pass', new_findings_count: 1, metric_delta: 0.1, metric: 0.5, messages: [] }

describe('M1 — pivot rounds consume the inbox exactly once', () => {
  it('human feedback reaches BOTH the pivoter and the worker capsule', async () => {
    const { dir, paths } = await setup({
      tripwires: [
        { when: 'stale_count >= 2', then: { act: 'pivot' } },
        { when: 'iteration >= 1', then: { act: 'finalize' } },
      ],
    })
    // Force the next round to be a pivot round + drop human feedback.
    const progress = JSON.parse(await readFile(paths.progressJson, 'utf-8')) as ProgressView
    await atomicWriteJson(paths.progressJson, { ...progress, nextRoundMode: 'pivot' })
    await mkdir(paths.inboxDir, { recursive: true })
    await writeFile(join(paths.inboxDir, 'fb.json'), JSON.stringify({ message: '优先验证阻尼假设' }), 'utf-8')

    const dispatcher = scriptedDispatcher(async task => {
      if (isPivoter(task)) return { output: { directive: '换证据源重新验证', key: 'pivot-1' } }
      if (isWorker(task)) { await writeDrafts(paths); return { output: { label: 'ok' } } }
      if (isJudge(task)) return { output: PASSING_JUDGE }
      throw new Error('unexpected seat: ' + task.slice(0, 40))
    })
    await tickOnce({ dispatcher, projectDir: dir })

    const pivoterTask = dispatcher.spawns.find(isPivoter)!
    const workerTask = dispatcher.spawns.find(isWorker)!
    expect(pivoterTask).toContain('优先验证阻尼假设')
    // The regression: the pivoter's capsule build consumed the inbox and the
    // worker (second build) silently lost the feedback.
    expect(workerTask).toContain('优先验证阻尼假设')
    expect(workerTask).toContain('换证据源重新验证') // pivot directive still injected
  })
})

describe('M2 — harvest replay guard', () => {
  it('an already-accounted pending round settles WITHOUT re-running any seat', async () => {
    const { dir, paths } = await setup()
    const instance = (await loadInstance(dir, INSTANCE_ID))!
    const effects = new EffectLedger(new Ledger(paths), paths)

    // Simulate the crash window: round 1 fully accounted (progress written),
    // but pending_round + concluded effect were left behind.
    await effects.submit({ effectKey: 'exp-9', kind: 'event', waitName: 'event' })
    await effects.conclude('exp-9', 'done', 'event', { final: 1 })
    await atomicWriteJson(paths.pendingRoundJson, {
      round: 1, mode: 'normal', kind: 'effect', effectKey: 'exp-9', waitName: 'event',
      startedAt: Date.now(), costUsdSoFar: 0.2, seatSummaries: { worker: 's' },
      correctiveRetries: 0, submitSummary: 's', createdAt: Date.now(),
    } satisfies PendingRound)
    const progress = JSON.parse(await readFile(paths.progressJson, 'utf-8')) as ProgressView
    await atomicWriteJson(paths.progressJson, { ...progress, iteration: 1, updatedAt: Date.now() })
    await setInstanceStatus(instance, 'waiting')

    const dispatcher = scriptedDispatcher(async () => { throw new Error('no seat may run') })
    await tickOnce({ dispatcher, projectDir: dir })

    expect(dispatcher.spawns).toHaveLength(0) // the guard: no LLM re-spend
    expect(await readPendingRound((await loadInstance(dir, INSTANCE_ID))!)).toBeNull()
    expect((await effects.get('exp-9'))!.status).toBe('harvested')
    const record = JSON.parse(await readFile(paths.instanceJson, 'utf-8')) as { status: string }
    expect(record.status).toBe('idle') // normal scheduling resumes
  })
})

describe('M4 — status transitions re-validate on disk', () => {
  it('pause loses the race to a daemon that flipped the instance to running', async () => {
    const { dir } = await setup()
    const wakeStore = new WakeStore(dir)
    const stale = (await loadInstance(dir, INSTANCE_ID))! // reads status 'idle'
    const fresh = (await loadInstance(dir, INSTANCE_ID))!
    await setInstanceStatus(fresh, 'running') // the daemon claimed a wake
    await expect(pauseInstance(stale, { wakeStore, projectDir: dir }))
      .rejects.toThrow(/running/)
  })
})

describe('M6 — crashed judge: one retry, then fail-closed', () => {
  it('retries the judge once and refuses to admit unreviewed findings', async () => {
    const { dir, paths } = await setup()
    const dispatcher = scriptedDispatcher(async task => {
      if (isWorker(task)) { await writeDrafts(paths); return { output: { label: 'ok' } } }
      if (isJudge(task)) return { output: {}, success: false } // crashes every time
      throw new Error('unexpected seat: ' + task.slice(0, 40))
    })
    await tickOnce({ dispatcher, projectDir: dir })

    expect(dispatcher.spawns.filter(isJudge)).toHaveLength(2) // one in-round rerun
    const progress = JSON.parse(await readFile(paths.progressJson, 'utf-8')) as ProgressView
    expect(progress.totalFindings).toBe(0) // fail-closed: drafts discarded
    await expect(access(paths.findingsJsonl)).rejects.toThrow() // nothing admitted
  })
})

describe('M7 — migrate default wake store targets the workspace', () => {
  it('re-arms the wake under <workspace>/.loop/wakes, not inside the instance dir', async () => {
    const { dir, paths } = await setup()
    const instance = (await loadInstance(dir, INSTANCE_ID))!
    await setInstanceStatus(instance, 'paused_attention', 'test', {
      lastEscalation: { tripwireIndex: 0, reason: 'attention', at: Date.now() },
    })
    await migrateInstance(instance, walkResearchCharter({
      version: 2,
      tripwires: [{ when: 'iteration >= 1', then: { act: 'finalize' } }],
    })) // NO opts — exercises the fallback path
    const wakes = await new WakeStore(dir).list()
    expect(wakes.some(w => w.loopId === INSTANCE_ID && w.kind === 'timer' && w.status === 'pending')).toBe(true)
    await expect(access(join(paths.root, '.loop'))).rejects.toThrow() // nothing leaked into the instance dir
  })
})

describe('L1 — early-fired self-timer wake re-arms the resume wake', () => {
  it('a coalesced-early timer does not strand the park', async () => {
    const { dir, paths } = await setup()
    const instance = (await loadInstance(dir, INSTANCE_ID))!
    const fireAt = Date.now() + 60_000
    await atomicWriteJson(paths.pendingRoundJson, {
      round: 1, mode: 'normal', kind: 'self_timer', reason: 'check training', fireAt,
      startedAt: Date.now(), costUsdSoFar: 0.1, seatSummaries: {},
      correctiveRetries: 0, submitSummary: 's', createdAt: Date.now(),
    } satisfies PendingRound)
    await setInstanceStatus(instance, 'waiting')
    // The create-time wake fires NOW — long before pending.fireAt.
    const dispatcher = scriptedDispatcher(async () => { throw new Error('no seat may run') })
    await tickOnce({ dispatcher, projectDir: dir })

    expect(dispatcher.spawns).toHaveLength(0)
    const pending = (await new WakeStore(dir).list())
      .filter(w => w.status === 'pending' && w.kind === 'timer' && w.loopId === INSTANCE_ID)
    expect(pending.some(w => w.fireAt === fireAt)).toBe(true) // re-armed at the REAL resume time
  })
})

describe('L2 — event wait without effectKey', () => {
  it('gets one corrective retry; the retried wait parks with the supplied key', async () => {
    const { dir, paths } = await setup()
    let workerCalls = 0
    const dispatcher = scriptedDispatcher(async task => {
      if (isWorker(task) && !isHarvest(task)) {
        workerCalls++
        return workerCalls === 1
          ? { output: { label: 'wait' } } // missing effectKey — must be rejected
          : { output: { label: 'wait', effectKey: 'k-1' } }
      }
      throw new Error('unexpected seat: ' + task.slice(0, 40))
    })
    await tickOnce({ dispatcher, projectDir: dir })

    const workers = dispatcher.spawns.filter(isWorker)
    expect(workers).toHaveLength(2)
    expect(workers[1]).toContain('纠偏重试')
    expect(workers[1]).toContain('effectKey')
    const pending = await readPendingRound((await loadInstance(dir, INSTANCE_ID))!)
    expect(pending?.effectKey).toBe('k-1') // never a kernel-invented random key
    const rounds = await readFile(paths.roundsJsonl, 'utf-8').catch(() => '')
    expect(rounds.trim()).toBe('') // the round is parked, not accounted
    void (0 as unknown as RoundEntry)
  })
})

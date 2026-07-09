/**
 * v3 route/status semantics — regression suite for the mode/route/status
 * redesign:
 *   • pivot is a ONE-SHOT scheduled directive (ROUTE sets nextRoundMode, the
 *     next MODE consumes it) — not a re-firing side effect;
 *   • progress.status is a total function of the RouteDecision
 *     (healthy|stale|pivot_scheduled|paused_attention|completed);
 *   • escalate → migrate (human ack) resets the offending meters, so the loop
 *     RUNS after re-arm instead of instantly pausing again;
 *   • the finalizer seat writes the report narrative on graceful finalize.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import type { SubAgentRecord } from '../../subagent/types.js'
import { makeSubAgentTaskId } from '../../subagent/types.js'
import { createInstance, loadInstance } from '../instance/InstanceStore.js'
import { migrateInstance } from '../instance/Migrate.js'
import { WakeStore } from '../wake/WakeStore.js'
import { tickOnce, runUntilQuiescent } from '../runner.js'
import { instancePaths, type RoundEntry } from '../types.js'
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
const isPivoter = (t: string) => t.includes('结构性转向座位')
const isFinalizer = (t: string) => t.includes('收尾叙事座位')

async function writeDrafts(draftsDir: string, key: string): Promise<void> {
  await mkdir(draftsDir, { recursive: true })
  await writeFile(join(draftsDir, 'direction.json'), JSON.stringify({ key, rationale: 't' }), 'utf-8')
  await writeFile(join(draftsDir, 'findings_draft.json'),
    JSON.stringify([{ claim: `c-${key}`, evidence: 'e' }]), 'utf-8')
}

async function readRounds(paths: ReturnType<typeof instancePaths>): Promise<RoundEntry[]> {
  return (await readFile(paths.roundsJsonl, 'utf-8')).trim().split('\n').map(l => JSON.parse(l) as RoundEntry)
}

describe('v3 pivot — one-shot scheduled directive + status vocabulary', () => {
  it('ROUTE schedules pivot once, MODE consumes it, statuses track the route exactly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-v3-pivot-'))
    const paths = instancePaths(dir, 'walk-research-v1')
    let workerRound = 0
    let pivoterCalls = 0
    // r1/r2 stale (0 findings, negative delta) → pivot scheduled at r2;
    // r3 pivot round recovers → stale resets; r4 healthy; r5 finalize.
    const judgeData = [
      { verdict: 'pass', new_findings_count: 0, metric_delta: -0.1, metric: null, messages: [] },
      { verdict: 'pass', new_findings_count: 0, metric_delta: -0.1, metric: null, messages: [] },
      { verdict: 'pass', new_findings_count: 1, metric_delta: 0.1, metric: 0.5, messages: [] },
      { verdict: 'pass', new_findings_count: 1, metric_delta: 0.1, metric: 0.6, messages: [] },
      { verdict: 'pass', new_findings_count: 1, metric_delta: 0.1, metric: 0.7, messages: [] },
    ]
    const dispatcher = scriptedDispatcher(async task => {
      if (isWorker(task)) {
        workerRound++
        await writeDrafts(paths.draftsDir, `dir-${workerRound}`)
        return { label: 'ok' }
      }
      if (isJudge(task)) return judgeData.shift()!
      if (isPivoter(task)) {
        pivoterCalls++
        return { directive: '换证据源', key: `pivot-${pivoterCalls}` }
      }
      throw new Error('unexpected seat')
    })
    const charter = walkResearchCharter({
      tripwires: [
        { when: 'stale_count >= 4', then: { act: 'escalate', reason: 'attention' } },
        { when: 'stale_count >= 2', then: { act: 'pivot' } },
        { when: 'iteration >= 5', then: { act: 'finalize' } },
      ],
    })
    const inst = await createInstance({ projectDir: dir, charter, wakeStore: new WakeStore(dir) })
    const deps = { dispatcher, projectDir: dir }

    // Round-by-round: progress.status must be a total function of the route.
    await tickOnce(deps)
    expect((await inst.ledger.readProgress()).status).toBe('stale')
    await tickOnce(deps)
    let progress = await inst.ledger.readProgress()
    expect(progress.status).toBe('pivot_scheduled')
    expect(progress.nextRoundMode).toBe('pivot')
    await tickOnce(deps)
    progress = await inst.ledger.readProgress()
    expect(progress.status).toBe('healthy')
    expect(progress.nextRoundMode).toBeUndefined() // one-shot: consumed and cleared
    await runUntilQuiescent(deps)

    expect(pivoterCalls).toBe(1) // exactly the one scheduled pivot round
    const rounds = await readRounds(paths)
    expect(rounds.map(r => r.mode)).toEqual(['normal', 'normal', 'pivot', 'normal', 'normal'])
    expect(rounds[1]!.route).toMatchObject({ kind: 'pivot', cause: 'tripwire', tripwireIndex: 1 })
    expect((await inst.ledger.readProgress()).status).toBe('completed')
    expect(JSON.parse(await readFile(paths.instanceJson, 'utf-8')).status).toBe('done')
  })
})

describe('v3 escalate — pause, re-arm, run again', () => {
  it('escalate records the fired tripwire; migrate resets its meters and the loop RUNS', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-v3-rearm-'))
    const paths = instancePaths(dir, 'walk-research-v1')
    let workerRound = 0
    const dispatcher = scriptedDispatcher(async task => {
      if (isWorker(task)) {
        workerRound++
        await writeDrafts(paths.draftsDir, `dir-${workerRound}`)
        return { label: 'ok' }
      }
      if (isJudge(task)) {
        return { verdict: 'pass', new_findings_count: 0, metric_delta: -0.1, metric: null, messages: [] }
      }
      throw new Error('unexpected seat')
    })
    const tripwires = [
      { when: 'stale_count >= 2', then: { act: 'escalate', reason: 'stuck' } as const },
      { when: 'iteration >= 10', then: { act: 'finalize' } as const },
    ]
    const charter = walkResearchCharter({ tripwires })
    await createInstance({ projectDir: dir, charter, wakeStore: new WakeStore(dir) })
    const deps = { dispatcher, projectDir: dir }
    await runUntilQuiescent(deps)

    // Paused with the fired tripwire recorded; progress mirrors the same fact.
    let inst = (await loadInstance(dir, 'walk-research-v1'))!
    expect(inst.record.status).toBe('paused_attention')
    expect(inst.record.lastEscalation).toMatchObject({ tripwireIndex: 0, reason: 'stuck' })
    expect((await inst.ledger.readProgress()).status).toBe('paused_attention')
    expect((await readRounds(paths)).at(-1)!.route).toMatchObject({ kind: 'escalate', reason: 'stuck' })

    // Human ack = migrate. The offending meter resets, so the next round RUNS.
    const entry = await migrateInstance(inst, walkResearchCharter({ version: 2, tripwires }), {
      wakeStore: new WakeStore(dir), projectDir: dir,
    })
    expect(entry.reArmed).toBe(true)
    expect(entry.resetMeters).toEqual(['stale_count'])
    expect(inst.record.lastEscalation).toBeUndefined()

    const workersBefore = workerRound
    await tickOnce(deps)
    expect(workerRound).toBe(workersBefore + 1) // a real round ran — no instant re-pause
    inst = (await loadInstance(dir, 'walk-research-v1'))!
    expect(inst.record.status).toBe('idle')
    expect((await inst.ledger.readProgress()).status).toBe('stale') // stale 1 again, not 2
  })
})

describe('v3 finalizer seat', () => {
  it('writes the narrative section of the final report and its cost is accounted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-v3-final-'))
    const paths = instancePaths(dir, 'walk-research-v1')
    const dispatcher = scriptedDispatcher(async task => {
      if (isWorker(task)) {
        await writeDrafts(paths.draftsDir, 'dir-1')
        return { label: 'ok' }
      }
      if (isJudge(task)) {
        return { verdict: 'pass', new_findings_count: 1, metric_delta: 0.1, metric: 0.5, messages: [] }
      }
      if (isFinalizer(task)) return { narrative: '完成：验证了步态假设，建议后续做接触相位消融。' }
      throw new Error('unexpected seat')
    })
    const charter = walkResearchCharter({
      tripwires: [{ when: 'iteration >= 1', then: { act: 'finalize', reason: 'time-box' } }],
      seats: {
        worker: { context: 'isolated', prompt: 'W' },
        judge: { context: 'isolated', prompt: 'J', inputs: ['drafts/findings_draft.json'] },
        finalizer: { context: 'isolated', prompt: '总结本 loop。' },
      },
    })
    await createInstance({ projectDir: dir, charter, wakeStore: new WakeStore(dir) })
    await runUntilQuiescent({ dispatcher, projectDir: dir })

    const record = JSON.parse(await readFile(paths.instanceJson, 'utf-8'))
    expect(record.status).toBe('done')
    expect(record.statusReason).toContain('time-box')
    const report = await readFile(join(paths.reportsDir, 'final_report.md'), 'utf-8')
    expect(report).toContain('Narrative (finalizer seat)')
    expect(report).toContain('接触相位消融')
    // worker 0.1 + judge 0.1 + finalizer 0.1
    const inst = (await loadInstance(dir, 'walk-research-v1'))!
    expect((await inst.ledger.readProgress()).totalCostUsd).toBeCloseTo(0.3)
    expect((await inst.ledger.readProgress()).status).toBe('completed')
  })
})

/**
 * M1 acceptance (spec T1.8): the walk-research loop runs unattended with
 * SIMULATED seats — a scripted dispatcher plays worker/judge/pivoter by
 * writing drafts and returning structured verdicts, exactly the file/data
 * contract real seats will honour. Asserts:
 *   • 3 rounds unattended → finalize tripwire → done + final report
 *   • ledger is complete and audited (rounds/findings/directions/progress)
 *   • stale → pivot → attention escalation path
 *   • corrective retry on duplicate direction and judge fail
 *   • replay determinism: same script ⇒ same routes/meters
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import type { SubAgentRecord } from '../../subagent/types.js'
import { makeSubAgentTaskId } from '../../subagent/types.js'
import { createInstance } from '../instance/InstanceStore.js'
import { WakeStore } from '../wake/WakeStore.js'
import { runUntilQuiescent } from '../runner.js'
import { instancePaths, type RoundEntry } from '../types.js'
import { walkResearchCharter } from './testCharter.js'

/** A seat impersonator: inspects the task text, performs file side-effects,
 * returns the structured data a real seat would submit via return_result. */
type SeatScript = (task: string) => Promise<Record<string, unknown>>

function scriptedDispatcher(script: SeatScript, costPerSpawn = 0.1): ISubAgentDispatcher & { spawns: string[] } {
  const spawns: string[] = []
  return {
    spawns,
    async spawnSubAgent({ config }) {
      spawns.push(config.taskDescription)
      const output = await script(config.taskDescription)
      const rec: SubAgentRecord = {
        schemaVersion: '1.0',
        taskId: makeSubAgentTaskId(),
        parentSessionId: 'test',
        status: 'completed',
        config: config as SubAgentRecord['config'],
        createdAt: Date.now(),
        completedAt: Date.now(),
        pendingHumanApproval: false,
        result: {
          success: true, summary: 'scripted seat', output,
          turnsUsed: 1, inputTokens: 0, outputTokens: 0,
          costUsd: costPerSpawn, durationMs: 1,
        },
      }
      return rec
    },
    async getStatus() { return null },
    async cancelTask() { return true },
  }
}

const isWorker = (task: string) => task.includes('产出契约')
const isJudge = (task: string) => task.includes('隔离评审座位')
const isPivoter = (task: string) => task.includes('结构性转向座位')

async function writeWorkerDrafts(draftsDir: string, key: string, findings: unknown[]): Promise<void> {
  await mkdir(draftsDir, { recursive: true })
  await writeFile(join(draftsDir, 'direction.json'), JSON.stringify({ key, rationale: 'test' }), 'utf-8')
  await writeFile(join(draftsDir, 'findings_draft.json'), JSON.stringify(findings), 'utf-8')
}

describe('M1 acceptance — walk-research loop, simulated seats', () => {
  it('tracks the minimum metric when charter.metric.direction is min', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-min-metric-'))
    const paths = instancePaths(dir, 'walk-research-v1')
    let workerRound = 0
    const metrics = [10, 8]
    const dispatcher = scriptedDispatcher(async task => {
      if (isWorker(task)) {
        workerRound++
        await writeWorkerDrafts(paths.draftsDir, `min-${workerRound}`, [])
        return { label: 'ok' }
      }
      if (isJudge(task)) {
        return {
          verdict: 'pass', new_findings_count: 0, metric_delta: 1,
          metric: metrics.shift(), messages: [],
        }
      }
      throw new Error('unexpected seat')
    })
    await createInstance({
      projectDir: dir, wakeStore: new WakeStore(dir),
      charter: walkResearchCharter({
        metric: { direction: 'min' },
        tripwires: [{ when: 'iteration >= 2', then: { act: 'finalize' } }],
      }),
    })
    await runUntilQuiescent({ dispatcher, projectDir: dir })
    const progress = JSON.parse(await readFile(paths.progressJson, 'utf-8'))
    expect(progress.bestMetric).toBe(8)
  })

  it('runs 3 rounds unattended, hits the finalize tripwire, leaves a full ledger', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-accept-'))
    const paths = instancePaths(dir, 'walk-research-v1')
    let workerRound = 0
    const judgeData = [
      { verdict: 'pass', new_findings_count: 1, metric_delta: 0.02, metric: 0.5, messages: [] },
      { verdict: 'pass', new_findings_count: 0, metric_delta: -0.1, metric: 0.4, messages: [] },
      { verdict: 'pass', new_findings_count: 1, metric_delta: 0.05, metric: 0.55, messages: [] },
    ]
    const dispatcher = scriptedDispatcher(async task => {
      if (isWorker(task)) {
        workerRound++
        await writeWorkerDrafts(paths.draftsDir, `dir-${workerRound}`,
          [{ claim: `finding-${workerRound}`, evidence: 'sim-train-curve' }])
        return { label: 'ok', note: `round ${workerRound} done` }
      }
      if (isJudge(task)) return judgeData.shift()!
      throw new Error('unexpected seat: ' + task.slice(0, 80))
    })

    await createInstance({ projectDir: dir, charter: walkResearchCharter(), wakeStore: new WakeStore(dir) })
    await runUntilQuiescent({ dispatcher, projectDir: dir })

    // Terminal state: finalize at iteration>=3 → done + final report.
    const record = JSON.parse(await readFile(paths.instanceJson, 'utf-8'))
    expect(record.status).toBe('done')
    const report = await readFile(join(paths.reportsDir, 'final_report.md'), 'utf-8')
    expect(report).toContain('rounds: 3')

    // Ledger audit: 3 rounds + a terminal entry, findings admitted, meters exact.
    const rounds = (await readFile(paths.roundsJsonl, 'utf-8')).trim().split('\n')
      .map(l => JSON.parse(l) as RoundEntry)
    expect(rounds.map(r => r.route.kind)).toEqual(['continue', 'continue', 'finalize'])
    expect(rounds[2]!.route).toMatchObject({ cause: 'tripwire', tripwireIndex: 2 })
    expect(rounds[0]!.meters).toEqual({ iteration: 1, stale_count: 0 })
    expect(rounds[1]!.meters).toEqual({ iteration: 2, stale_count: 1 }) // 0 findings → stale
    expect(rounds[2]!.meters).toEqual({ iteration: 3, stale_count: 0 }) // recovered
    const findings = (await readFile(paths.findingsJsonl, 'utf-8')).trim().split('\n')
    expect(findings).toHaveLength(3)
    const progress = JSON.parse(await readFile(paths.progressJson, 'utf-8'))
    expect(progress.bestMetric).toBe(0.55)
    expect(progress.totalCostUsd).toBeCloseTo(0.6) // 3 rounds × (worker+judge) × $0.1

    // Independence (D6): no judge task ever contains worker reasoning.
    for (const task of dispatcher.spawns.filter(isJudge)) {
      expect(task).not.toContain('产出契约')
      expect(task).toContain('证据（内嵌，只此为界）')
    }
  })

  it('escalates stale → pivot → attention with pivoter participation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-escal-'))
    const paths = instancePaths(dir, 'walk-research-v1')
    let workerRound = 0
    let pivoterCalls = 0
    const dispatcher = scriptedDispatcher(async task => {
      if (isWorker(task)) {
        workerRound++
        await writeWorkerDrafts(paths.draftsDir, `dir-${workerRound}`, [])
        return { label: 'ok' }
      }
      if (isJudge(task)) {
        return { verdict: 'pass', new_findings_count: 0, metric_delta: -0.1, metric: null, messages: [] }
      }
      if (isPivoter(task)) {
        pivoterCalls++
        return { directive: '换接触相位约束', key: `pivot-${pivoterCalls}` }
      }
      throw new Error('unexpected seat')
    })

    // Allow more iterations so stale_count can reach 4 before finalize.
    const charter = walkResearchCharter({
      tripwires: [
        { when: 'stale_count >= 4', then: { act: 'escalate', reason: 'attention' } },
        { when: 'stale_count >= 2', then: { act: 'pivot' } },
        { when: 'iteration >= 10', then: { act: 'finalize' } },
      ],
    })
    await createInstance({ projectDir: dir, charter, wakeStore: new WakeStore(dir) })
    await runUntilQuiescent({ dispatcher, projectDir: dir })

    const record = JSON.parse(await readFile(paths.instanceJson, 'utf-8'))
    expect(record.status).toBe('paused_attention')
    expect(pivoterCalls).toBeGreaterThanOrEqual(1) // pivot rounds engaged the pivoter
    const report = await readFile(join(paths.reportsDir, 'attention_report.md'), 'utf-8')
    expect(report).toContain('attention')
    // The pivot round's capsule carried the directive to the worker.
    const pivotWorkerTask = dispatcher.spawns.find(t => isWorker(t) && t.includes('结构性转向指令'))
    expect(pivotWorkerTask).toBeDefined()
    expect(pivotWorkerTask).toContain('接触相位约束')
    // Escalation cancelled future wakes — the loop is genuinely stopped.
    expect((await new WakeStore(dir).claimDue(Date.now() + 1e9)).length).toBe(0)
  })

  it('corrective retry: duplicate direction and judge fail each get exactly one rerun', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-retry-'))
    const paths = instancePaths(dir, 'walk-research-v1')
    let workerCalls = 0
    let judgeCalls = 0
    const dispatcher = scriptedDispatcher(async task => {
      if (isWorker(task)) {
        workerCalls++
        // Attempt 1 duplicates a tried direction; the corrective retry fixes it.
        const key = workerCalls === 1 ? 'already-tried' : `fresh-${workerCalls}`
        await writeWorkerDrafts(paths.draftsDir, key, [{ claim: 'c', evidence: 'e' }])
        return { label: 'ok' }
      }
      if (isJudge(task)) {
        judgeCalls++
        // First judge verdict fails with messages → one worker rerun → pass.
        return judgeCalls === 1
          ? { verdict: 'fail', new_findings_count: 0, metric_delta: 0, metric: null, messages: ['缺证据'] }
          : { verdict: 'pass', new_findings_count: 1, metric_delta: 0.1, metric: 0.3, messages: [] }
      }
      throw new Error('unexpected seat')
    })

    const charter = walkResearchCharter({
      tripwires: [{ when: 'iteration >= 1', then: { act: 'finalize' } }],
    })
    const inst = await createInstance({ projectDir: dir, charter, wakeStore: new WakeStore(dir) })
    // Seed a tried direction so attempt 1 collides.
    await inst.ledger.replaceJson(paths.directionsJson, { directions: [{ key: 'already-tried' }] })

    await runUntilQuiescent({ dispatcher, projectDir: dir })

    // worker: dup attempt + retry (diversity) + judge-fail retry = 3 calls;
    // dedup check consumed no judge; judge ran twice (fail then pass).
    expect(workerCalls).toBe(3)
    expect(judgeCalls).toBe(2)
    const rounds = (await readFile(paths.roundsJsonl, 'utf-8')).trim().split('\n')
      .map(l => JSON.parse(l) as RoundEntry)
    expect(rounds[0]!.correctiveRetries).toBe(2)
    // Corrective prefaces reached the worker verbatim.
    expect(dispatcher.spawns.some(t => t.includes('完全重复'))).toBe(true)
    expect(dispatcher.spawns.some(t => t.includes('评审未通过'))).toBe(true)
  })

  it('replay determinism: identical script ⇒ identical routes and meters', async () => {
    const run = async () => {
      const dir = await mkdtemp(join(tmpdir(), 'loop-replay-'))
      const paths = instancePaths(dir, 'walk-research-v1')
      let n = 0
      const judgeData = [
        { verdict: 'pass', new_findings_count: 1, metric_delta: 0.1, metric: 0.1, messages: [] },
        { verdict: 'pass', new_findings_count: 0, metric_delta: 0, metric: 0.1, messages: [] },
        { verdict: 'pass', new_findings_count: 1, metric_delta: 0.2, metric: 0.3, messages: [] },
      ]
      const dispatcher = scriptedDispatcher(async task => {
        if (isWorker(task)) {
          n++
          await writeWorkerDrafts(paths.draftsDir, `d${n}`, [{ claim: `f${n}`, evidence: 'e' }])
          return { label: 'ok' }
        }
        if (isJudge(task)) return judgeData.shift()!
        throw new Error('unexpected')
      })
      await createInstance({ projectDir: dir, charter: walkResearchCharter(), wakeStore: new WakeStore(dir) })
      await runUntilQuiescent({ dispatcher, projectDir: dir })
      const rounds = (await readFile(paths.roundsJsonl, 'utf-8')).trim().split('\n')
        .map(l => JSON.parse(l) as RoundEntry)
      return rounds.map(r => `${r.round}:${r.mode}:${JSON.stringify(r.route)}:${JSON.stringify(r.meters)}`)
    }
    const [a, b] = await Promise.all([run(), run()])
    expect(a).toEqual(b)
  })
})

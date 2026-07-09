/**
 * self_timer wait — the worker parks itself via the timer tool, the kernel
 * schedules a plain timer wake (NO effect ledger), and resumes the same round
 * at fireAt with a "continue" preface. Calling timer hard-ends the segment (the
 * runner enforces the park; here the scripted dispatcher returns {label:'wait'}).
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
import { instancePaths, type PendingRound, type RoundEntry } from '../types.js'
import { readPendingRound } from '../effects/WaitOps.js'
import { atomicWriteJson } from '../../infra/persist/index.js'
import { walkResearchCharter } from './testCharter.js'

type SeatScript = (task: string, config: SubAgentRecord['config']) => Promise<Record<string, unknown>>

function scriptedDispatcher(script: SeatScript): ISubAgentDispatcher & { spawns: string[] } {
  const spawns: string[] = []
  return {
    spawns,
    async spawnSubAgent({ config }) {
      spawns.push(config.taskDescription)
      const output = await script(config.taskDescription, config as SubAgentRecord['config'])
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

const isWorker = (t: string) => t.includes('产出契约') || t.includes('草稿目录')
const isContinue = (t: string) => t.includes('【继续】')
const isJudge = (t: string) => t.includes('隔离评审座位')

async function callTimer(config: SubAgentRecord['config'], minutes: number, reason: string): Promise<void> {
  const tool = config.extraTools?.find(t => t.name === 'timer')
  await tool?.call({ minutes, reason })
}
async function writeHarvestDrafts(paths: ReturnType<typeof instancePaths>): Promise<void> {
  await mkdir(paths.draftsDir, { recursive: true })
  await writeFile(join(paths.draftsDir, 'direction.json'), JSON.stringify({ key: 'dir-1' }), 'utf-8')
  await writeFile(join(paths.draftsDir, 'findings_draft.json'),
    JSON.stringify([{ claim: 'watched training to done', evidence: 'curve' }]), 'utf-8')
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'loop-selftimer-'))
  const paths = instancePaths(dir, 'walk-research-v1')
  const charter = walkResearchCharter({
    seats: {
      worker: { context: 'lineage_loop', prompt: 'W' },
      judge: { context: 'isolated', prompt: 'J', inputs: ['drafts/findings_draft.json'] },
    },
    tripwires: [{ when: 'iteration >= 1', then: { act: 'finalize' } }],
  })
  await createInstance({ projectDir: dir, charter, wakeStore: new WakeStore(dir) })
  return { dir, paths }
}

describe('self_timer wait', () => {
  it('worker parks via timer → self_timer pending + timer wake (no effect) → resume completes the round', async () => {
    const { dir, paths } = await setup()
    const dispatcher = scriptedDispatcher(async (task, config) => {
      if (isWorker(task) && !isContinue(task)) {
        await callTimer(config, 30, '看训练进度')
        return { label: 'wait' }
      }
      if (isContinue(task)) { await writeHarvestDrafts(paths); return { label: 'ok' } }
      if (isJudge(task)) return { verdict: 'pass', new_findings_count: 1, metric_delta: 0.1, metric: 0.5, messages: [] }
      throw new Error('unexpected seat: ' + task.slice(0, 40))
    })
    const deps = { dispatcher, projectDir: dir }

    // Tick 1: submit → self_timer park.
    await tickOnce(deps)
    const pending = (await readPendingRound((await loadInstance(dir, 'walk-research-v1'))!))!
    expect(pending.kind).toBe('self_timer')
    expect(pending.reason).toBe('看训练进度')
    expect(JSON.parse(await readFile(paths.instanceJson, 'utf-8')).status).toBe('waiting')
    // No effect ledger was created for a self-timer park.
    await expect(readFile(paths.effectsJsonl, 'utf-8')).rejects.toBeTruthy()

    // Simulate the 30 min elapsing: rewind fireAt and fire a due timer wake.
    await atomicWriteJson(paths.pendingRoundJson, { ...pending, fireAt: Date.now() - 1 } satisfies PendingRound)
    await new WakeStore(dir).schedule({ loopId: 'walk-research-v1', kind: 'timer', fireAt: Date.now() })

    // Tick 2: due timer → resume (continue) → harvest → complete + stop.
    await tickOnce(deps)
    expect(dispatcher.spawns.some(isContinue)).toBe(true)
    const rounds = (await readFile(paths.roundsJsonl, 'utf-8')).trim().split('\n').map(l => JSON.parse(l) as RoundEntry)
    expect(rounds).toHaveLength(1)
    expect(rounds[0]!.round).toBe(1)
    expect(rounds[0]!.route).toMatchObject({ kind: 'finalize', cause: 'tripwire' })
    expect(await readPendingRound((await loadInstance(dir, 'walk-research-v1'))!)).toBeNull()
    expect(JSON.parse(await readFile(paths.instanceJson, 'utf-8')).status).toBe('done')
  })

  it('timer enforces 5..180 minute bounds and records the intent', async () => {
    const { dir } = await setup()
    let captured: unknown = null
    const dispatcher = scriptedDispatcher(async (task, config) => {
      if (isWorker(task) && !isContinue(task)) {
        const tool = config.extraTools?.find(t => t.name === 'timer')!
        // Auto mode gates out tools without an abort-safe contract; the loop
        // worker seat is auto, so timer MUST declare abortSupport or it's disabled.
        expect(tool.abortSupport).toBeDefined()
        expect(tool.abortSupport).not.toBe('non_cooperative')
        const tooShort = await tool.call({ minutes: 2, reason: 'r' })
        const tooLong  = await tool.call({ minutes: 300, reason: 'r' })
        captured = { tooShort: tooShort.isError, tooLong: tooLong.isError }
        await tool.call({ minutes: 30, reason: '看训练进度' }) // valid → parks
        return { label: 'wait' }
      }
      if (isJudge(task)) return { verdict: 'pass', new_findings_count: 1, metric_delta: 0.1, metric: 0.5, messages: [] }
      throw new Error('unexpected seat')
    })
    await tickOnce({ dispatcher, projectDir: dir })
    expect(captured).toEqual({ tooShort: true, tooLong: true })
    // No timer_cancel tool is offered anymore.
    // (park is enforced by the runner on the timer tool_result — see SubAgentRunner.)
  })
})

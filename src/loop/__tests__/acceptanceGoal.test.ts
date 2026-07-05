/**
 * Built-in acceptance — the judge reporting goal_satisfied ends the loop via the
 * KERNEL, independent of any charter tripwire (symmetric with the lifetime
 * budget backstop).
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
import { walkResearchCharter } from './testCharter.js'

function scriptedDispatcher(script: (task: string) => Promise<Record<string, unknown>>): ISubAgentDispatcher {
  return {
    async spawnSubAgent({ config }) {
      const output = await script(config.taskDescription)
      return {
        schemaVersion: '1.0', taskId: makeSubAgentTaskId(), parentSessionId: 't',
        status: 'completed', config: config as SubAgentRecord['config'],
        createdAt: Date.now(), completedAt: Date.now(), pendingHumanApproval: false,
        result: { success: true, summary: 'scripted', output, turnsUsed: 1, inputTokens: 0, outputTokens: 0, costUsd: 0.1, durationMs: 1 },
      } satisfies SubAgentRecord
    },
    async getStatus() { return null },
    async cancelTask() { return true },
  }
}

const isJudge = (t: string) => t.includes('隔离评审座位')
const isWorker = (t: string) => t.includes('草稿目录')

describe('built-in acceptance (judge goal_satisfied)', () => {
  it('ends the loop from the kernel even when no tripwire would stop this round', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-accept-'))
    const paths = instancePaths(dir, 'walk-research-v1')
    const charter = walkResearchCharter({
      // Tripwires that will NOT fire at round 1 — so only acceptance can end it.
      tripwires: [{ when: 'iteration >= 100', then: { mode: 'finalize', stop: true } }],
      budgets: { perRound: { usd: 6 }, lifetime: { rounds: 100 } },
      seats: {
        worker: { context: 'isolated', prompt: 'W' },
        judge: { context: 'isolated', prompt: 'J', inputs: ['drafts/findings_draft.json'] },
      },
    })
    await createInstance({ projectDir: dir, charter, wakeStore: new WakeStore(dir) })

    const dispatcher = scriptedDispatcher(async task => {
      if (isWorker(task)) {
        await mkdir(paths.draftsDir, { recursive: true })
        await writeFile(join(paths.draftsDir, 'direction.json'), JSON.stringify({ key: 'd1' }), 'utf-8')
        await writeFile(join(paths.draftsDir, 'findings_draft.json'),
          JSON.stringify([{ claim: 'goal reached', evidence: 'e' }]), 'utf-8')
        return { label: 'ok' }
      }
      if (isJudge(task)) {
        return { verdict: 'pass', new_findings_count: 1, metric_delta: 0.2, metric: 0.9, goal_satisfied: true, messages: [] }
      }
      throw new Error('unexpected seat')
    })

    await tickOnce({ dispatcher, projectDir: dir })

    const rec = JSON.parse(await readFile(paths.instanceJson, 'utf-8'))
    expect(rec.status).toBe('done')
    expect(rec.statusReason).toContain('goal_satisfied')
    const rounds = (await readFile(paths.roundsJsonl, 'utf-8')).trim().split('\n').map(l => JSON.parse(l) as RoundEntry)
    expect(rounds).toHaveLength(1)
    expect(rounds[0]!.route).toBe('finalize:goal_satisfied')
    // Final report written (clean finalize, not attention).
    await expect(readFile(join(paths.reportsDir, 'final_report.md'), 'utf-8')).resolves.toContain('goal_satisfied')
    expect((await loadInstance(dir, 'walk-research-v1'))!.record.status).toBe('done')
  })
})

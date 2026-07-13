/**
 * loop-scheduler daemon (T2.4): drives a waiting loop to completion end-to-end
 * with NO manual pumping — probes inline, harvest dispatched, idle exit when
 * the workspace is quiescent, host lock exclusivity.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import type { SubAgentRecord } from '../../subagent/types.js'
import { makeSubAgentTaskId } from '../../subagent/types.js'
import { createInstance } from '../instance/InstanceStore.js'
import { WakeStore } from '../wake/WakeStore.js'
import { runLoopScheduler } from '../daemon.js'
import { instancePaths } from '../types.js'
import { walkResearchCharter } from './testCharter.js'

function scriptedDispatcher(script: (task: string) => Promise<Record<string, unknown>>): ISubAgentDispatcher {
  return {
    async spawnSubAgent({ config }) {
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

describe('runLoopScheduler', () => {
  it('drives submit(event wait) → external event → harvest → finalize, then idle-exits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-daemon-'))
    const paths = instancePaths(dir, 'walk-research-v1')

    const dispatcher = scriptedDispatcher(async task => {
      if (task.includes('收割段')) {
        await mkdir(paths.draftsDir, { recursive: true })
        await writeFile(join(paths.draftsDir, 'findings_draft.json'),
          JSON.stringify([{ claim: 'done at 0.6', evidence: 'curve' }]), 'utf-8')
        return { label: 'ok' }
      }
      if (task.includes('产出契约')) {
        // Submit an event wait; an external system drops the completion event
        // shortly after — the daemon ingests it on its next tick (no help).
        setTimeout(() => {
          void mkdir(paths.eventsDir, { recursive: true })
            .then(() => writeFile(join(paths.eventsDir, 'done.json'),
              JSON.stringify({ effectKey: 'exp-d', verdict: 'done', data: { final: 0.6 } }), 'utf-8'))
            .catch(() => undefined)
        }, 30)
        return { label: 'wait', effectKey: 'exp-d' }
      }
      if (task.includes('隔离评审座位')) {
        return { verdict: 'pass', new_findings_count: 1, metric_delta: 0.5, metric: 0.6, messages: [] }
      }
      throw new Error('unexpected seat')
    })

    await createInstance({
      projectDir: dir,
      charter: walkResearchCharter({
        tripwires: [{ when: 'iteration >= 1', then: { act: 'finalize' } }],
      }),
      wakeStore: new WakeStore(dir),
    })

    const result = await runLoopScheduler({
      dispatcher, projectDir: dir,
      pollMs: 10, idleExitMs: 50,
    })

    expect(result.exitReason).toBe('idle')
    expect(result.roundsRun).toBeGreaterThanOrEqual(2) // submit segment + harvest
    const record = JSON.parse(await readFile(paths.instanceJson, 'utf-8'))
    expect(record.status).toBe('done')
    const report = await readFile(join(paths.reportsDir, 'final_report.md'), 'utf-8')
    expect(report).toContain('total findings: 1')
  }, 15_000)

  it('host lock: a second daemon backs off while the first runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-daemon-lock-'))
    const dispatcher = scriptedDispatcher(async () => ({ label: 'ok' }))
    const abort = new AbortController()
    const first = runLoopScheduler({
      dispatcher, projectDir: dir, pollMs: 10, idleExitMs: 5_000, signal: abort.signal,
    })
    await new Promise(r => setTimeout(r, 50)) // let it take the lock
    const second = await runLoopScheduler({ dispatcher, projectDir: dir, pollMs: 10, idleExitMs: 50 })
    expect(second.exitReason).toBe('lock_held')
    abort.abort()
    expect((await first).exitReason).toBe('aborted')
    // Lock released → a third daemon can now run to idle-exit.
    const third = await runLoopScheduler({ dispatcher, projectDir: dir, pollMs: 10, idleExitMs: 30 })
    expect(third.exitReason).toBe('idle')
  }, 15_000)

  it('refreshes the host lease while a long tick is still running', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-daemon-heartbeat-'))
    const dispatcher = scriptedDispatcher(async task => {
      if (task.includes('隔离评审座位')) return { verdict: 'pass', messages: [] }
      await new Promise(r => setTimeout(r, 250))
      return { label: 'ok' }
    })
    await createInstance({
      projectDir: dir,
      charter: walkResearchCharter({
        tripwires: [{ when: 'iteration >= 1', then: { act: 'finalize' } }],
      }),
      wakeStore: new WakeStore(dir),
    })
    const abort = new AbortController()
    const run = runLoopScheduler({
      dispatcher, projectDir: dir, pollMs: 10, idleExitMs: 5_000,
      signal: abort.signal, lockFreshMs: 120, lockHeartbeatMs: 20,
    })
    const lockPath = join(dir, '.loop', 'daemon.lock')
    await new Promise(r => setTimeout(r, 40))
    const firstMtime = (await stat(lockPath)).mtimeMs
    await new Promise(r => setTimeout(r, 80))
    const refreshedMtime = (await stat(lockPath)).mtimeMs
    expect(refreshedMtime).toBeGreaterThan(firstMtime)
    abort.abort()
    await run
  }, 15_000)

  it('runs independent loops concurrently without head-of-line blocking', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-daemon-concurrent-'))
    const completionOrder: string[] = []
    const dispatcher = scriptedDispatcher(async task => {
      if (task.includes('隔离评审座位')) {
        return { verdict: 'pass', new_findings_count: 0, metric_delta: 0, metric: 0, messages: [] }
      }
      if (task.includes('slow-loop')) {
        await new Promise(resolve => setTimeout(resolve, 180))
        completionOrder.push('slow')
      } else if (task.includes('fast-loop')) {
        completionOrder.push('fast')
      }
      return { label: 'ok' }
    })
    const terminal = [{ when: 'iteration >= 1', then: { act: 'finalize' as const } }]
    await createInstance({
      projectDir: dir, instanceId: 'slow', wakeStore: new WakeStore(dir),
      charter: walkResearchCharter({ goal: 'slow-loop', tripwires: terminal }),
    })
    await createInstance({
      projectDir: dir, instanceId: 'fast', wakeStore: new WakeStore(dir),
      charter: walkResearchCharter({ goal: 'fast-loop', tripwires: terminal }),
    })

    const result = await runLoopScheduler({
      dispatcher, projectDir: dir, pollMs: 10, idleExitMs: 30, maxConcurrentRounds: 2,
    })
    expect(result.exitReason).toBe('idle')
    expect(completionOrder.slice(0, 2)).toEqual(['fast', 'slow'])
  }, 15_000)
})

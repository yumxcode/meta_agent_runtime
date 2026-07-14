/**
 * Regression tests for the 2026-07-14 loop review fixes
 * (docs/loop-code-review-2026-07-14.md):
 *   R1 — unclassified round errors back off and fail-stop after MAX attempts
 *        (no infinite hot retry, no unbounded re-spend)
 *   R2 — goal_satisfied from a FREE-TEXT scrape never terminates the loop
 *        (structured-only trust boundary for judge output)
 *   R5 — a 'waiting' instance with no pending_round self-heals to idle
 *   R7 — aborted-attempt cost transfers onto a live wake instead of dropping
 *   R10 — an authenticated event nonce is consumed exactly once (no replay)
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
import { reconcileWaiting } from '../effects/WaitOps.js'
import { consumeEventNonce, signEffectEvent } from '../effects/EventAuth.js'
import { walkResearchCharter } from './testCharter.js'

const INSTANCE_ID = 'walk-research-v1'

async function setup(charterOverrides?: Parameters<typeof walkResearchCharter>[0]) {
  const dir = await mkdtemp(join(tmpdir(), 'loop-fix0714-'))
  const paths = instancePaths(dir, INSTANCE_ID)
  const charter = walkResearchCharter({
    tripwires: [{ when: 'iteration >= 1', then: { act: 'finalize' } }],
    ...charterOverrides,
  })
  await createInstance({ projectDir: dir, charter, wakeStore: new WakeStore(dir) })
  return { dir, paths }
}

function scriptedDispatcher(
  script: (task: string) => Promise<{ output: unknown; success?: boolean }>,
): ISubAgentDispatcher & { spawns: string[] } {
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
          success, summary: success ? 'scripted' : '', output: output as Record<string, unknown>,
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

async function writeDrafts(paths: ReturnType<typeof instancePaths>): Promise<void> {
  await mkdir(paths.draftsDir, { recursive: true })
  await writeFile(join(paths.draftsDir, 'direction.json'), JSON.stringify({ key: 'dir-1' }), 'utf-8')
  await writeFile(
    join(paths.draftsDir, 'findings_draft.json'),
    JSON.stringify([{ claim: 'c', evidence: 'e' }]), 'utf-8',
  )
}

describe('R1 — unclassified errors: bounded retries with backoff, then fail-stop', () => {
  it('backs the wake off instead of hot-looping, and fails the instance after MAX attempts', async () => {
    const { dir } = await setup()
    const dispatcher = scriptedDispatcher(async () => { throw new Error('boom: unclassified') })
    const wakeStore = new WakeStore(dir)

    // Attempt 1: the wake must be re-queued with a FUTURE fireAt (backoff).
    const before = Date.now()
    const first = await tickOnce({ dispatcher, projectDir: dir })
    expect(first.claimed).toBe(1)
    expect(first.outcomes[0]!.error).toContain('boom')
    const requeued = (await wakeStore.list()).filter(w => w.status === 'pending')
    expect(requeued).toHaveLength(1)
    expect(requeued[0]!.fireAt).toBeGreaterThan(before)

    // Drive the clock past every backoff: the loop must fail-stop, not spin.
    let now = Date.now()
    for (let i = 0; i < 8; i++) {
      now += 10 * 60_000
      await tickOnce({ dispatcher, projectDir: dir }, now)
    }
    const instance = (await loadInstance(dir, INSTANCE_ID))!
    expect(instance.record.status).toBe('failed')
    expect(instance.record.statusReason).toMatch(/attempts/)
    // All wakes settled — nothing left to hot-loop on.
    const live = (await wakeStore.list()).filter(w => w.status === 'pending' || w.status === 'claimed')
    expect(live).toHaveLength(0)
  })
})

describe('R2 — free-text goal_satisfied never terminates the loop', () => {
  it('an unstructured judge scrape is not trusted as an acceptance verdict', async () => {
    const { dir, paths } = await setup()
    const dispatcher = scriptedDispatcher(async task => {
      if (isWorker(task)) { await writeDrafts(paths); return { output: { label: 'ok' } } }
      if (isJudge(task)) {
        // Judge "crashed" into free text that happens to contain the contract's
        // own example JSON — the last-JSON-block fallback would scrape it.
        return {
          output: '评审中断。示例：\n```json\n' + JSON.stringify({
            verdict: 'pass', new_findings_count: 1, metric_delta: 0.1,
            metric: 0.9, goal_satisfied: true, messages: [],
          }) + '\n```',
        }
      }
      throw new Error('unexpected seat: ' + task.slice(0, 40))
    })
    await tickOnce({ dispatcher, projectDir: dir })

    const rounds = (await readFile(paths.roundsJsonl, 'utf-8')).trim().split('\n')
      .map(l => JSON.parse(l) as RoundEntry)
    const last = rounds.at(-1)!
    // The loop DID finalize — but via the iteration tripwire, NOT acceptance.
    expect(last.route.kind).toBe('finalize')
    expect(last.route.cause).not.toBe('accepted')
    expect(last.route.reason).not.toBe('goal_satisfied')
  })
})

describe('R5 — waiting instance with no pending_round self-heals', () => {
  it('reconcileWaiting flips it to idle and schedules a wake', async () => {
    const { dir } = await setup()
    const wakeStore = new WakeStore(dir)
    const instance = (await loadInstance(dir, INSTANCE_ID))!
    // Simulate the `loop stop` crash window: waiting, pending cleared, wakes gone.
    await setInstanceStatus(instance, 'waiting', 'crash window')
    await wakeStore.cancelForLoop(INSTANCE_ID)

    const actions = await reconcileWaiting(instance, { wakeStore, projectDir: dir })
    expect(actions.join(';')).toMatch(/healed waiting instance/)
    expect((await loadInstance(dir, INSTANCE_ID))!.record.status).toBe('idle')
    const live = (await wakeStore.list()).filter(w => w.status === 'pending')
    expect(live).toHaveLength(1)
  })
})

describe('R7 — aborted cost is transferred, not dropped', () => {
  it('transferAbortedCost moves cost onto the earliest live wake', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-cost-'))
    const wakeStore = new WakeStore(dir)
    await wakeStore.schedule({ loopId: 'L', kind: 'timer', fireAt: Date.now() + 1000 })
    expect(await wakeStore.transferAbortedCost('L', 0.75)).toBe(true)
    expect((await wakeStore.list())[0]!.abortedCostUsd).toBeCloseTo(0.75)
    // Accumulates.
    expect(await wakeStore.transferAbortedCost('L', 0.25)).toBe(true)
    expect((await wakeStore.list())[0]!.abortedCostUsd).toBeCloseTo(1.0)
    // No live wake → reports failure so the caller can log the loss.
    expect(await wakeStore.transferAbortedCost('other-loop', 0.5)).toBe(false)
  })
})

describe('R10 — authenticated event nonces are single-use', () => {
  it('consumeEventNonce accepts once and rejects the replay', async () => {
    const { dir } = await setup()
    const instance = (await loadInstance(dir, INSTANCE_ID))!
    const event = await signEffectEvent(instance, {
      principal: 'ci', roles: ['reporter'], effectKey: 'exp-1', verdict: 'done',
    })
    expect(await consumeEventNonce(instance, event)).toBe(true)
    expect(await consumeEventNonce(instance, event)).toBe(false)
  })
})

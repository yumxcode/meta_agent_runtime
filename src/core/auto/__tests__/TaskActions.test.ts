/**
 * TaskActions — the guards, and the rule that a frontend never runs a turn.
 *
 * `cancel` and `kill` both bottom out in the same store call, and the store
 * will happily cancel a CLAIMED record — which makes the executing process lose
 * its claim and abort the model turn mid-flight. That is a useful kill switch
 * and a disastrous "cancel this timer", so the split between the two verbs is
 * load-bearing and gets tested as such.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutoContinuationStore } from '../AutoContinuationStore.js'
import { writeAutoCheckpoint, AUTO_CHECKPOINT_SCHEMA_VERSION } from '../AutoCheckpointStore.js'
import { collectTasks, type TaskView } from '../TaskRegistry.js'
import { SessionStore } from '../../SessionStore.js'
import {
  actionAvailability,
  cancelTaskWake,
  deleteTask,
  killTaskTurn,
  resumeCommandFor,
  runTaskNow,
  steerTask,
} from '../TaskActions.js'
import { pendingSteerCount } from '../SteerChannel.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'task-actions-'))
  dirs.push(dir)
  return dir
}

async function parkedTask(ws: string, fireAt: number): Promise<TaskView> {
  const store = new AutoContinuationStore(ws)
  await writeAutoCheckpoint(ws, {
    schemaVersion: AUTO_CHECKPOINT_SCHEMA_VERSION,
    sessionId: 's1', updatedAt: Date.now(), goal: 'g', stopReason: 'parked',
  })
  await store.schedule({ sessionId: 's1', fireAt, reason: 'gate', historyMessageCount: 1 })
  const [task] = await collectTasks({ workspaces: [ws] })
  // Tests drive the guards directly, so give them a live scheduler; the
  // "no scheduler" refusal has its own case below.
  return { ...task!, scheduler: { alive: true, pid: 1 } }
}

describe('run-now moves the clock; it never starts a turn', () => {
  it('brings a future wake forward so the scheduler claims it', async () => {
    const ws = await workspace()
    const task = await parkedTask(ws, Date.now() + 60 * 60_000)
    expect((await runTaskNow(task)).ok).toBe(true)

    // The proof that no turn was started: the record is still PENDING, merely
    // due. Execution stays with the scheduler.
    const store = new AutoContinuationStore(ws)
    const record = (await store.list())[0]!
    expect(record.status).toBe('pending')
    expect(record.fireAt).toBeLessThanOrEqual(Date.now())

    const [claimed] = await store.claimDue()
    expect(claimed?.wakeId).toBe(record.wakeId)
  })

  it('refuses when no scheduler would ever pick it up', async () => {
    const ws = await workspace()
    const task = await parkedTask(ws, Date.now() + 60_000)
    const dead: TaskView = { ...task, scheduler: { alive: false } }
    const result = await runTaskNow(dead)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('no scheduler')
  })

  it('refuses on an orphaned task and points at manual resume', async () => {
    const ws = await workspace()
    await writeAutoCheckpoint(ws, {
      schemaVersion: AUTO_CHECKPOINT_SCHEMA_VERSION,
      sessionId: 'ghost', updatedAt: Date.now(), stopReason: 'parked',
    })
    const [task] = await collectTasks({ workspaces: [ws] })
    expect(task!.status).toBe('orphaned')
    expect((await runTaskNow(task!)).message).toContain('resume it manually')
  })
})

describe('cancel and kill are not the same verb', () => {
  it('cancel drops a pending wake', async () => {
    const ws = await workspace()
    const task = await parkedTask(ws, Date.now() + 60_000)
    expect((await cancelTaskWake(task)).ok).toBe(true)
    expect((await new AutoContinuationStore(ws).list())[0]?.status).toBe('cancelled')
  })

  it('a deliberate cancel does not masquerade as the accident', async () => {
    // Cancelling only the wake would leave `stopReason: parked` with an empty
    // queue — the exact signature of the 2026-08-17 failure. The view would
    // then scream ORPHANED forever about something the operator meant to stop,
    // and a real orphan would be lost in the noise.
    const ws = await workspace()
    const task = await parkedTask(ws, Date.now() + 60_000)
    await cancelTaskWake(task)

    const [after] = await collectTasks({ workspaces: [ws] })
    expect(after!.status).toBe('finished')
    expect(after!.status).not.toBe('orphaned')
  })

  it('cancel refuses to touch a running turn and says which verb does', async () => {
    const ws = await workspace()
    const store = new AutoContinuationStore(ws)
    await parkedTask(ws, Date.now() - 1_000)
    await store.claimDue()
    const [running] = await collectTasks({ workspaces: [ws] })
    expect(running!.status).toBe('running')

    const result = await cancelTaskWake(running!)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('use kill')
    // Untouched — the claim is still live.
    expect((await store.list())[0]?.status).toBe('claimed')
  })

  it('kill is marked destructive and interrupts the claimed wake', async () => {
    const ws = await workspace()
    const store = new AutoContinuationStore(ws)
    await parkedTask(ws, Date.now() - 1_000)
    await store.claimDue()
    const [running] = await collectTasks({ workspaces: [ws] })

    expect(actionAvailability(running!, 'kill').destructive).toBe(true)
    const result = await killTaskTurn(running!)
    expect(result.ok).toBe(true)
    expect(result.message).toContain('not rolled back')
    expect((await store.list())[0]?.status).toBe('cancelled')
  })

  it('kill refuses when nothing is running', async () => {
    const ws = await workspace()
    const task = await parkedTask(ws, Date.now() + 60_000)
    expect((await killTaskTurn(task)).message).toContain('no turn is running')
  })
})

describe('steer', () => {
  it('queues a correction for a live session', async () => {
    const ws = await workspace()
    const task = await parkedTask(ws, Date.now() + 60_000)
    expect((await steerTask(task, 'prefer the coarse mesh')).ok).toBe(true)
    expect(await pendingSteerCount(ws, 's1')).toBe(1)
  })

  it('refuses for a session that will never run again', async () => {
    const ws = await workspace()
    await writeAutoCheckpoint(ws, {
      schemaVersion: AUTO_CHECKPOINT_SCHEMA_VERSION,
      sessionId: 'ghost', updatedAt: Date.now(), stopReason: 'parked',
    })
    const [orphan] = await collectTasks({ workspaces: [ws] })
    const result = await steerTask(orphan!, 'too late')
    expect(result.ok).toBe(false)
    expect(await pendingSteerCount(ws, 'ghost')).toBe(0)
  })
})

describe('delete removes the task and everything behind it', () => {
  it('purges wakes, checkpoint, steer queue and conversation history', async () => {
    const ws = await workspace()
    const sessionRoot = await workspace()
    const task = await parkedTask(ws, Date.now() + 60_000)
    await steerTask(task, 'a correction nobody will read')
    await SessionStore.append(
      's1',
      {
        mode: 'auto', startTime: Date.now(), lastActivity: Date.now(),
        messageCount: 1, firstPrompt: 'go', workspace: ws,
      },
      [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] as never,
      0,
      { rootDir: sessionRoot },
    )
    expect(await SessionStore.loadHistory('s1', { rootDir: sessionRoot })).toHaveLength(1)

    const result = await deleteTask({ ...task, sessionRoot })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('cannot be undone')

    expect(await collectTasks({ workspaces: [ws] })).toEqual([])
    expect(await new AutoContinuationStore(ws).list()).toEqual([])
    expect(await pendingSteerCount(ws, 's1')).toBe(0)
    expect(await SessionStore.loadHistory('s1', { rootDir: sessionRoot })).toEqual([])
  })

  it('refuses while a turn is running, and says to kill first', async () => {
    const ws = await workspace()
    const store = new AutoContinuationStore(ws)
    await parkedTask(ws, Date.now() - 1_000)
    await store.claimDue()
    const [running] = await collectTasks({ workspaces: [ws] })

    const result = await deleteTask(running!)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('kill it first')
    // Nothing was touched.
    expect(await collectTasks({ workspaces: [ws] })).toHaveLength(1)
  })

  it('is marked destructive so no frontend can run it without confirmation', async () => {
    const ws = await workspace()
    const task = await parkedTask(ws, Date.now() + 60_000)
    expect(actionAvailability(task, 'delete').destructive).toBe(true)
  })
})

describe('the resume command names the binary that owns the session', () => {
  it('uses the glm launcher when the wake was armed under that profile', async () => {
    const ws = await workspace()
    const task = await parkedTask(ws, Date.now() + 60_000)
    const glm: TaskView = { ...task, profile: '/home/u/.meta-agent/glm_config.json' }
    expect(resumeCommandFor(glm)).toContain('meta-agent-glm -w')
    expect(resumeCommandFor(glm)).toContain('--resume s1')
  })

  it("prefers the wake's own profile over the scheduler's", async () => {
    const ws = await workspace()
    const task = await parkedTask(ws, Date.now() + 60_000)
    const mixed: TaskView = {
      ...task,
      profile: '/home/u/.meta-agent/glm_config.json',
      scheduler: { alive: true, pid: 1, configFile: '/home/u/.meta-agent/config.json' },
    }
    expect(resumeCommandFor(mixed)).toContain('meta-agent-glm')
  })

  it('falls back to the plain binary for the default profile', async () => {
    const ws = await workspace()
    const task = await parkedTask(ws, Date.now() + 60_000)
    expect(resumeCommandFor(task)).toMatch(/^meta-agent -w/)
  })
})

describe('fireNow store primitive', () => {
  it('is a no-op on an already-due wake and a refusal on a claimed one', async () => {
    const ws = await workspace()
    const store = new AutoContinuationStore(ws)
    const record = await store.schedule({
      sessionId: 's1', fireAt: Date.now() - 5_000, reason: 'r', historyMessageCount: 1,
    })
    expect(await store.fireNow(record.wakeId)).toBe(true)

    await store.claimDue()
    expect(await store.fireNow(record.wakeId)).toBe(false)
  })

  it('returns false for an unknown wake', async () => {
    expect(await new AutoContinuationStore(await workspace()).fireNow('nope')).toBe(false)
  })
})

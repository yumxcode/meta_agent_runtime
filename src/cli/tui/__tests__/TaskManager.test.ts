/**
 * Managed task scheduling: one foreground controller, exact wake workers, and
 * a host-wide concurrency ceiling across independent workspaces.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutoContinuationStore } from '../../../core/auto/AutoContinuationStore.js'
import {
  AUTO_CHECKPOINT_SCHEMA_VERSION,
  writeAutoCheckpoint,
} from '../../../core/auto/AutoCheckpointStore.js'
import { collectTasks, type TaskView } from '../../../core/auto/TaskRegistry.js'
import {
  TaskManager,
  createSubprocessManagedWorkerLauncher,
  type ManagedWorkerHandle,
  type ManagedWorkerRequest,
  type ManagedWorkerResult,
} from '../TaskManager.js'
import type { CliOptions } from '../../args.js'

const dirs: string[] = []
const managers: TaskManager[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.stop()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'managed-task-'))
  dirs.push(dir)
  return dir
}

async function park(
  ws: string,
  sessionId: string,
  fireAt: number,
  profile?: string,
): Promise<void> {
  await writeAutoCheckpoint(ws, {
    schemaVersion: AUTO_CHECKPOINT_SCHEMA_VERSION,
    sessionId,
    updatedAt: Date.now(),
    goal: `goal-${sessionId}`,
    stopReason: 'parked',
  })
  await new AutoContinuationStore(ws).schedule({
    sessionId,
    fireAt,
    reason: `wake-${sessionId}`,
    historyMessageCount: 1,
    ...(profile ? { runtime: { configFile: profile } } : {}),
  })
}

interface Launch extends ManagedWorkerRequest {
  finish: (result?: ManagedWorkerResult) => Promise<void>
}

function controlledLauncher(launches: Launch[]): (request: ManagedWorkerRequest) => ManagedWorkerHandle {
  return request => {
    let resolve!: (result: ManagedWorkerResult) => void
    const completion = new Promise<ManagedWorkerResult>(done => { resolve = done })
    launches.push({
      ...request,
      finish: async (result = { code: 0, signal: null }) => {
        // Model the exact one-shot child: claim and finish only its assigned
        // wake before reporting process exit to the manager.
        const store = new AutoContinuationStore(request.workspace)
        const [claimed] = await store.claimDue(
          Date.now(),
          `test-worker:${request.wakeId}`,
          1,
          record => record.wakeId === request.wakeId,
        )
        if (claimed?.claim?.token) {
          await store.release(claimed.wakeId, claimed.claim.token, 'done')
        }
        resolve(result)
      },
    })
    return { pid: 10_000 + launches.length, completion }
  }
}

describe('global managed concurrency', () => {
  it('does not admit work from a scan that finishes after stop', async () => {
    const ws = await workspace()
    await park(ws, 'stop-race', Date.now() - 1_000)
    const tasks = await collectTasks({ workspaces: [ws] })
    let releaseScan!: (tasks: TaskView[]) => void
    const collect = vi.fn(() => new Promise<TaskView[]>(resolve => { releaseScan = resolve }))
    const launcher = vi.fn((): ManagedWorkerHandle => ({
      completion: new Promise(() => undefined),
    }))
    const manager = new TaskManager({ maxRunning: 1, launcher, collect })
    managers.push(manager)

    const starting = manager.start()
    await vi.waitFor(() => expect(collect).toHaveBeenCalledOnce())
    const stopping = manager.stop()
    releaseScan(tasks)
    await Promise.all([starting, stopping])

    expect(launcher).not.toHaveBeenCalled()
    expect(manager.snapshot().running).toBe(0)
  })

  it('runs at most maxRunning wakes across different workspaces', async () => {
    const workspaces = await Promise.all([workspace(), workspace(), workspace()])
    await Promise.all(workspaces.map((ws, i) => park(ws, `s${i + 1}`, Date.now() - 1_000)))

    const launches: Launch[] = []
    const manager = new TaskManager({
      maxRunning: 2,
      workspaces,
      pollMs: 60_000,
      launcher: controlledLauncher(launches),
    })
    managers.push(manager)
    await manager.start()

    expect(launches).toHaveLength(2)
    expect(new Set(launches.map(item => item.workspace)).size).toBe(2)
    expect(manager.snapshot()).toMatchObject({ running: 2, queued: 1, maxRunning: 2 })

    await launches[0]!.finish()
    await vi.waitFor(() => expect(launches).toHaveLength(3))
    expect(manager.snapshot().running).toBe(2)

    await Promise.all(launches.slice(1).map(item => item.finish()))
    await vi.waitFor(() => expect(manager.snapshot().running).toBe(0))
  })

  it('preserves the wake provider profile for its isolated worker', async () => {
    const ws = await workspace()
    await park(ws, 'glm-session', Date.now() - 1_000, '/profiles/glm_config.json')
    const launches: Launch[] = []
    const manager = new TaskManager({
      maxRunning: 1,
      workspaces: [ws],
      pollMs: 60_000,
      launcher: controlledLauncher(launches),
    })
    managers.push(manager)
    await manager.start()

    expect(launches[0]).toMatchObject({
      workspace: ws,
      sessionId: 'glm-session',
      profile: '/profiles/glm_config.json',
    })
    await launches[0]!.finish()
  })

  it('keeps a launcher failure visible while the wake waits for retry', async () => {
    const ws = await workspace()
    await park(ws, 'retry-me', Date.now() - 1_000)
    let finish!: (result: ManagedWorkerResult) => void
    const manager = new TaskManager({
      maxRunning: 1,
      workspaces: [ws],
      pollMs: 60_000,
      launcher: () => ({
        completion: new Promise(resolve => { finish = resolve }),
      }),
    })
    managers.push(manager)
    await manager.start()
    finish({ code: 1, signal: null, error: 'provider key missing', logPath: '/tmp/worker.log' })

    await vi.waitFor(() => expect(manager.snapshot().running).toBe(0))
    expect(manager.snapshot().lastError).toContain('provider key missing')
    expect(manager.snapshot().lastError).toContain('/tmp/worker.log')
  })
})

describe('managed r action', () => {
  it('runs a future wake even though no standalone scheduler exists', async () => {
    const ws = await workspace()
    await park(ws, 'selected', Date.now() + 60 * 60_000)
    const [task] = await collectTasks({ workspaces: [ws] })
    expect(task?.scheduler.alive).toBe(false)

    const launches: Launch[] = []
    const manager = new TaskManager({
      maxRunning: 3,
      workspaces: [ws],
      pollMs: 60_000,
      launcher: controlledLauncher(launches),
    })
    managers.push(manager)
    await manager.start()
    expect(launches).toHaveLength(0)

    const result = await manager.runNow(task!)
    expect(result.ok).toBe(true)
    expect(result.message).toContain('running')
    expect(launches).toHaveLength(1)
    expect(launches[0]?.sessionId).toBe('selected')
    await launches[0]!.finish()
  })

  it('exposes live output metadata and retains it after the turn exits', async () => {
    const ws = await workspace()
    await park(ws, 'observable', Date.now() - 1_000)
    const [task] = await collectTasks({ workspaces: [ws] })
    let finish!: (result: ManagedWorkerResult) => void
    const manager = new TaskManager({
      maxRunning: 1,
      workspaces: [ws],
      pollMs: 60_000,
      launcher: () => ({
        pid: 43210,
        logPath: '/tmp/observable.ndjson',
        completion: new Promise(resolve => { finish = resolve }),
      }),
    })
    managers.push(manager)
    await manager.start()

    expect(manager.activityFor(task!)).toMatchObject({
      sessionId: 'observable',
      state: 'running',
      pid: 43210,
      logPath: '/tmp/observable.ndjson',
    })

    await manager.stop()
    finish({ code: 0, signal: null, logPath: '/tmp/observable.ndjson' })
    await vi.waitFor(() => expect(manager.snapshot().running).toBe(0))
    expect(manager.activityFor(task!)).toMatchObject({
      state: 'succeeded',
      result: { code: 0 },
    })
  })

  it('reattaches to a detached managed worker after the TUI is reopened', async () => {
    const ws = await workspace()
    await park(ws, 'reattach', Date.now() - 1_000)
    const [parked] = await collectTasks({ workspaces: [ws] })
    const claimedAt = Date.now() - 5_000
    const wakeId = parked!.wake!.wakeId
    const manager = new TaskManager({
      maxRunning: 1,
      workspaces: [ws],
      launcher: () => ({ completion: new Promise(() => undefined) }),
    })

    const activity = manager.activityFor({
      ...parked!,
      status: 'running',
      wake: {
        ...parked!.wake!,
        claim: { owner: 'detached', claimedAt, expiresAt: Date.now() + 60_000 },
      },
      scheduler: {
        alive: true,
        pid: 54321,
        lastSeen: Date.now(),
        managedWakeId: wakeId,
      },
    })
    expect(activity).toMatchObject({
      state: 'running',
      wakeId,
      pid: 54321,
      startedAt: claimedAt,
    })
    expect(activity?.logPath).toMatch(/managed-auto\/logs\/[a-f0-9]{24}\.log$/)
  })
})

describe('worker process isolation', () => {
  it('launches the current runtime with the exact wake and selected profile', async () => {
    const ws = await workspace()
    const entry = join(ws, 'fake-cli.mjs')
    await writeFile(entry, [
      "console.log(JSON.stringify({ args: process.argv.slice(2), profile: process.env.META_AGENT_CONFIG_FILE }))",
    ].join('\n'))
    const launcher = createSubprocessManagedWorkerLauncher({
      cli: { debug: false, showThinking: false } as CliOptions,
      entryPath: entry,
    })
    const handle = launcher({
      workspace: ws,
      sessionId: 's1',
      wakeId: 'auto-wake-isolated123',
      profile: '/profiles/selected.json',
    })
    expect(handle.logPath).toBeTruthy()
    const result = await handle.completion
    expect(result.code).toBe(0)
    const logged = JSON.parse((await readFile(result.logPath!, 'utf8')).trim()) as {
      args: string[]
      profile: string
    }
    expect(logged.args).toContain('--wake-id')
    expect(logged.args).toContain('auto-wake-isolated123')
    expect(logged.args).toContain('--once')
    expect(logged.profile).toBe('/profiles/selected.json')
  })
})

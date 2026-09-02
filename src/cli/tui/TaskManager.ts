/**
 * TaskManager — the execution plane behind `meta-agent tasks --manage`.
 *
 * The TUI remains a control plane. Each due wake is executed by an exact,
 * one-shot auto-scheduler child so the existing claim/lease/fence/retry path is
 * reused unchanged, provider profiles stay process-isolated, and the parent can
 * enforce one concurrency ceiling across every workspace.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { AutoContinuationStore } from '../../core/auto/AutoContinuationStore.js'
import { collectTasks, type TaskView } from '../../core/auto/TaskRegistry.js'
import { buildChildEnv } from '../../infra/env/childProcessEnv.js'
import { META_AGENT_HOME } from '../../infra/metaAgentHome.js'
import type { CliOptions } from '../args.js'

export interface ManagedWorkerRequest {
  workspace: string
  sessionId: string
  wakeId: string
  profile?: string
}

export interface ManagedWorkerResult {
  code: number | null
  signal: NodeJS.Signals | null
  error?: string
  logPath?: string
}

export interface ManagedWorkerHandle {
  pid?: number
  /** Available as soon as the worker starts, so the TUI can tail it live. */
  logPath?: string
  completion: Promise<ManagedWorkerResult>
}

export type ManagedWorkerLauncher = (
  request: ManagedWorkerRequest,
) => ManagedWorkerHandle

export interface TaskManagerSnapshot {
  enabled: true
  running: number
  queued: number
  maxRunning: number
  lastError?: string
}

export interface TaskManagerOptions {
  maxRunning: number
  workspaces?: readonly string[]
  pollMs?: number
  launcher: ManagedWorkerLauncher
  collect?: () => Promise<TaskView[]>
  now?: () => number
}

export interface ManagedRunResult {
  ok: boolean
  message: string
}

export type ManagedTaskActivityState = 'running' | 'succeeded' | 'failed'

/** Runtime facts for the latest managed turn of one durable task/session. */
export interface ManagedTaskActivity {
  workspace: string
  sessionId: string
  wakeId: string
  state: ManagedTaskActivityState
  startedAt: number
  pid?: number
  logPath?: string
  endedAt?: number
  result?: ManagedWorkerResult
  /**
   * True when this record was reconstructed from durable wake state rather than
   * from a launch this process performed. The elapsed time is then the wake's,
   * not the turn's, so the view must not present it as a measured duration.
   */
  reattached?: boolean
}

interface ActiveWorker {
  handle: ManagedWorkerHandle
  activity: ManagedTaskActivity
}

interface RetryState {
  attempts: number
  after: number
}

const DEFAULT_POLL_MS = 1_000
const MAX_RETRY_MS = 30_000

export class TaskManager {
  private readonly maxRunning: number
  private readonly pollMs: number
  private readonly collect: () => Promise<TaskView[]>
  private readonly now: () => number
  private readonly active = new Map<string, ActiveWorker>()
  /** Kept after exit so a parked/finished row can still show its latest turn. */
  private readonly latestByTask = new Map<string, ManagedTaskActivity>()
  private readonly retry = new Map<string, RetryState>()
  private timer: NodeJS.Timeout | undefined
  private ticking = false
  private readonly tickWaiters: Array<() => void> = []
  private stopped = true
  private queued = 0
  private lastError: string | undefined

  constructor(private readonly options: TaskManagerOptions) {
    this.maxRunning = Math.max(1, Math.floor(options.maxRunning))
    this.pollMs = Math.max(100, options.pollMs ?? DEFAULT_POLL_MS)
    this.now = options.now ?? Date.now
    this.collect = options.collect ?? (() => collectTasks(
      options.workspaces ? { workspaces: options.workspaces } : {},
    ))
  }

  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    await this.tick()
    if (this.stopped) return
    this.timer = setInterval(() => void this.tick(), this.pollMs)
    this.timer.unref?.()
  }

  /** Stop discovering new work. Already-started turns are deliberately left alive. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    // Most callers do not need to await this, but tests/embedders that remove a
    // workspace must be able to wait for an already-started read-only scan.
    if (this.ticking) await new Promise<void>(resolve => this.tickWaiters.push(resolve))
  }

  snapshot(): TaskManagerSnapshot {
    return {
      enabled: true,
      running: this.active.size,
      queued: this.queued,
      maxRunning: this.maxRunning,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    }
  }

  /** Latest manager-owned turn for this task, including a completed one. */
  activityFor(task: TaskView): ManagedTaskActivity | undefined {
    const activity = this.latestByTask.get(taskKey(task.workspace, task.sessionId))
    if (activity) {
      // Callers render this concurrently with completion callbacks. Do not
      // expose the mutable object stored by the manager.
      return {
        ...activity,
        ...(activity.result ? { result: { ...activity.result } } : {}),
      }
    }

    // A detached worker deliberately survives `q`. If the operator reopens a
    // manager while that worker is still running, this process has no in-memory
    // launch record, but the scheduler heartbeat identifies its exact wake and
    // the log path is deterministic. Reattach the read-only view without ever
    // claiming or launching it again.
    const liveWakeId = task.scheduler.managedWakeId
    if (task.status === 'running' && liveWakeId && task.wake?.wakeId === liveWakeId) {
      return {
        workspace: task.workspace,
        sessionId: task.sessionId,
        wakeId: liveWakeId,
        state: 'running',
        startedAt: task.wake.claim?.claimedAt ?? task.scheduler.lastSeen ?? this.now(),
        ...(task.scheduler.pid ? { pid: task.scheduler.pid } : {}),
        logPath: managedWorkerLogPath(liveWakeId),
      }
    }

    return resolveFinishedTaskActivity(task, this.now())
  }

  /**
   * `r` in managed mode is an atomic operator intent: make the selected wake
   * due, then immediately let the global dispatcher fill a free slot. Unlike
   * the legacy action it does not require a separately-running scheduler.
   */
  async runNow(task: TaskView): Promise<ManagedRunResult> {
    if (task.status === 'running') return { ok: false, message: 'run refused: already running' }
    if (task.status === 'orphaned') {
      return { ok: false, message: 'run refused: no wake exists; resume this session manually' }
    }
    if (!task.wake || (task.status !== 'parked' && task.status !== 'overdue')) {
      return { ok: false, message: 'run refused: nothing is scheduled' }
    }

    const moved = await new AutoContinuationStore(task.workspace).fireNow(task.wake.wakeId)
    if (!moved) {
      return { ok: false, message: `${task.wake.wakeId} is no longer pending` }
    }
    // A manual run is also an explicit retry request after a launcher failure.
    this.retry.delete(task.wake.wakeId)
    await this.tick()
    const position = this.active.has(task.wake.wakeId)
      ? `running (${this.active.size}/${this.maxRunning})`
      : task.scheduler.alive && !task.scheduler.managedWakeId
        ? 'handed to the existing workspace scheduler'
        : this.active.size >= this.maxRunning
          ? `queued (global limit ${this.active.size}/${this.maxRunning})`
          : 'queued for managed admission'
    return { ok: true, message: `${task.wake.wakeId} is now due; ${position}` }
  }

  /** One deterministic dispatcher pass, exported as a public seam for tests. */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      const now = this.now()
      const tasks = await this.collect()
      // `stop()` can race an asynchronous cross-workspace scan. The scan may
      // finish, but no result obtained after shutdown may admit another turn.
      if (this.stopped) return
      const liveWakeIds = new Set(tasks.flatMap(task => task.wake ? [task.wake.wakeId] : []))
      for (const wakeId of this.retry.keys()) {
        if (!liveWakeIds.has(wakeId)) this.retry.delete(wakeId)
      }
      const due = tasks.filter(task => {
        if (!task.wake || task.wake.fireAt > now) return false
        if (task.status !== 'parked' && task.status !== 'overdue') return false
        if (this.active.has(task.wake.wakeId)) return false
        const retry = this.retry.get(task.wake.wakeId)
        if (retry && retry.after > now) return false
        // A normal long-lived scheduler already owns this workspace. Managed
        // workers carry their exact wake id and may coexist safely.
        if (task.scheduler.alive && !task.scheduler.managedWakeId) return false
        return true
      })

      const available = Math.max(0, this.maxRunning - this.active.size)
      this.queued = Math.max(0, due.length - available)
      for (const task of due.slice(0, available)) this.launch(task)
      if (due.length === 0 && this.active.size === 0 && this.retry.size === 0) {
        this.lastError = undefined
      }
    } catch (error) {
      this.lastError = `manager scan failed: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      this.ticking = false
      for (const resolve of this.tickWaiters.splice(0)) resolve()
    }
  }

  private launch(task: TaskView): void {
    const wake = task.wake
    if (!wake || this.active.has(wake.wakeId)) return
    const profile = task.profile ?? task.scheduler.configFile
    let handle: ManagedWorkerHandle
    try {
      handle = this.options.launcher({
        workspace: task.workspace,
        sessionId: task.sessionId,
        wakeId: wake.wakeId,
        ...(profile ? { profile } : {}),
      })
    } catch (error) {
      this.recordFailure(wake.wakeId, error instanceof Error ? error.message : String(error))
      return
    }

    const activity: ManagedTaskActivity = {
      workspace: task.workspace,
      sessionId: task.sessionId,
      wakeId: wake.wakeId,
      state: 'running',
      startedAt: this.now(),
      ...(handle.pid ? { pid: handle.pid } : {}),
      ...(handle.logPath ? { logPath: handle.logPath } : {}),
    }
    this.active.set(wake.wakeId, { handle, activity })
    this.latestByTask.set(taskKey(task.workspace, task.sessionId), activity)
    this.lastError = undefined
    void handle.completion.then(
      result => {
        this.active.delete(wake.wakeId)
        activity.state = result.code === 0 ? 'succeeded' : 'failed'
        activity.endedAt = this.now()
        activity.result = result
        if (result.logPath) activity.logPath = result.logPath
        if (result.code === 0) {
          this.retry.delete(wake.wakeId)
        } else {
          const detail = result.error ?? `exit ${result.code ?? result.signal ?? 'unknown'}`
          this.recordFailure(
            wake.wakeId,
            `${detail}${result.logPath ? `; log: ${result.logPath}` : ''}`,
          )
        }
        void this.tick()
      },
      error => {
        this.active.delete(wake.wakeId)
        const detail = error instanceof Error ? error.message : String(error)
        activity.state = 'failed'
        activity.endedAt = this.now()
        activity.result = { code: null, signal: null, error: detail }
        this.recordFailure(wake.wakeId, detail)
        void this.tick()
      },
    )
  }

  private recordFailure(wakeId: string, detail: string): void {
    const prior = this.retry.get(wakeId)?.attempts ?? 0
    const attempts = prior + 1
    const delay = Math.min(MAX_RETRY_MS, 1_000 * 2 ** Math.min(5, prior))
    this.retry.set(wakeId, { attempts, after: this.now() + delay })
    this.lastError = `${wakeId}: ${detail}; retrying in ${Math.round(delay / 1_000)}s`
  }
}

export interface SubprocessLauncherOptions {
  cli: CliOptions
  /** Injection point for tests and embedders. Defaults to the current CLI entry. */
  entryPath?: string
}

/** Launch an exact one-shot scheduler without attaching it to the TUI terminal. */
export function createSubprocessManagedWorkerLauncher(
  options: SubprocessLauncherOptions,
): ManagedWorkerLauncher {
  const entryPath = options.entryPath ?? process.argv[1]
  if (!entryPath) throw new Error('cannot locate the current meta-agent CLI entry')

  return request => {
    const logDir = join(META_AGENT_HOME, 'managed-auto', 'logs')
    mkdirSync(logDir, { recursive: true })
    // Wake contents are durable workspace data and may be corrupt or manually
    // edited. Never let a record-controlled id become a path component.
    const logPath = managedWorkerLogPath(request.wakeId)
    const logFd = openSync(logPath, 'a')
    const args = [entryPath, '-w', request.workspace, '--json']
    if (options.cli.apiKey) args.push('--api-key', options.cli.apiKey)
    if (options.cli.baseUrl) args.push('--base-url', options.cli.baseUrl)
    if (options.cli.model) args.push('--model', options.cli.model)
    if (options.cli.debug) args.push('--debug')
    if (options.cli.showThinking) args.push('--show-thinking')
    args.push(
      'auto-scheduler',
      '--once',
      '--wake-id', request.wakeId,
      '--max-concurrent', '1',
    )

    const profile = request.profile ?? join(META_AGENT_HOME, 'config.json')
    // Explicitly select even the default profile. If the manager itself was
    // launched through meta-agent-glm, merely deleting this variable would let
    // that wrapper silently put GLM back before importing the main bundle.
    // This is the same trusted meta-agent runtime (not a model/config-selected
    // third-party command), and it needs the provider credentials the parent
    // scheduler would have used. Still route the decision through the central
    // child-env policy so the full inheritance is explicit and auditable.
    const env = buildChildEnv('inherit', { META_AGENT_CONFIG_FILE: profile })

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(process.execPath, args, {
        env,
        detached: true,
        stdio: ['ignore', logFd, logFd],
      })
    } finally {
      closeSync(logFd)
    }
    child.unref()

    let settled = false
    const completion = new Promise<ManagedWorkerResult>(resolve => {
      child.once('error', error => {
        if (settled) return
        settled = true
        resolve({ code: null, signal: null, error: error.message, logPath })
      })
      child.once('exit', (code, signal) => {
        if (settled) return
        settled = true
        resolve({ code, signal, logPath })
      })
    })
    return { ...(child.pid ? { pid: child.pid } : {}), logPath, completion }
  }
}

/**
 * Locate the log of a task's most recent FINISHED turn, from durable state only.
 *
 * Deliberately a free function rather than a TaskManager method, because the
 * board runs without a manager: bare `meta-agent tasks` opens the same TUI with
 * `manager: undefined`. Had this stayed a method, the completion report would
 * have existed only under `--manage` — which is the mode for *executing* work,
 * not the mode for reading what it concluded.
 *
 * `latestByTask` is in-memory, so quitting the manager took the completed run
 * with it and the frame fell back to "this turn was not launched by this tasks
 * manager". For a task the manager ran ten minutes ago that message is simply
 * false, and it was the last thing shown before the report became unreachable.
 * `lastWakeId` makes the log addressable again — the path is `sha256(wakeId)`,
 * so nothing new has to be stored.
 *
 * Not gated on status: 'parked' and 'orphaned' tasks also have a most-recent
 * finished turn worth reading. `state` is 'succeeded' because the WAKE reached
 * a terminal status; how the RUN ended is a finer fact that lives in the report
 * itself (subtype / stopReason), and claiming 'failed' here would paint a
 * healthy task red on no evidence.
 */
export function resolveFinishedTaskActivity(
  task: TaskView,
  now = Date.now(),
): ManagedTaskActivity | undefined {
  if (!task.lastWakeId || task.status === 'running') return undefined
  return {
    workspace: task.workspace,
    sessionId: task.sessionId,
    wakeId: task.lastWakeId,
    state: 'succeeded',
    startedAt: task.lastOutcomeAt ?? now,
    ...(task.lastOutcomeAt ? { endedAt: task.lastOutcomeAt } : {}),
    logPath: managedWorkerLogPath(task.lastWakeId),
    reattached: true,
  }
}

function taskKey(workspace: string, sessionId: string): string {
  return `${workspace}\0${sessionId}`
}

function managedWorkerLogPath(wakeId: string): string {
  const logId = createHash('sha256').update(wakeId).digest('hex').slice(0, 24)
  return join(META_AGENT_HOME, 'managed-auto', 'logs', `${logId}.log`)
}

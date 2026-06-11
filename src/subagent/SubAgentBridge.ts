/**
 * SubAgentBridge — main agent ↔ sub-agent orchestration layer
 *
 * The bridge is the single entry point for spawning sub-agents and querying
 * their status.  One bridge instance is created per main-agent session and
 * injected into the tool handlers that the main agent can call.
 *
 * Notification pipeline (event-driven mode):
 *   SubAgentRunner →emit→ CampaignEventBus
 *       → SubAgentBridge._onCompleted / _onFailed
 *           → pendingNotifications[parentSessionId].push(notification)
 *               → drainNotifications() called by D-SubAgent dynamic section
 *                   → injected into main agent's next system prompt
 *
 * Poll fallback (useEventDriven=false):
 *   NodeJS.Timeout every pollIntervalMs
 *       → reads SubAgentTaskStore
 *           → if terminal: drainNotifications() path (same as above)
 */

import { randomUUID } from 'crypto'
import { readTask, writeTask, mutateTask, releaseWriteChain, listTasksForSession, cleanupTerminalTasks } from './SubAgentTaskStore.js'
import { SubAgentRunner } from './SubAgentRunner.js'
import { CampaignEventBus } from './CampaignEventBus.js'
import {
  makeSubAgentTaskId,
  DEFAULT_SUB_AGENT_CONFIG,
  TERMINAL_STATUSES,
  type SubAgentConfig,
  type SubAgentRecord,
  type SubAgentTaskId,
  type SubAgentCompletedEvent,
  type SubAgentFailedEvent,
} from './types.js'
import type { ISubAgentDispatcher } from './ISubAgentDispatcher.js'
import type { MetaAgentTool } from '../core/types.js'

const DEFAULT_MAX_CONCURRENT_SUB_AGENTS = 4
const DEFAULT_MAX_QUEUED_SUB_AGENTS = 64
// P2-1: 50 ms is enough to avoid a thundering-herd of simultaneous session
// constructions while keeping a 4-task fan-out under 200 ms of added latency
// (was 250 ms → 750 ms for 4 tasks). Raise via META_AGENT_SUB_AGENT_START_DELAY_MS
// if a provider rate-limits concurrent request starts.
const DEFAULT_SUB_AGENT_START_DELAY_MS = 50
const MAX_PENDING_NOTIFICATIONS = 100
const DEFAULT_DESTROY_WAIT_MS = 10_000

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

// ─────────────────────────────────────────────────────────────────────────────
// Spawn options
// ─────────────────────────────────────────────────────────────────────────────

export interface SpawnSubAgentOptions {
  /**
   * Optional caller-provided task ID. Used when resources such as git worktrees
   * must be allocated before the task record is enqueued.
   */
  taskId?: SubAgentTaskId
  /**
   * Partial config — merged with DEFAULT_SUB_AGENT_CONFIG.
   * taskDescription is required.
   */
  config: Partial<SubAgentConfig> & Pick<SubAgentConfig, 'taskDescription'>
  /**
   * AbortSignal from the current tool-call context.  When the parent session
   * is interrupted mid-turn, sub-agents spawned in that turn are cancelled.
   */
  abortSignal?: AbortSignal
}

export interface SubAgentBridgeOptions {
  /** Maximum number of sub-agent sessions running at once. */
  maxConcurrentSubAgents?: number
  /** Maximum number of sub-agent sessions waiting for a scheduler slot. */
  maxQueuedSubAgents?: number
  /** Maximum aggregate budget for sub-agents owned by this bridge. */
  maxTotalSubAgentBudgetUsd?: number
  /** Minimum delay between starting queued sub-agents. */
  startDelayMs?: number
}

interface QueuedSubAgent {
  record: SubAgentRecord
  abortController: AbortController
}

export interface SubAgentSchedulerStats {
  /** Tasks waiting in the queue (not yet started). */
  queued: number
  /** Tasks currently running. */
  running: number
  /**
   * Tasks that reached a terminal state (success or failure) since this bridge
   * was created.  Named "finished" rather than "completed" to avoid implying
   * all of these succeeded — both successful and failed tasks are counted.
   */
  finishedThisSession: number
  /**
   * How long the oldest queued task has been waiting, in milliseconds.
   * 0 when there are no queued tasks.
   */
  oldestQueuedMs: number
  /** IDs of all currently running tasks. */
  activeTaskIds: string[]
  /** Maximum number of concurrently running tasks this bridge allows. */
  maxConcurrent: number
}

// ─────────────────────────────────────────────────────────────────────────────
// SubAgentBridge
// ─────────────────────────────────────────────────────────────────────────────

export class SubAgentBridge implements ISubAgentDispatcher {
  /**
   * P1-8: Guard against duplicate bridges per session which would register
   * duplicate CampaignEventBus listeners and double-deliver notifications.
   * destroy() removes the session entry so the next session can create cleanly.
   *
   * ⚠ Memory leak risk: this static Map holds a strong reference to every
   * SubAgentBridge ever created.  Callers MUST call bridge.destroy() when the
   * parent session ends — otherwise the bridge (and its runners / timers /
   * listeners) will be retained for the entire process lifetime.
   *
   * Pattern:
   *   const bridge = new SubAgentBridge(session.sessionId)
   *   try { ... } finally { bridge.destroy() }
   */
  private static readonly _bridgesBySessionId = new Map<string, SubAgentBridge>()

  /**
   * Retrieve an existing bridge for a session (for use in test teardown or
   * emergency cleanup when the original bridge reference is lost).
   */
  static getBridge(sessionId: string): SubAgentBridge | undefined {
    return SubAgentBridge._bridgesBySessionId.get(sessionId)
  }

  /** Destroy all bridges — use only in process-exit cleanup handlers. */
  static destroyAll(): void {
    for (const bridge of SubAgentBridge._bridgesBySessionId.values()) {
      try { bridge.destroy() } catch { /* best-effort */ }
    }
  }

  /** Async variant for shutdown paths that can wait for runner cleanup. */
  static async disposeAll(): Promise<void> {
    await Promise.allSettled(
      [...SubAgentBridge._bridgesBySessionId.values()].map(bridge => bridge.dispose()),
    )
  }

  private readonly parentSessionId: string
  /**
   * Tool registry for sub-agents — set via setToolRegistry() after the main
   * session has registered all tools.  Sub-agents can only use tools listed
   * in their config.allowedTools that are also present in this registry.
   */
  private toolRegistry: Map<string, MetaAgentTool> = new Map()

  /**
   * Pending notifications keyed by parentSessionId.
   * drainNotifications() atomically reads + clears this array.
   */
  private readonly pendingNotifications: string[] = []

  /** Poll timers for non-event-driven tasks. */
  private readonly pollTimers = new Map<SubAgentTaskId, ReturnType<typeof setInterval>>()

  /** Active runners — kept for cancel() calls. */
  private readonly runners = new Map<SubAgentTaskId, SubAgentRunner>()
  private readonly queuedStarts = new Map<SubAgentTaskId, QueuedSubAgent>()
  private readonly startQueue: SubAgentTaskId[] = []
  private readonly activeTaskIds = new Set<SubAgentTaskId>()
  private readonly parentAbortCleanups = new Map<SubAgentTaskId, () => void>()
  private readonly maxConcurrentSubAgents: number
  private readonly maxQueuedSubAgents: number
  private readonly maxTotalSubAgentBudgetUsd: number | undefined
  private readonly startDelayMs: number
  private readonly constructedAtMs = Date.now()
  private reservedBudgetUsd = 0
  private settledCostUsd = 0
  private readonly reservedBudgetByTask = new Map<SubAgentTaskId, number>()
  private drainingStarts = false
  private destroyed = false
  /** Count of tasks that reached a terminal state (success or failure) since this bridge was created. */
  private _finishedCount = 0
  private _disposePromise: Promise<void> | undefined

  /** Bound listeners — kept so we can off() them in destroy(). */
  private readonly _onCompleted: (e: SubAgentCompletedEvent) => void
  private readonly _onFailed:    (e: SubAgentFailedEvent)    => void

  constructor(parentSessionId: string, options: SubAgentBridgeOptions = {}) {
    // P1-8: Prevent duplicate bridges (and thus duplicate event listeners)
    // for the same session.  Callers must destroy() the previous bridge first.
    if (SubAgentBridge._bridgesBySessionId.has(parentSessionId)) {
      throw new Error(
        `[SubAgentBridge] A bridge for session "${parentSessionId}" already exists. ` +
        `Call destroy() on the existing bridge before creating a new one.`,
      )
    }
    SubAgentBridge._bridgesBySessionId.set(parentSessionId, this)

    this.parentSessionId = parentSessionId
    this.maxConcurrentSubAgents = Math.max(
      1,
      options.maxConcurrentSubAgents ??
        envInt('META_AGENT_MAX_CONCURRENT_SUB_AGENTS', DEFAULT_MAX_CONCURRENT_SUB_AGENTS, 1, 64),
    )
    this.maxQueuedSubAgents = Math.max(
      0,
      options.maxQueuedSubAgents ??
        envInt('META_AGENT_MAX_QUEUED_SUB_AGENTS', DEFAULT_MAX_QUEUED_SUB_AGENTS, 0, 10_000),
    )
    this.maxTotalSubAgentBudgetUsd = options.maxTotalSubAgentBudgetUsd ??
      this._envBudgetUsd('META_AGENT_MAX_TOTAL_SUB_AGENT_BUDGET_USD')
    this.startDelayMs = Math.max(
      0,
      options.startDelayMs ??
        envInt('META_AGENT_SUB_AGENT_START_DELAY_MS', DEFAULT_SUB_AGENT_START_DELAY_MS, 0, 60_000),
    )

    this._onCompleted = (e) => {
      if (e.parentSessionId !== this.parentSessionId) return
      const ps = e.result.progressState
      const progressSuffix = ps
        ? ` | 工具调用: ${ps.toolCallsCompleted}` +
          (ps.stepsCompleted > 0 ? ` 步: ${ps.stepsCompleted}` : '') +
          (ps.provenanceIds.length > 0
            ? ` | provenance: ${ps.provenanceIds.slice(0, 5).join(', ')}${ps.provenanceIds.length > 5 ? ` (+${ps.provenanceIds.length - 5})` : ''}`
            : '')
        : ''
      this._enqueueNotification(
        `[${e.taskId}] ✓ 已完成 | ` +
        `${e.result.turnsUsed} 轮 / $${e.result.costUsd.toFixed(4)}${progressSuffix} | ` +
        `摘要: ${e.result.summary.slice(0, 300)}${e.result.summary.length > 300 ? '…' : ''}`,
      )
      this._clearPollTimer(e.taskId)
    }

    this._onFailed = (e) => {
      if (e.parentSessionId !== this.parentSessionId) return
      this._enqueueNotification(
        `[${e.taskId}] ✗ 失败 | 原因: ${e.error.slice(0, 200)}`,
      )
      this._clearPollTimer(e.taskId)
    }

    CampaignEventBus.on('subagent:completed', this._onCompleted)
    CampaignEventBus.on('subagent:failed',    this._onFailed)

    void this._failStaleActiveTasks()
    void cleanupTerminalTasks().catch(() => undefined)
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Update the tool registry used when spawning sub-agents.
   * Call this whenever the main session registers new tools.
   */
  setToolRegistry(registry: Map<string, MetaAgentTool>): void {
    this.toolRegistry = registry
  }

  /**
   * Clean up all listeners, timers, and in-flight runners.
   * Call when the parent session ends.
   *
   * P1-8: Aborts every active SubAgentRunner so their internal sessions
   * are interrupted and no orphaned async work continues after the parent ends.
   */
  async dispose(waitMs = DEFAULT_DESTROY_WAIT_MS): Promise<void> {
    if (this._disposePromise) return this._disposePromise
    this._disposePromise = this._dispose(waitMs)
    return this._disposePromise
  }

  /** Backward-compatible fire-and-forget teardown. Prefer await dispose(). */
  destroy(): void {
    void this.dispose()
  }

  private async _dispose(waitMs: number): Promise<void> {
    if (this.destroyed) return   // S6: idempotent — multiple owners may call destroy()
    this.destroyed = true
    CampaignEventBus.off('subagent:completed', this._onCompleted)
    CampaignEventBus.off('subagent:failed',    this._onFailed)
    for (const [taskId] of this.pollTimers) this._clearPollTimer(taskId)
    for (const [taskId, queued] of this.queuedStarts) {
      queued.abortController.abort()
      this._settleBudget(taskId, 0)
      this._clearParentAbortForwarder(taskId)
    }
    this.queuedStarts.clear()
    this.startQueue.length = 0
    // Abort all in-flight runners
    const running = [...this.runners.entries()]
    for (const [taskId, runner] of this.runners) {
      runner.abort('Session disposed')
      this._clearParentAbortForwarder(taskId)
    }
    await Promise.race([
      Promise.allSettled(running.map(([, runner]) => runner.wait())),
      new Promise(resolve => setTimeout(resolve, Math.max(0, waitMs))),
    ])
    for (const [taskId] of running) {
      this.runners.delete(taskId)
      this.activeTaskIds.delete(taskId)
    }
    // S11: reset counters and pending notifications so a re-created bridge for
    // the same session starts cleanly.
    this._finishedCount = 0
    this.pendingNotifications.length = 0
    SubAgentBridge._bridgesBySessionId.delete(this.parentSessionId)
  }

  // ── Spawn ───────────────────────────────────────────────────────────────────

  /**
   * Spawn a new sub-agent task. Returns the queued task record immediately;
   * the scheduler starts it asynchronously when capacity is available.
   */
  async spawnSubAgent(opts: SpawnSubAgentOptions): Promise<SubAgentRecord> {
    const config: SubAgentConfig = {
      ...DEFAULT_SUB_AGENT_CONFIG,
      ...opts.config,
    }

    const outstandingTasks = this.activeTaskIds.size + this.queuedStarts.size
    const maxOutstandingTasks = this.maxConcurrentSubAgents + this.maxQueuedSubAgents
    if (outstandingTasks >= maxOutstandingTasks) {
      throw new Error(
        `[SubAgentBridge] Sub-agent queue is full ` +
        `(${outstandingTasks}/${maxOutstandingTasks} outstanding; ` +
        `${this.maxConcurrentSubAgents} running slots, ${this.maxQueuedSubAgents} queued slots). ` +
        'Wait for queued tasks to start or raise META_AGENT_MAX_QUEUED_SUB_AGENTS.',
      )
    }

    const requestedBudget = Math.max(0, config.maxBudgetUsd)
    if (
      this.maxTotalSubAgentBudgetUsd !== undefined &&
      this.settledCostUsd + this.reservedBudgetUsd + requestedBudget > this.maxTotalSubAgentBudgetUsd
    ) {
      throw new Error(
        `[SubAgentBridge] Sub-agent budget exceeded. ` +
        `Requested $${requestedBudget.toFixed(4)}, ` +
        `reserved $${this.reservedBudgetUsd.toFixed(4)}, ` +
        `settled $${this.settledCostUsd.toFixed(4)}, ` +
        `limit $${this.maxTotalSubAgentBudgetUsd.toFixed(4)}.`,
      )
    }

    const taskId = opts.taskId ?? makeSubAgentTaskId()
    const record: SubAgentRecord = {
      schemaVersion:        '1.0',
      taskId,
      parentSessionId:      this.parentSessionId,
      status:               'queued',
      config,
      createdAt:            Date.now(),
      pendingHumanApproval: false,
    }

    await writeTask(record)
    this._reserveBudget(taskId, requestedBudget)

    const abortController = new AbortController()
    // If parent is aborted, cancel this sub-agent.
    // M5-fix: an ALREADY-aborted signal never fires its 'abort' listener
    // (per spec), so check .aborted first — otherwise a spawn racing a user
    // interrupt would queue and run despite the parent turn being cancelled.
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) {
        abortController.abort()
      } else {
        const forwardAbort = () => abortController.abort()
        opts.abortSignal.addEventListener('abort', forwardAbort, { once: true })
        this.parentAbortCleanups.set(taskId, () => {
          opts.abortSignal?.removeEventListener('abort', forwardAbort)
        })
      }
    }

    // Start poll timer if not event-driven
    if (!config.useEventDriven) {
      this._startPollTimer(taskId, config.pollIntervalMs)
    }

    this.queuedStarts.set(taskId, { record, abortController })
    this.startQueue.push(taskId)
    this._scheduleDrain()

    return record
  }

  // ── Status queries ──────────────────────────────────────────────────────────

  /**
   * Read the current status of a sub-agent task.
   * Returns null when the taskId is unknown.
   */
  async getStatus(taskId: SubAgentTaskId): Promise<SubAgentRecord | null> {
    return readTask(taskId)
  }

  /**
   * Read the latest checkpoint of a running sub-agent.
   * This is the "explicit intermediate fetch" path — only called when the
   * main agent actively requests intermediate state.
   */
  async getIntermediate(taskId: SubAgentTaskId): Promise<{
    taskId: SubAgentTaskId
    status: string
    latestCheckpoint?: string
    latestCheckpointAt?: number
    turnsUsed?: number
  } | null> {
    const record = await readTask(taskId)
    if (!record) return null
    return {
      taskId: record.taskId,
      status: record.status,
      latestCheckpoint:   record.latestCheckpoint,
      latestCheckpointAt: record.latestCheckpointAt,
    }
  }

  /**
   * Cancel a running sub-agent task.
   */
  async cancelTask(taskId: SubAgentTaskId, reason?: string): Promise<boolean> {
    const record = await readTask(taskId)
    if (!record) return false
    if (TERMINAL_STATUSES.has(record.status)) return false

    const queued = this.queuedStarts.get(taskId)
    if (queued) {
      queued.abortController.abort()
      this.queuedStarts.delete(taskId)
      const idx = this.startQueue.indexOf(taskId)
      if (idx >= 0) this.startQueue.splice(idx, 1)
    }

    const runner = this.runners.get(taskId)
    if (runner) {
      // Abort the runner's internal AbortController so the MetaAgentSession
      // receives an interrupt signal.  We also write the cancelled record
      // immediately (below) so the task appears cancelled right away rather
      // than waiting for the runner to observe the abort signal.
      // SubAgentRunner._writeTerminal() guards against overwriting a
      // cancelled record, so there is no race condition.
      runner.abort()
      // Keep the runner in the map until it fully stops — the runner will
      // reach its own terminal state (aborted → no further writes) and the
      // map entry will be cleaned up at destroy() time.
    }

    // Write cancelled status immediately.
    // L1-fix: go through mutateTask so the terminal-state check and the write
    // happen atomically on the per-task write chain — a runner finishing in
    // parallel can no longer interleave (whoever writes first wins; the loser
    // observes the terminal record and backs off).
    const written = await mutateTask(taskId, disk => {
      const base = disk ?? record
      if (TERMINAL_STATUSES.has(base.status)) return null
      return {
        ...base,
        status:       'cancelled',
        completedAt:  Date.now(),
        result: {
          success:      false,
          summary:      reason ? `Cancelled: ${reason}` : 'Cancelled by parent agent',
          error:        'cancelled',
          turnsUsed:    0,
          inputTokens:  0,
          outputTokens: 0,
          costUsd:      0,
          durationMs:   Date.now() - (base.startedAt ?? base.createdAt),
        },
        pendingHumanApproval: false,
      }
    })
    await releaseWriteChain(taskId)

    if (written) {
      this._settleBudget(taskId, written.result?.costUsd)
      CampaignEventBus.emit('subagent:failed', {
        taskId,
        parentSessionId: this.parentSessionId,
        error: 'cancelled',
      })
    } else {
      // Runner reached terminal state first — settle with its actual cost.
      const finalRecord = await readTask(taskId).catch(() => null)
      this._settleBudget(taskId, finalRecord?.result?.costUsd)
    }

    this._clearPollTimer(taskId)
    this.runners.delete(taskId)
    this.activeTaskIds.delete(taskId)
    this._clearParentAbortForwarder(taskId)
    return true
  }

  /**
   * Cancel ALL running sub-agent tasks spawned by this bridge.
   * Called by RoboticsSession.dispose() on graceful shutdown.
   */
  async cancelAll(reason = 'Session disposed'): Promise<void> {
    const ids = [...new Set([...this.startQueue, ...this.queuedStarts.keys(), ...this.runners.keys()])]
    await Promise.allSettled(ids.map(id => this.cancelTask(id, reason)))
  }

  /**
   * List all tasks spawned by this bridge's parent session.
   */
  async listTasks(): Promise<SubAgentRecord[]> {
    return listTasksForSession(this.parentSessionId)
  }

  // ── Notification queue ──────────────────────────────────────────────────────

  /**
   * Atomically read and clear pending notifications.
   * Called by the D-SubAgent dynamic prompt section on every submit().
   * Returns empty array when there are no pending notifications.
   */
  drainNotifications(): string[] {
    if (this.pendingNotifications.length === 0) return []
    return this.pendingNotifications.splice(0)
  }

  /**
   * Check if there are pending notifications without clearing them.
   */
  hasPendingNotifications(): boolean {
    return this.pendingNotifications.length > 0
  }

  /**
   * Return a snapshot of the scheduler's current state.
   * Safe to call at any time — reads in-memory counters only.
   *
   * Use this for diagnostics, CLI status display, and the D-SubAgent prompt
   * section (to warn the AI when tasks have been queued for a long time).
   */
  getSchedulerStats(): SubAgentSchedulerStats {
    const now = Date.now()
    let oldestQueuedMs = 0
    for (const { record } of this.queuedStarts.values()) {
      const age = now - record.createdAt
      if (age > oldestQueuedMs) oldestQueuedMs = age
    }
    return {
      queued:                this.queuedStarts.size,
      running:               this.activeTaskIds.size,
      finishedThisSession:   this._finishedCount,
      oldestQueuedMs,
      activeTaskIds:         [...this.activeTaskIds],
      maxConcurrent:         this.maxConcurrentSubAgents,
    }
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private _enqueueNotification(text: string): void {
    // S12: prefer shift() over splice() — V8's fast path keeps shift amortised
    // O(1) for small arrays, while splice always re-allocates the storage.
    this.pendingNotifications.push(text)
    while (this.pendingNotifications.length > MAX_PENDING_NOTIFICATIONS) {
      this.pendingNotifications.shift()
    }
  }

  private _startPollTimer(taskId: SubAgentTaskId, intervalMs: number): void {
    const timer = setInterval(async () => {
      const record = await readTask(taskId)
      if (!record) {
        this._clearPollTimer(taskId)
        return
      }
      if (TERMINAL_STATUSES.has(record.status)) {
        let resultLine: string
        if (record.result?.success) {
          const ps = record.result.progressState
          const progressSuffix = ps
            ? ` | 工具调用: ${ps.toolCallsCompleted}` +
              (ps.stepsCompleted > 0 ? ` 步: ${ps.stepsCompleted}` : '') +
              (ps.provenanceIds.length > 0
                ? ` | provenance: ${ps.provenanceIds.slice(0, 5).join(', ')}${ps.provenanceIds.length > 5 ? ` (+${ps.provenanceIds.length - 5})` : ''}`
                : '')
            : ''
          resultLine =
            `✓ 已完成 | ${record.result.turnsUsed} 轮 / $${record.result.costUsd.toFixed(4)}${progressSuffix} | ` +
            `摘要: ${record.result.summary.slice(0, 300)}`
        } else {
          resultLine = `✗ 失败 | ${record.result?.error ?? 'unknown'}`
        }
        this._enqueueNotification(`[${taskId}] ${resultLine}`)
        this._clearPollTimer(taskId)
      }
    }, intervalMs)
    if (timer.unref) timer.unref()
    this.pollTimers.set(taskId, timer)
  }

  private _clearPollTimer(taskId: SubAgentTaskId): void {
    const timer = this.pollTimers.get(taskId)
    if (timer !== undefined) {
      clearInterval(timer)
      this.pollTimers.delete(taskId)
    }
  }

  private _scheduleDrain(): void {
    if (this.drainingStarts || this.destroyed) return
    this.drainingStarts = true
    void this._drainStartQueue()
  }

  private _envBudgetUsd(name: string): number | undefined {
    const raw = process.env[name]
    if (raw === undefined || raw.trim() === '') return undefined
    const parsed = Number.parseFloat(raw)
    if (!Number.isFinite(parsed) || parsed < 0) return undefined
    return parsed
  }

  private _reserveBudget(taskId: SubAgentTaskId, amountUsd: number): void {
    if (amountUsd <= 0) return
    this.reservedBudgetByTask.set(taskId, amountUsd)
    this.reservedBudgetUsd += amountUsd
  }

  private _settleBudget(taskId: SubAgentTaskId, actualCostUsd: number | undefined): void {
    const reserved = this.reservedBudgetByTask.get(taskId) ?? 0
    if (reserved > 0) {
      this.reservedBudgetUsd = Math.max(0, this.reservedBudgetUsd - reserved)
      this.reservedBudgetByTask.delete(taskId)
    }
    if (actualCostUsd !== undefined && Number.isFinite(actualCostUsd) && actualCostUsd > 0) {
      this.settledCostUsd += actualCostUsd
    }
  }

  private _clearParentAbortForwarder(taskId: SubAgentTaskId): void {
    const cleanup = this.parentAbortCleanups.get(taskId)
    if (!cleanup) return
    cleanup()
    this.parentAbortCleanups.delete(taskId)
  }

  private async _failStaleActiveTasks(): Promise<void> {
    const records = await listTasksForSession(this.parentSessionId)
    await Promise.allSettled(
      records
        .filter(record =>
          (record.status === 'pending' || record.status === 'queued' || record.status === 'running') &&
          record.createdAt < this.constructedAtMs,
        )
        .map(async record => {
          const completedAt = Date.now()
          const summary = record.status === 'queued' || record.status === 'pending'
            ? 'Process terminated before sub-agent task started'
            : 'Process terminated before sub-agent task completed'
          await writeTask({
            ...record,
            status: 'failed',
            completedAt,
            pendingHumanApproval: false,
            result: {
              success: false,
              summary,
              error: summary,
              turnsUsed: 0,
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 0,
              durationMs: completedAt - (record.startedAt ?? record.createdAt),
            },
          })
          await releaseWriteChain(record.taskId)
        }),
    )
  }

  private async _drainStartQueue(): Promise<void> {
    try {
      while (
        !this.destroyed &&
        this.activeTaskIds.size < this.maxConcurrentSubAgents &&
        this.startQueue.length > 0
      ) {
        const taskId = this.startQueue.shift()!
        const queued = this.queuedStarts.get(taskId)
        if (!queued) continue

        if (queued.abortController.signal.aborted) {
          await this.cancelTask(taskId, 'cancelled before start').catch(() => undefined)
          continue
        }

        const diskRecord = await readTask(taskId)
        if (!diskRecord || TERMINAL_STATUSES.has(diskRecord.status)) {
          this.queuedStarts.delete(taskId)
          this._clearParentAbortForwarder(taskId)
          continue
        }

        const runner = new SubAgentRunner(
          queued.record,
          this.toolRegistry,
          queued.abortController.signal,
        )
        this.queuedStarts.delete(taskId)
        this.runners.set(taskId, runner)
        this.activeTaskIds.add(taskId)

        void runner.start()
          .catch(() => undefined)
          .finally(async () => {
            const finalRecord = await readTask(taskId).catch(() => null)
            this._settleBudget(taskId, finalRecord?.result?.costUsd)
            this.runners.delete(taskId)
            this.activeTaskIds.delete(taskId)
            this._clearParentAbortForwarder(taskId)
            this._finishedCount++
            this._scheduleDrain()
        })

        if (this.startDelayMs > 0 && this.startQueue.length > 0) {
          await this._sleepStartDelay(this.startDelayMs)
        }
      }
    } finally {
      this.drainingStarts = false
      if (
        !this.destroyed &&
        this.activeTaskIds.size < this.maxConcurrentSubAgents &&
        this.startQueue.length > 0
      ) {
        this._scheduleDrain()
      }
    }
  }

  private _sleepStartDelay(ms: number): Promise<void> {
    if (ms <= 0 || this.destroyed) return Promise.resolve()
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms)
      if (timer.unref) timer.unref()
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic prompt section builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimum queue age (ms) before a "tasks are waiting" warning is injected
 * into the system prompt.  Prevents noise on fast-start queues while ensuring
 * the AI knows about long-running backlogs.
 */
const STALE_QUEUE_WARN_MS = 30_000

/**
 * Build the D-SubAgent dynamic system prompt section.
 *
 * Called by MetaAgentSession / dynamicPrompt.ts before each submit() turn.
 * Returns empty string when there are no pending notifications and no notable
 * queue conditions.
 *
 * The section is injected as a volatile section (rebuilt every turn) because
 * notifications arrive asynchronously and must not be cached.
 *
 * Content:
 *   1. Queue status warning — emitted when tasks have been queued > 30 s, so
 *      the AI never mistakes "not yet started" for "already running".
 *   2. Terminal notifications — tasks that just completed or failed.
 */
export function buildSubAgentNotificationSection(bridge: SubAgentBridge): string {
  const notifications = bridge.drainNotifications()
  const stats = bridge.getSchedulerStats()

  const lines: string[] = []

  // ── #12 Queue status warning ──────────────────────────────────────────────
  // Show whenever there are queued or running tasks, but upgrade the warning
  // to a prominent caution block when queued tasks have been waiting a while.
  if (stats.queued > 0 || stats.running > 0) {
    const oldestSec = Math.round(stats.oldestQueuedMs / 1_000)
    if (stats.queued > 0 && stats.oldestQueuedMs >= STALE_QUEUE_WARN_MS) {
      lines.push('## Sub-Agent Queue Status ⚠')
      lines.push(
        `- Running: ${stats.running}/${stats.maxConcurrent} | ` +
        `Queued: ${stats.queued} (oldest: ${oldestSec}s)`,
      )
      lines.push(
        '> Queued sub-agents have NOT started yet. ' +
        'Do NOT treat them as running or assume any work has been done. ' +
        'Wait or cancel before dispatching duplicates.',
      )
    } else {
      lines.push(
        `## Sub-Agent Status: ${stats.running} running, ${stats.queued} queued` +
        (stats.queued > 0 && stats.oldestQueuedMs > 0 ? ` (oldest: ${oldestSec}s)` : ''),
      )
    }
    lines.push('')
  }

  // ── Terminal notifications ─────────────────────────────────────────────────
  if (notifications.length > 0) {
    lines.push('## Sub-Agent Notifications (pending)')
    lines.push(...notifications.map(n => `- ${n}`))
    lines.push('')
    lines.push(
      '> These sub-tasks just reached terminal state. ' +
      'Use `get_sub_agent_status` to retrieve full results. ' +
      'If `pending_human_approval` is true, you MUST present the result to the user before proceeding.',
    )
  }

  return lines.join('\n')
}

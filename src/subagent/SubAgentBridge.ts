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

// ── Auto-mode sub-agent retry policy ──────────────────────────────────────────
/** Default number of automatic retries for a failed sub-agent (auto mode). */
const DEFAULT_AUTO_RETRY_LIMIT = 2
/** Auto-mode conservative scheduler defaults (override-able by env vars). */
const AUTO_MAX_CONCURRENT_SUB_AGENTS = 3
const AUTO_DEFAULT_TOTAL_BUDGET_USD = 5

const MERGED_NOTICE_RE = /^\[(\d+) 条更早的子代理通知已合并/

/**
 * Collapse a batch of overflow notifications into ONE summary line that
 * preserves the total count (accumulating any prior merged-summary count), so
 * backpressure never silently loses sub-agent outcomes.
 */
export function mergeOverflowNotifications(overflow: readonly string[]): string {
  let count = 0
  const samples: string[] = []
  for (const n of overflow) {
    const m = MERGED_NOTICE_RE.exec(n)
    if (m) {
      count += parseInt(m[1]!, 10)
    } else {
      count += 1
      if (samples.length < 3) samples.push(n.length > 120 ? n.slice(0, 117) + '…' : n)
    }
  }
  const eg = samples.length ? ` 例如：${samples.join(' | ')}` : ''
  return `[${count} 条更早的子代理通知已合并，未丢弃]${eg}`
}

/** Exponential backoff (capped) before re-spawning a failed sub-agent. */
export function retryBackoffMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt))
}

/** Whether a failed sub-agent should be retried. */
export function shouldRetrySubAgent(attempt: number, limit: number, armed: boolean): boolean {
  return armed && limit > 0 && attempt < limit
}

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
  /**
   * Auto mode: lower the DEFAULT concurrency (→ AUTO_MAX_CONCURRENT_SUB_AGENTS)
   * and apply a non-null default total budget (→ AUTO_DEFAULT_TOTAL_BUDGET_USD)
   * for unattended safety. Explicit options and env vars still take precedence.
   */
  conservativeAutoDefaults?: boolean
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
  /** Sub-agent-only tool overrides (see setSubAgentToolOverrides). */
  private subAgentToolOverrides: Map<string, MetaAgentTool> = new Map()
  /** Auto-mode jail forwarded to every spawned sub-agent (see setAutonomyJail). */
  private _autonomyJail: { workspaceRoot: string; autonomy: import('../core/types.js').AutonomyProfile } | null = null
  /** Auto-mode worktree isolation (see setWorktreeCoordinator). */
  private _worktreeCoordinator: import('../core/auto/AutoWorktreeCoordinator.js').AutoWorktreeCoordinator | null = null
  /** Auto-mode failed-sub-agent retry limit (0 = no retry; set when jail armed). */
  private _autoRetryLimit = 0
  /** Pending retry backoff timers, cleared on dispose. */
  private readonly _retryTimers = new Set<ReturnType<typeof setTimeout>>()

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
    // Auto mode: lower the DEFAULTS (concurrency + a non-null total budget) but
    // keep precedence explicit-option > env > default, so an operator can still
    // raise them via env without code changes.
    const concurrencyDefault = options.conservativeAutoDefaults
      ? AUTO_MAX_CONCURRENT_SUB_AGENTS : DEFAULT_MAX_CONCURRENT_SUB_AGENTS
    this.maxConcurrentSubAgents = Math.max(
      1,
      options.maxConcurrentSubAgents ??
        envInt('META_AGENT_MAX_CONCURRENT_SUB_AGENTS', concurrencyDefault, 1, 64),
    )
    this.maxQueuedSubAgents = Math.max(
      0,
      options.maxQueuedSubAgents ??
        envInt('META_AGENT_MAX_QUEUED_SUB_AGENTS', DEFAULT_MAX_QUEUED_SUB_AGENTS, 0, 10_000),
    )
    this.maxTotalSubAgentBudgetUsd = options.maxTotalSubAgentBudgetUsd ??
      this._envBudgetUsd('META_AGENT_MAX_TOTAL_SUB_AGENT_BUDGET_USD') ??
      (options.conservativeAutoDefaults ? AUTO_DEFAULT_TOTAL_BUDGET_USD : undefined)
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
      this._clearPollTimer(e.taskId)
      // Auto mode: retry transient failures with exponential backoff before
      // surfacing the failure to the main agent. Fire-and-forget.
      void this._maybeRetryFailed(e.taskId, e.error)
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
   * Sub-agent-only tool overrides, merged OVER the main registry at runner
   * construction time. Used to give sub-agents variants that differ from the
   * main agent's — e.g. an UNBUDGETED web_fetch: the main agent's fetch is
   * result-budgeted (its context is long-lived), while a research sub-agent
   * must read full texts in its isolated, discarded-after-run context.
   */
  setSubAgentToolOverrides(tools: readonly MetaAgentTool[]): void {
    this.subAgentToolOverrides = new Map(tools.map(t => [t.name, t]))
  }

  /**
   * Arm the auto-mode jail. When set, every spawned sub-agent inherits:
   *   - a fail-closed OS sandbox whose only writable root is the workspace
   *     (no extra writeAllowPaths) — closes the run_agent jail-escape hole;
   *   - the autonomy profile, so the sub-agent's OWN permission policy enforces
   *     the same workspace jail + auto-approve posture;
   *   - projectDir bound to the jail root.
   * Explicit per-spawn `sandbox` / `autonomy` / `projectDir` still win (e.g. a
   * worktree-bound projectDir), so this only fills the defaults.
   */
  setAutonomyJail(
    jail: { workspaceRoot: string; autonomy: import('../core/types.js').AutonomyProfile } | null,
    opts?: { retryLimit?: number },
  ): void {
    this._autonomyJail = jail
    this._autoRetryLimit = jail ? (opts?.retryLimit ?? DEFAULT_AUTO_RETRY_LIMIT) : 0
  }

  /**
   * Arm auto-mode worktree isolation. Sub-agents spawned with
   * config.isolateWorktree then run in their own git worktree+branch. The main
   * agent merges/diffs/discards via the coordinator (exposed by getter).
   */
  setWorktreeCoordinator(coord: import('../core/auto/AutoWorktreeCoordinator.js').AutoWorktreeCoordinator | null): void {
    this._worktreeCoordinator = coord
  }

  /** The armed worktree coordinator, if any (used by the auto worktree tools). */
  getWorktreeCoordinator(): import('../core/auto/AutoWorktreeCoordinator.js').AutoWorktreeCoordinator | null {
    return this._worktreeCoordinator
  }

  /**
   * Apply the armed auto-mode jail to a fully-merged sub-agent config.
   * No-op when the jail is not armed. Forces a fail-closed sandbox (the
   * unsandboxed fallback is never allowed under autonomy, regardless of what a
   * caller passed), while preserving any explicit extra sandbox keys
   * (e.g. writeAllowPaths for a worktree). autonomy/projectDir are FILLED only
   * when the caller didn't set them, so worktree-bound projectDir still wins.
   */
  private _applyAutonomyJail(config: SubAgentConfig): SubAgentConfig {
    const jail = this._autonomyJail
    if (!jail) return config
    return {
      ...config,
      sandbox: { ...config.sandbox, allowUnsandboxedFallback: false },
      autonomy: config.autonomy ?? jail.autonomy,
      projectDir: config.projectDir ?? jail.workspaceRoot,
    }
  }

  /** Effective registry for a new runner: main registry + overrides. */
  private _effectiveToolRegistry(): Map<string, MetaAgentTool> {
    if (this.subAgentToolOverrides.size === 0) return this.toolRegistry
    return new Map([...this.toolRegistry, ...this.subAgentToolOverrides])
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
    for (const timer of this._retryTimers) clearTimeout(timer)
    this._retryTimers.clear()
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
    let config: SubAgentConfig = this._applyAutonomyJail({
      ...DEFAULT_SUB_AGENT_CONFIG,
      ...opts.config,
    })

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

    // Auto mode worktree isolation: when requested AND a git-backed coordinator
    // is armed, give this sub-agent its own worktree+branch and bind its
    // projectDir + sandbox writable root there, so its writes cannot race other
    // concurrent sub-agents. Best-effort: on any git failure we fall back to the
    // shared tree (still protected by the write mutex).
    if (config.isolateWorktree && this._worktreeCoordinator?.enabled) {
      try {
        const wt = await this._worktreeCoordinator.allocate(taskId)
        if (wt) {
          config = {
            ...config,
            projectDir: wt.worktreePath,
            sandbox: { ...config.sandbox, writeAllowPaths: [wt.worktreePath] },
          }
        }
      } catch { /* fall back to shared tree */ }
    }

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
      this._startPollTimer(taskId, config.pollIntervalMs, config.maxDurationMs)
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

  /**
   * Auto mode: on a sub-agent failure, retry with exponential backoff up to the
   * limit. Each retry re-spawns the SAME config (new taskId) with an incremented
   * retryCount. When retries are exhausted (or not armed), the failure is
   * surfaced to the main agent as a notification so it can decide what to do.
   * Returns nothing; enqueues the appropriate notification.
   */
  private async _maybeRetryFailed(taskId: SubAgentTaskId, error: string): Promise<void> {
    const surfaceFailure = () =>
      this._enqueueNotification(`[${taskId}] ✗ 失败 | 原因: ${error.slice(0, 200)}`)

    if (this.destroyed) return
    const rec = await readTask(taskId).catch(() => null)
    const attempt = rec?.config.retryCount ?? 0
    if (!rec || !shouldRetrySubAgent(attempt, this._autoRetryLimit, this._autonomyJail !== null)) {
      surfaceFailure()
      return
    }

    const delay = retryBackoffMs(attempt)
    this._enqueueNotification(
      `[${taskId}] ↻ 失败，将在 ${Math.round(delay / 1000)}s 后第 ${attempt + 1}/${this._autoRetryLimit} 次重试 | 原因: ${error.slice(0, 120)}`,
    )
    const timer = setTimeout(() => {
      this._retryTimers.delete(timer)
      if (this.destroyed) return
      void this.spawnSubAgent({ config: { ...rec.config, retryCount: attempt + 1 } }).catch(() => {
        this._enqueueNotification(`[${taskId}] ✗ 重试派发失败；原始错误: ${error.slice(0, 120)}`)
      })
    }, delay)
    if (timer.unref) timer.unref()
    this._retryTimers.add(timer)
  }

  private _enqueueNotification(text: string): void {
    this.pendingNotifications.push(text)
    // Backpressure: instead of SILENTLY dropping the oldest overflow (which
    // loses sub-agent outcomes in a long unattended run), collapse the oldest
    // entries into ONE merged-summary line that preserves the count. Nothing is
    // lost without trace; the array stays bounded.
    if (this.pendingNotifications.length > MAX_PENDING_NOTIFICATIONS) {
      const overflowCount = this.pendingNotifications.length - (MAX_PENDING_NOTIFICATIONS - 1)
      const overflow = this.pendingNotifications.splice(0, overflowCount)
      this.pendingNotifications.unshift(mergeOverflowNotifications(overflow))
    }
  }

  private _startPollTimer(
    taskId: SubAgentTaskId,
    intervalMs: number,
    maxDurationMs?: number,
  ): void {
    const startedAt = Date.now()
    // M5: absolute safety cap. If the task never reaches a terminal state — e.g.
    // its runner died in another process without writing a terminal record —
    // stop polling instead of leaking this interval for the host's lifetime.
    // Generous slack over the runner's own wall-clock cap so a legitimately
    // slow task is never cut off early.
    const maxAgeMs = Math.max((maxDurationMs ?? 300_000) * 4, intervalMs * 4)
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
        return
      }
      // Non-terminal but past the safety cap — declare lost and stop polling.
      if (Date.now() - startedAt > maxAgeMs) {
        this._enqueueNotification(
          `[${taskId}] ⚠ 轮询超时：子代理在 ${Math.round(maxAgeMs / 60_000)} 分钟内未进入终态` +
          `（其 runner 进程可能已退出），已停止轮询。`,
        )
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
          this._effectiveToolRegistry(),
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

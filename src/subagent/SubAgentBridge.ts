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
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { readIntEnvOr, readFloatEnv } from '../infra/env/RuntimeEnv.js'
import { readTask, writeTask, mutateTask, releaseWriteChain, listTasksForSession, cleanupTerminalTasks } from './SubAgentTaskStore.js'
import { SubAgentRunner } from './SubAgentRunner.js'
import { CampaignEventBus } from './CampaignEventBus.js'
import {
  makeSubAgentTaskId,
  DEFAULT_SUB_AGENT_CONFIG,
  DEFAULT_SUB_AGENT_MAX_DURATION_MS,
  TERMINAL_STATUSES,
  type SubAgentConfig,
  type SubAgentRecord,
  type SubAgentTaskId,
  type SubAgentCompletedEvent,
  type SubAgentFailedEvent,
} from './types.js'
import type { ISubAgentDispatcher } from './ISubAgentDispatcher.js'
import type { MetaAgentEvent, MetaAgentTool } from '../core/types.js'
import type { AutoCostLedger } from '../core/auto/AutoCostLedger.js'

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
const AUTO_DEFAULT_TOTAL_BUDGET_USD = 10

const MERGED_NOTICE_RE = /^\[(\d+) 条更早的子代理通知已合并/
const SHARED_READONLY_BLOCKED_WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'notebook_edit',
])
const SHARED_READONLY_ALLOWED_WRITE_TOOLS = new Set([
  // Auto Learn runs as a shared_readonly drift sub-agent: the workspace must be
  // read-only, but it still needs to persist grounded lessons.
  'experience_write',
])

function isSharedReadonlyWriteTool(toolName: string, tool?: MetaAgentTool): boolean {
  if (SHARED_READONLY_ALLOWED_WRITE_TOOLS.has(toolName)) return false
  if (tool?.permission?.category === 'write') return true
  if (SHARED_READONLY_BLOCKED_WRITE_TOOLS.has(toolName)) return true
  return toolName.endsWith('_write')
}

function filterSharedReadonlyTools(
  allowedTools: readonly string[] | undefined,
  registry: Map<string, MetaAgentTool>,
): string[] | undefined {
  if (!allowedTools) return undefined
  return allowedTools.filter(name => !isSharedReadonlyWriteTool(name, registry.get(name)))
}

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

export function isDeterministicSubAgentFailure(error: string): boolean {
  return /Turn limit exceeded|Budget exceeded|No tools resolved|cancelled|isolated_write requires|Sandbox requested|nested bwrap|not found on PATH/i
    .test(error)
}

/** Bridge-level auto-retry gate for a spawned sub-agent config. */
export function shouldRetrySubAgentConfig(
  _config: SubAgentConfig | undefined,
  attempt: number,
  limit: number,
  armed: boolean,
  error = '',
): boolean {
  if (isDeterministicSubAgentFailure(error)) return false
  return shouldRetrySubAgent(attempt, limit, armed)
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  return readIntEnvOr(name, fallback, min, max)
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
  /**
   * Optional non-persistent runtime observer for callers that own a sub-agent
   * and want live diagnostics. This is intentionally not stored in
   * SubAgentRecord.config because task records are JSON persisted.
   */
  onRuntimeEvent?: (event: SubAgentRuntimeEvent) => void | Promise<void>
}

export type SubAgentRuntimeEvent =
  | { type: 'runner_started'; taskId: SubAgentTaskId }
  | { type: 'session_submit_started'; taskId: SubAgentTaskId }
  | { type: 'session_event'; taskId: SubAgentTaskId; event: MetaAgentEvent }

export interface SubAgentBridgeOptions {
  /** Maximum number of sub-agent sessions running at once. */
  maxConcurrentSubAgents?: number
  /** Maximum number of sub-agent sessions waiting for a scheduler slot. */
  maxQueuedSubAgents?: number
  /** Maximum aggregate budget for sub-agents owned by this bridge. */
  maxTotalSubAgentBudgetUsd?: number
  /** Minimum delay between starting queued sub-agents. */
  startDelayMs?: number
  /** Shared auto-session budget ledger; absent keeps legacy per-bridge limits. */
  costLedger?: AutoCostLedger
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
  onRuntimeEvent?: SpawnSubAgentOptions['onRuntimeEvent']
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
  private readonly costLedger: AutoCostLedger | undefined
  private readonly startDelayMs: number
  private readonly constructedAtMs = Date.now()
  private reservedBudgetUsd = 0
  private settledCostUsd = 0
  private readonly reservedBudgetByTask = new Map<SubAgentTaskId, number>()
  /** Internal safety-gate task IDs bypass local queue/worker limits only. */
  private readonly internalTaskIds = new Set<SubAgentTaskId>()
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
    this.costLedger = options.costLedger
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
      this._clearPollTimer(e.taskId)
      void this._handleCompleted(e)
    }

    this._onFailed = (e) => {
      if (e.parentSessionId !== this.parentSessionId) return
      this._clearPollTimer(e.taskId)
      void this._worktreeCoordinator?.markFailed(e.taskId, e.error).catch(() => undefined)
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
    if (coord) void this._reconcileWorktreeTaskOutcomes(coord)
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
    this.internalTaskIds.clear()
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
    const isolatedWrite =
      config.workspaceMode === 'isolated_write' || config.isolateWorktree === true
    config = {
      ...config,
      workspaceMode: isolatedWrite
        ? 'isolated_write'
        : (config.workspaceMode ?? 'shared_write'),
      isolateWorktree: isolatedWrite,
    }
    if (config.workspaceMode === 'shared_readonly') {
      config = {
        ...config,
        allowedTools: filterSharedReadonlyTools(config.allowedTools, this._effectiveToolRegistry()),
        sandbox: {
          ...config.sandbox,
          readonlyWorkspace: true,
          writeAllowPaths: [],
          allowUnsandboxedFallback: false,
        },
      }
    }

    // Internal safety-gate tasks (verify/drift) get a reserved side lane: they
    // bypass the queue-full and total-budget caps so ordinary research/worker
    // sub-agents can never starve the gate that is supposed to police them.
    const isInternal = config.internal === true

    const outstandingTasks = this.activeTaskIds.size + this.queuedStarts.size
    const maxOutstandingTasks = this.maxConcurrentSubAgents + this.maxQueuedSubAgents
    if (!isInternal && outstandingTasks >= maxOutstandingTasks) {
      throw new Error(
        `[SubAgentBridge] Sub-agent queue is full ` +
        `(${outstandingTasks}/${maxOutstandingTasks} outstanding; ` +
        `${this.maxConcurrentSubAgents} running slots, ${this.maxQueuedSubAgents} queued slots). ` +
        'Wait for queued tasks to start or raise META_AGENT_MAX_QUEUED_SUB_AGENTS.',
      )
    }

    const taskId = opts.taskId ?? makeSubAgentTaskId()
    const requestedBudget = Math.max(0, config.maxBudgetUsd)
    if (
      !isInternal &&
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

    let ledgerReserved = false
    if (this.costLedger) {
      if (!this.costLedger.tryReserveTask(taskId, requestedBudget)) {
        const stats = this.costLedger.getBreakdown()
        throw new Error(
          `[SubAgentBridge] Auto session budget exceeded. Requested $${requestedBudget.toFixed(4)}, ` +
          `committed $${stats.committedCostUsd.toFixed(4)}, limit $${stats.budgetUsd.toFixed(4)}.`,
        )
      }
      ledgerReserved = true
    }

    // Explicit isolated-write requests fail closed. Silently falling back to
    // the shared tree would reintroduce concurrent-write races while reporting
    // a false isolation guarantee to the caller.
    let record: SubAgentRecord
    try {
      if (isolatedWrite) {
        if (!this._worktreeCoordinator?.enabled) {
          throw new Error('isolated_write requires an auto-mode git worktree coordinator')
        }
        const wt = await this._worktreeCoordinator.allocate(taskId, this.parentSessionId)
        if (!wt) throw new Error('isolated_write requires a git workspace')
        // Deny writes to the worktree's .meta-agent/: finalize/merge exclude it
        // (:(exclude).meta-agent/**), so anything written there is silently
        // discarded. Denying at the sandbox level makes bash writes fail fast
        // too (the tool-level guard in SubAgentRunner covers edit/write tools
        // with an instructive message). Pre-create the dir so bwrap's ro-bind
        // approximation has an existing bind source.
        const metaAgentDir = join(wt.worktreePath, '.meta-agent')
        await mkdir(metaAgentDir, { recursive: true }).catch(() => undefined)
        config = {
          ...config,
          projectDir: wt.worktreePath,
          sandbox: {
            ...config.sandbox,
            writeAllowPaths: [wt.worktreePath],
            writeDenyPaths: [...(config.sandbox?.writeDenyPaths ?? []), metaAgentDir],
          },
        }
      }

      record = {
        schemaVersion:        '1.0',
        taskId,
        parentSessionId:      this.parentSessionId,
        status:               'queued',
        config,
        createdAt:            Date.now(),
        pendingHumanApproval: false,
      }
      await writeTask(record)
    } catch (err) {
      if (isolatedWrite) {
        await this._worktreeCoordinator?.discard(taskId).catch(() => undefined)
      }
      if (ledgerReserved) this.costLedger?.releaseTaskReservation(taskId)
      throw err
    }
    // Internal tasks bypass only the local normal-worker cap. They still use
    // the shared auto-session ledger so verify/drift cannot spend unboundedly.
    if (isInternal) this.internalTaskIds.add(taskId)
    else this._reserveBudget(taskId, requestedBudget)

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

    this.queuedStarts.set(taskId, { record, abortController, onRuntimeEvent: opts.onRuntimeEvent })
    // Internal safety-gate tasks jump the queue so a backlog of research/worker
    // tasks can't delay the gate; ordinary tasks keep FIFO order.
    if (isInternal) this.startQueue.unshift(taskId)
    else this.startQueue.push(taskId)
    this._scheduleDrain()

    return record
  }

  // ── Status queries ──────────────────────────────────────────────────────────

  /**
   * Read the current status of a sub-agent task.
   * Returns null when the taskId is unknown.
   *
   * This is a pure READ from the caller's perspective: it never throws and never
   * lets a write side-effect break the read. For a completed isolated_write task
   * it opportunistically finalizes the worktree, but the AUTHORITATIVE finalize
   * already happens on the completion-event path (_handleCompleted), the poll
   * path (_startPollTimer), and on coordinator (re)attach
   * (_reconcileWorktreeTaskOutcomes). So a missing coordinator here is simply a
   * no-op (not an error), and a finalize failure is swallowed — neither must turn
   * a status query into a failed tool call.
   */
  async getStatus(taskId: SubAgentTaskId): Promise<SubAgentRecord | null> {
    const record = await readTask(taskId)
    if (
      record?.status === 'completed' &&
      record.config.workspaceMode === 'isolated_write' &&
      this._worktreeCoordinator
    ) {
      await this._worktreeCoordinator.finalize(taskId).catch(() => undefined)
    }
    return record
  }

  async waitForTerminal(
    taskId: SubAgentTaskId,
    opts: { timeoutMs?: number; abortSignal?: AbortSignal } = {},
  ): Promise<SubAgentRecord | null> {
    const initialRunner = this.runners.get(taskId)
    return new Promise<SubAgentRecord | null>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const cleanup = () => {
        CampaignEventBus.off('subagent:completed', onCompleted)
        CampaignEventBus.off('subagent:failed', onFailed)
        opts.abortSignal?.removeEventListener('abort', onAbort)
        if (timer) clearTimeout(timer)
      }

      const settle = (record: SubAgentRecord | null) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(record)
      }

      const readAndSettle = () => {
        void readTask(taskId).then(settle, () => settle(null))
      }

      const onCompleted = (e: SubAgentCompletedEvent) => {
        if (e.parentSessionId === this.parentSessionId && e.taskId === taskId) readAndSettle()
      }
      const onFailed = (e: SubAgentFailedEvent) => {
        if (e.parentSessionId === this.parentSessionId && e.taskId === taskId) readAndSettle()
      }
      const onAbort = () => readAndSettle()

      CampaignEventBus.on('subagent:completed', onCompleted)
      CampaignEventBus.on('subagent:failed', onFailed)
      if (opts.abortSignal) {
        if (opts.abortSignal.aborted) {
          onAbort()
          return
        }
        opts.abortSignal.addEventListener('abort', onAbort, { once: true })
      }
      if (opts.timeoutMs !== undefined && opts.timeoutMs >= 0) {
        timer = setTimeout(readAndSettle, opts.timeoutMs)
        if (timer.unref) timer.unref()
      }

      void readTask(taskId).then(record => {
        if (record && TERMINAL_STATUSES.has(record.status)) settle(record)
      }, () => undefined)
      void initialRunner?.wait().then(readAndSettle, readAndSettle)
    })
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
      await this._worktreeCoordinator?.markFailed(taskId, 'cancelled').catch(() => undefined)
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
    if (!rec || !shouldRetrySubAgentConfig(rec.config, attempt, this._autoRetryLimit, this._autonomyJail !== null, error)) {
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
      void (async () => {
        // Abandon the failed attempt's isolated worktree BEFORE re-spawning.
        // The retry gets a fresh taskId → a fresh worktree; without this the
        // failed worktree+branch only lingers until the next session-start
        // reconcile, so a flapping isolated_write task would accumulate orphan
        // worktrees across retries in a long unattended run.
        if (rec.config.workspaceMode === 'isolated_write') {
          await this._worktreeCoordinator?.discard(taskId).catch(() => undefined)
        }
        await this.spawnSubAgent({ config: { ...rec.config, retryCount: attempt + 1 } })
      })().catch(() => {
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

  private async _handleCompleted(e: SubAgentCompletedEvent): Promise<void> {
    let worktreeSuffix = ''
    const record = await readTask(e.taskId).catch(() => null)
    if (record?.config.workspaceMode === 'isolated_write') {
      try {
        const finalized = await this._worktreeCoordinator?.finalize(e.taskId)
        worktreeSuffix = finalized
          ? ` | worktree: ${finalized.status}` +
            (finalized.commitHash ? ` ${finalized.commitHash.slice(0, 12)}` : '') +
            '，等待 auto_merge_subagent'
          : ' | worktree finalize unavailable'
      } catch (err) {
        worktreeSuffix =
          ` | ⚠ worktree finalize 失败：${err instanceof Error ? err.message : String(err)}`
      }
    }

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
      `${e.result.turnsUsed} 轮 / $${e.result.costUsd.toFixed(4)}${progressSuffix}${worktreeSuffix} | ` +
      `摘要: ${e.result.summary.slice(0, 300)}${e.result.summary.length > 300 ? '…' : ''}`,
    )
  }

  private async _reconcileWorktreeTaskOutcomes(
    coordinator: import('../core/auto/AutoWorktreeCoordinator.js').AutoWorktreeCoordinator,
  ): Promise<void> {
    const tasks = await listTasksForSession(this.parentSessionId).catch(() => [])
    const byId = new Map(tasks.map(task => [task.taskId, task]))
    for (const taskId of coordinator.activeTasks()) {
      const worktree = coordinator.recordFor(taskId)
      if (!worktree) continue
      const task = byId.get(taskId)
      if (task?.status === 'completed') {
        await coordinator.finalize(taskId).catch(() => undefined)
      } else if (
        task?.status === 'failed' ||
        task?.status === 'cancelled' ||
        (
          task &&
          (task.status === 'pending' || task.status === 'queued' || task.status === 'running') &&
          task.createdAt < this.constructedAtMs
        )
      ) {
        await coordinator.markFailed(
          taskId,
          task.result?.error ?? 'Process terminated before task completion',
        ).catch(() => undefined)
      }

      const current = coordinator.recordFor(taskId)
      if (current?.phase === 'awaiting_merge') {
        this._enqueueNotification(
          `[${taskId}] worktree 已恢复并等待 auto_merge_subagent：${current.branchName}`,
        )
      } else if (current?.phase === 'conflicted' || current?.phase === 'failed') {
        this._enqueueNotification(
          `[${taskId}] worktree ${current.phase}：${current.error ?? current.branchName}`,
        )
      }
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
    const maxAgeMs = Math.max((maxDurationMs ?? DEFAULT_SUB_AGENT_MAX_DURATION_MS) * 4, intervalMs * 4)
    const timer = setInterval(async () => {
      const record = await readTask(taskId)
      if (!record) {
        this._clearPollTimer(taskId)
        return
      }
      if (TERMINAL_STATUSES.has(record.status)) {
        let resultLine: string
        if (record.result?.success) {
          if (record.config.workspaceMode === 'isolated_write') {
            await this._worktreeCoordinator?.finalize(taskId).catch(() => undefined)
          }
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
    return readFloatEnv(name, { min: 0 })
  }

  private _reserveBudget(taskId: SubAgentTaskId, amountUsd: number): void {
    if (amountUsd <= 0) return
    this.reservedBudgetByTask.set(taskId, amountUsd)
    this.reservedBudgetUsd += amountUsd
  }

  private _settleBudget(taskId: SubAgentTaskId, actualCostUsd: number | undefined): void {
    const internal = this.internalTaskIds.delete(taskId)
    if (!internal) {
      const reserved = this.reservedBudgetByTask.get(taskId) ?? 0
      if (reserved > 0) {
        this.reservedBudgetUsd = Math.max(0, this.reservedBudgetUsd - reserved)
        this.reservedBudgetByTask.delete(taskId)
      }
      if (actualCostUsd !== undefined && Number.isFinite(actualCostUsd) && actualCostUsd > 0) {
        this.settledCostUsd += actualCostUsd
      }
    }
    this.costLedger?.settleTask(taskId, actualCostUsd)
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
          queued.onRuntimeEvent,
        )
        this.queuedStarts.delete(taskId)
        this.runners.set(taskId, runner)
        this.activeTaskIds.add(taskId)
        await this._worktreeCoordinator?.markRunning(taskId).catch(() => undefined)

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

// The D-SubAgent prompt section builder (buildSubAgentNotificationSection) was
// moved to ./notificationSection.ts — it is a prompt concern, not a scheduler
// one. subagent/index.ts re-exports it from there, so importers are unchanged.

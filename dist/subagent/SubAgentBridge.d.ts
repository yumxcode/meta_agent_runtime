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
import { type SubAgentConfig, type SubAgentRecord, type SubAgentTaskId } from './types.js';
import type { ISubAgentDispatcher } from './ISubAgentDispatcher.js';
import type { MetaAgentTool } from '../core/types.js';
export interface SpawnSubAgentOptions {
    /**
     * Optional caller-provided task ID. Used when resources such as git worktrees
     * must be allocated before the task record is enqueued.
     */
    taskId?: SubAgentTaskId;
    /**
     * Partial config — merged with DEFAULT_SUB_AGENT_CONFIG.
     * taskDescription is required.
     */
    config: Partial<SubAgentConfig> & Pick<SubAgentConfig, 'taskDescription'>;
    /**
     * AbortSignal from the current tool-call context.  When the parent session
     * is interrupted mid-turn, sub-agents spawned in that turn are cancelled.
     */
    abortSignal?: AbortSignal;
}
export interface SubAgentBridgeOptions {
    /** Maximum number of sub-agent sessions running at once. */
    maxConcurrentSubAgents?: number;
    /** Maximum number of sub-agent sessions waiting for a scheduler slot. */
    maxQueuedSubAgents?: number;
    /** Maximum aggregate budget for sub-agents owned by this bridge. */
    maxTotalSubAgentBudgetUsd?: number;
    /** Minimum delay between starting queued sub-agents. */
    startDelayMs?: number;
}
export interface SubAgentSchedulerStats {
    /** Tasks waiting in the queue (not yet started). */
    queued: number;
    /** Tasks currently running. */
    running: number;
    /**
     * Tasks that reached a terminal state (success or failure) since this bridge
     * was created.  Named "finished" rather than "completed" to avoid implying
     * all of these succeeded — both successful and failed tasks are counted.
     */
    finishedThisSession: number;
    /**
     * How long the oldest queued task has been waiting, in milliseconds.
     * 0 when there are no queued tasks.
     */
    oldestQueuedMs: number;
    /** IDs of all currently running tasks. */
    activeTaskIds: string[];
    /** Maximum number of concurrently running tasks this bridge allows. */
    maxConcurrent: number;
}
export declare class SubAgentBridge implements ISubAgentDispatcher {
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
    private static readonly _bridgesBySessionId;
    /**
     * Retrieve an existing bridge for a session (for use in test teardown or
     * emergency cleanup when the original bridge reference is lost).
     */
    static getBridge(sessionId: string): SubAgentBridge | undefined;
    /** Destroy all bridges — use only in process-exit cleanup handlers. */
    static destroyAll(): void;
    private readonly parentSessionId;
    /**
     * Tool registry for sub-agents — set via setToolRegistry() after the main
     * session has registered all tools.  Sub-agents can only use tools listed
     * in their config.allowedTools that are also present in this registry.
     */
    private toolRegistry;
    /**
     * Pending notifications keyed by parentSessionId.
     * drainNotifications() atomically reads + clears this array.
     */
    private readonly pendingNotifications;
    /** Poll timers for non-event-driven tasks. */
    private readonly pollTimers;
    /** Active runners — kept for cancel() calls. */
    private readonly runners;
    private readonly queuedStarts;
    private readonly startQueue;
    private readonly activeTaskIds;
    private readonly parentAbortCleanups;
    private readonly maxConcurrentSubAgents;
    private readonly maxQueuedSubAgents;
    private readonly maxTotalSubAgentBudgetUsd;
    private readonly startDelayMs;
    private readonly constructedAtMs;
    private reservedBudgetUsd;
    private settledCostUsd;
    private readonly reservedBudgetByTask;
    private drainingStarts;
    private destroyed;
    /** Count of tasks that reached a terminal state (success or failure) since this bridge was created. */
    private _finishedCount;
    /** Bound listeners — kept so we can off() them in destroy(). */
    private readonly _onCompleted;
    private readonly _onFailed;
    constructor(parentSessionId: string, options?: SubAgentBridgeOptions);
    /**
     * Update the tool registry used when spawning sub-agents.
     * Call this whenever the main session registers new tools.
     */
    setToolRegistry(registry: Map<string, MetaAgentTool>): void;
    /**
     * Clean up all listeners, timers, and in-flight runners.
     * Call when the parent session ends.
     *
     * P1-8: Aborts every active SubAgentRunner so their internal sessions
     * are interrupted and no orphaned async work continues after the parent ends.
     */
    destroy(): void;
    /**
     * Spawn a new sub-agent task. Returns the queued task record immediately;
     * the scheduler starts it asynchronously when capacity is available.
     */
    spawnSubAgent(opts: SpawnSubAgentOptions): Promise<SubAgentRecord>;
    /**
     * Read the current status of a sub-agent task.
     * Returns null when the taskId is unknown.
     */
    getStatus(taskId: SubAgentTaskId): Promise<SubAgentRecord | null>;
    /**
     * Read the latest checkpoint of a running sub-agent.
     * This is the "explicit intermediate fetch" path — only called when the
     * main agent actively requests intermediate state.
     */
    getIntermediate(taskId: SubAgentTaskId): Promise<{
        taskId: SubAgentTaskId;
        status: string;
        latestCheckpoint?: string;
        latestCheckpointAt?: number;
        turnsUsed?: number;
    } | null>;
    /**
     * Cancel a running sub-agent task.
     */
    cancelTask(taskId: SubAgentTaskId, reason?: string): Promise<boolean>;
    /**
     * Cancel ALL running sub-agent tasks spawned by this bridge.
     * Called by RoboticsSession.dispose() on graceful shutdown.
     */
    cancelAll(reason?: string): Promise<void>;
    /**
     * List all tasks spawned by this bridge's parent session.
     */
    listTasks(): Promise<SubAgentRecord[]>;
    /**
     * Atomically read and clear pending notifications.
     * Called by the D-SubAgent dynamic prompt section on every submit().
     * Returns empty array when there are no pending notifications.
     */
    drainNotifications(): string[];
    /**
     * Check if there are pending notifications without clearing them.
     */
    hasPendingNotifications(): boolean;
    /**
     * Return a snapshot of the scheduler's current state.
     * Safe to call at any time — reads in-memory counters only.
     *
     * Use this for diagnostics, CLI status display, and the D-SubAgent prompt
     * section (to warn the AI when tasks have been queued for a long time).
     */
    getSchedulerStats(): SubAgentSchedulerStats;
    private _enqueueNotification;
    private _startPollTimer;
    private _clearPollTimer;
    private _scheduleDrain;
    private _envBudgetUsd;
    private _reserveBudget;
    private _settleBudget;
    private _clearParentAbortForwarder;
    private _failStaleActiveTasks;
    private _drainStartQueue;
}
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
export declare function buildSubAgentNotificationSection(bridge: SubAgentBridge): string;
//# sourceMappingURL=SubAgentBridge.d.ts.map
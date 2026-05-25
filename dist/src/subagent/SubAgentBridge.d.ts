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
    /** Bound listeners — kept so we can off() them in destroy(). */
    private readonly _onCompleted;
    private readonly _onFailed;
    constructor(parentSessionId: string);
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
     * Spawn a new sub-agent task.  Returns the task record immediately —
     * the runner executes asynchronously.
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
    private _enqueueNotification;
    private _startPollTimer;
    private _clearPollTimer;
}
/**
 * Build the D-SubAgent dynamic system prompt section.
 *
 * Called by MetaAgentSession / dynamicPrompt.ts before each submit() turn.
 * Returns empty string when there are no pending notifications.
 *
 * The section is injected as a volatile section (rebuilt every turn) because
 * notifications arrive asynchronously and must not be cached.
 */
export declare function buildSubAgentNotificationSection(bridge: SubAgentBridge): string;
//# sourceMappingURL=SubAgentBridge.d.ts.map
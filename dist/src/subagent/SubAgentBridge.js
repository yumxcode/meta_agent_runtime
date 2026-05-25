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
import { readTask, writeTask, listTasksForSession } from './SubAgentTaskStore.js';
import { SubAgentRunner } from './SubAgentRunner.js';
import { CampaignEventBus } from './CampaignEventBus.js';
import { makeSubAgentTaskId, DEFAULT_SUB_AGENT_CONFIG, TERMINAL_STATUSES, } from './types.js';
// ─────────────────────────────────────────────────────────────────────────────
// SubAgentBridge
// ─────────────────────────────────────────────────────────────────────────────
export class SubAgentBridge {
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
    static _bridgesBySessionId = new Map();
    /**
     * Retrieve an existing bridge for a session (for use in test teardown or
     * emergency cleanup when the original bridge reference is lost).
     */
    static getBridge(sessionId) {
        return SubAgentBridge._bridgesBySessionId.get(sessionId);
    }
    /** Destroy all bridges — use only in process-exit cleanup handlers. */
    static destroyAll() {
        for (const bridge of SubAgentBridge._bridgesBySessionId.values()) {
            try {
                bridge.destroy();
            }
            catch { /* best-effort */ }
        }
    }
    parentSessionId;
    /**
     * Tool registry for sub-agents — set via setToolRegistry() after the main
     * session has registered all tools.  Sub-agents can only use tools listed
     * in their config.allowedTools that are also present in this registry.
     */
    toolRegistry = new Map();
    /**
     * Pending notifications keyed by parentSessionId.
     * drainNotifications() atomically reads + clears this array.
     */
    pendingNotifications = [];
    /** Poll timers for non-event-driven tasks. */
    pollTimers = new Map();
    /** Active runners — kept for cancel() calls. */
    runners = new Map();
    /** Bound listeners — kept so we can off() them in destroy(). */
    _onCompleted;
    _onFailed;
    constructor(parentSessionId) {
        // P1-8: Prevent duplicate bridges (and thus duplicate event listeners)
        // for the same session.  Callers must destroy() the previous bridge first.
        if (SubAgentBridge._bridgesBySessionId.has(parentSessionId)) {
            throw new Error(`[SubAgentBridge] A bridge for session "${parentSessionId}" already exists. ` +
                `Call destroy() on the existing bridge before creating a new one.`);
        }
        SubAgentBridge._bridgesBySessionId.set(parentSessionId, this);
        this.parentSessionId = parentSessionId;
        this._onCompleted = (e) => {
            if (e.parentSessionId !== this.parentSessionId)
                return;
            const ps = e.result.progressState;
            const progressSuffix = ps
                ? ` | 工具调用: ${ps.toolCallsCompleted}` +
                    (ps.stepsCompleted > 0 ? ` 步: ${ps.stepsCompleted}` : '') +
                    (ps.provenanceIds.length > 0
                        ? ` | provenance: ${ps.provenanceIds.slice(0, 5).join(', ')}${ps.provenanceIds.length > 5 ? ` (+${ps.provenanceIds.length - 5})` : ''}`
                        : '')
                : '';
            this._enqueueNotification(`[${e.taskId}] ✓ 已完成 | ` +
                `${e.result.turnsUsed} 轮 / $${e.result.costUsd.toFixed(4)}${progressSuffix} | ` +
                `摘要: ${e.result.summary.slice(0, 300)}${e.result.summary.length > 300 ? '…' : ''}`);
            this._clearPollTimer(e.taskId);
        };
        this._onFailed = (e) => {
            if (e.parentSessionId !== this.parentSessionId)
                return;
            this._enqueueNotification(`[${e.taskId}] ✗ 失败 | 原因: ${e.error.slice(0, 200)}`);
            this._clearPollTimer(e.taskId);
        };
        CampaignEventBus.on('subagent:completed', this._onCompleted);
        CampaignEventBus.on('subagent:failed', this._onFailed);
    }
    // ── Lifecycle ───────────────────────────────────────────────────────────────
    /**
     * Update the tool registry used when spawning sub-agents.
     * Call this whenever the main session registers new tools.
     */
    setToolRegistry(registry) {
        this.toolRegistry = registry;
    }
    /**
     * Clean up all listeners, timers, and in-flight runners.
     * Call when the parent session ends.
     *
     * P1-8: Aborts every active SubAgentRunner so their internal sessions
     * are interrupted and no orphaned async work continues after the parent ends.
     */
    destroy() {
        CampaignEventBus.off('subagent:completed', this._onCompleted);
        CampaignEventBus.off('subagent:failed', this._onFailed);
        for (const [taskId] of this.pollTimers)
            this._clearPollTimer(taskId);
        // Abort all in-flight runners
        for (const runner of this.runners.values()) {
            runner.abort();
        }
        this.runners.clear();
        SubAgentBridge._bridgesBySessionId.delete(this.parentSessionId);
    }
    // ── Spawn ───────────────────────────────────────────────────────────────────
    /**
     * Spawn a new sub-agent task.  Returns the task record immediately —
     * the runner executes asynchronously.
     */
    async spawnSubAgent(opts) {
        const config = {
            ...DEFAULT_SUB_AGENT_CONFIG,
            ...opts.config,
        };
        const taskId = makeSubAgentTaskId();
        const record = {
            schemaVersion: '1.0',
            taskId,
            parentSessionId: this.parentSessionId,
            status: 'pending',
            config,
            createdAt: Date.now(),
            pendingHumanApproval: false,
        };
        await writeTask(record);
        const abortController = new AbortController();
        // If parent is aborted, cancel this sub-agent
        opts.abortSignal?.addEventListener('abort', () => abortController.abort());
        const runner = new SubAgentRunner(record, this.toolRegistry, abortController.signal);
        this.runners.set(taskId, runner);
        // Start poll timer if not event-driven
        if (!config.useEventDriven) {
            this._startPollTimer(taskId, config.pollIntervalMs);
        }
        runner.start();
        return record;
    }
    // ── Status queries ──────────────────────────────────────────────────────────
    /**
     * Read the current status of a sub-agent task.
     * Returns null when the taskId is unknown.
     */
    async getStatus(taskId) {
        return readTask(taskId);
    }
    /**
     * Read the latest checkpoint of a running sub-agent.
     * This is the "explicit intermediate fetch" path — only called when the
     * main agent actively requests intermediate state.
     */
    async getIntermediate(taskId) {
        const record = await readTask(taskId);
        if (!record)
            return null;
        return {
            taskId: record.taskId,
            status: record.status,
            latestCheckpoint: record.latestCheckpoint,
            latestCheckpointAt: record.latestCheckpointAt,
        };
    }
    /**
     * Cancel a running sub-agent task.
     */
    async cancelTask(taskId, reason) {
        const record = await readTask(taskId);
        if (!record)
            return false;
        if (TERMINAL_STATUSES.has(record.status))
            return false;
        const runner = this.runners.get(taskId);
        if (runner) {
            // Abort the runner's internal AbortController so the MetaAgentSession
            // receives an interrupt signal.  We also write the cancelled record
            // immediately (below) so the task appears cancelled right away rather
            // than waiting for the runner to observe the abort signal.
            // SubAgentRunner._writeTerminal() guards against overwriting a
            // cancelled record, so there is no race condition.
            runner.abort();
            // Keep the runner in the map until it fully stops — the runner will
            // reach its own terminal state (aborted → no further writes) and the
            // map entry will be cleaned up at destroy() time.
        }
        // Write cancelled status immediately
        const updated = {
            ...record,
            status: 'cancelled',
            completedAt: Date.now(),
            result: {
                success: false,
                summary: reason ? `Cancelled: ${reason}` : 'Cancelled by parent agent',
                error: 'cancelled',
                turnsUsed: 0,
                inputTokens: 0,
                outputTokens: 0,
                costUsd: 0,
                durationMs: Date.now() - (record.startedAt ?? record.createdAt),
            },
            pendingHumanApproval: false,
        };
        await writeTask(updated);
        CampaignEventBus.emit('subagent:failed', {
            taskId,
            parentSessionId: this.parentSessionId,
            error: 'cancelled',
        });
        this._clearPollTimer(taskId);
        this.runners.delete(taskId);
        return true;
    }
    /**
     * Cancel ALL running sub-agent tasks spawned by this bridge.
     * Called by RoboticsSession.dispose() on graceful shutdown.
     */
    async cancelAll(reason = 'Session disposed') {
        const ids = [...this.runners.keys()];
        await Promise.allSettled(ids.map(id => this.cancelTask(id, reason)));
    }
    /**
     * List all tasks spawned by this bridge's parent session.
     */
    async listTasks() {
        return listTasksForSession(this.parentSessionId);
    }
    // ── Notification queue ──────────────────────────────────────────────────────
    /**
     * Atomically read and clear pending notifications.
     * Called by the D-SubAgent dynamic prompt section on every submit().
     * Returns empty array when there are no pending notifications.
     */
    drainNotifications() {
        if (this.pendingNotifications.length === 0)
            return [];
        return this.pendingNotifications.splice(0);
    }
    /**
     * Check if there are pending notifications without clearing them.
     */
    hasPendingNotifications() {
        return this.pendingNotifications.length > 0;
    }
    // ── Internal helpers ────────────────────────────────────────────────────────
    _enqueueNotification(text) {
        this.pendingNotifications.push(text);
    }
    _startPollTimer(taskId, intervalMs) {
        const timer = setInterval(async () => {
            const record = await readTask(taskId);
            if (!record) {
                this._clearPollTimer(taskId);
                return;
            }
            if (TERMINAL_STATUSES.has(record.status)) {
                let resultLine;
                if (record.result?.success) {
                    const ps = record.result.progressState;
                    const progressSuffix = ps
                        ? ` | 工具调用: ${ps.toolCallsCompleted}` +
                            (ps.stepsCompleted > 0 ? ` 步: ${ps.stepsCompleted}` : '') +
                            (ps.provenanceIds.length > 0
                                ? ` | provenance: ${ps.provenanceIds.slice(0, 5).join(', ')}${ps.provenanceIds.length > 5 ? ` (+${ps.provenanceIds.length - 5})` : ''}`
                                : '')
                        : '';
                    resultLine =
                        `✓ 已完成 | ${record.result.turnsUsed} 轮 / $${record.result.costUsd.toFixed(4)}${progressSuffix} | ` +
                            `摘要: ${record.result.summary.slice(0, 300)}`;
                }
                else {
                    resultLine = `✗ 失败 | ${record.result?.error ?? 'unknown'}`;
                }
                this._enqueueNotification(`[${taskId}] ${resultLine}`);
                this._clearPollTimer(taskId);
            }
        }, intervalMs);
        this.pollTimers.set(taskId, timer);
    }
    _clearPollTimer(taskId) {
        const timer = this.pollTimers.get(taskId);
        if (timer !== undefined) {
            clearInterval(timer);
            this.pollTimers.delete(taskId);
        }
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Dynamic prompt section builder
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Build the D-SubAgent dynamic system prompt section.
 *
 * Called by MetaAgentSession / dynamicPrompt.ts before each submit() turn.
 * Returns empty string when there are no pending notifications.
 *
 * The section is injected as a volatile section (rebuilt every turn) because
 * notifications arrive asynchronously and must not be cached.
 */
export function buildSubAgentNotificationSection(bridge) {
    const notifications = bridge.drainNotifications();
    if (notifications.length === 0)
        return '';
    const lines = [
        '## Sub-Agent Notifications (pending)',
        ...notifications.map(n => `- ${n}`),
        '',
        '> These sub-tasks just reached terminal state. ' +
            'Use `get_sub_agent_status` to retrieve full results. ' +
            'If `pending_human_approval` is true, you MUST present the result to the user before proceeding.',
    ];
    return lines.join('\n');
}
//# sourceMappingURL=SubAgentBridge.js.map
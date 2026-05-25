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
import { readTask, writeTask, releaseWriteChain, listTasksForSession } from './SubAgentTaskStore.js';
import { SubAgentRunner } from './SubAgentRunner.js';
import { CampaignEventBus } from './CampaignEventBus.js';
import { makeSubAgentTaskId, DEFAULT_SUB_AGENT_CONFIG, TERMINAL_STATUSES, } from './types.js';
const DEFAULT_MAX_CONCURRENT_SUB_AGENTS = 4;
const DEFAULT_MAX_QUEUED_SUB_AGENTS = 64;
const DEFAULT_SUB_AGENT_START_DELAY_MS = 250;
const MAX_PENDING_NOTIFICATIONS = 100;
function envInt(name, fallback, min, max) {
    const raw = process.env[name];
    if (raw === undefined)
        return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.min(max, Math.max(min, parsed));
}
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
    queuedStarts = new Map();
    startQueue = [];
    activeTaskIds = new Set();
    parentAbortCleanups = new Map();
    maxConcurrentSubAgents;
    maxQueuedSubAgents;
    maxTotalSubAgentBudgetUsd;
    startDelayMs;
    constructedAtMs = Date.now();
    reservedBudgetUsd = 0;
    settledCostUsd = 0;
    reservedBudgetByTask = new Map();
    drainingStarts = false;
    destroyed = false;
    /** Count of tasks that reached a terminal state (success or failure) since this bridge was created. */
    _finishedCount = 0;
    /** Bound listeners — kept so we can off() them in destroy(). */
    _onCompleted;
    _onFailed;
    constructor(parentSessionId, options = {}) {
        // P1-8: Prevent duplicate bridges (and thus duplicate event listeners)
        // for the same session.  Callers must destroy() the previous bridge first.
        if (SubAgentBridge._bridgesBySessionId.has(parentSessionId)) {
            throw new Error(`[SubAgentBridge] A bridge for session "${parentSessionId}" already exists. ` +
                `Call destroy() on the existing bridge before creating a new one.`);
        }
        SubAgentBridge._bridgesBySessionId.set(parentSessionId, this);
        this.parentSessionId = parentSessionId;
        this.maxConcurrentSubAgents = Math.max(1, options.maxConcurrentSubAgents ??
            envInt('META_AGENT_MAX_CONCURRENT_SUB_AGENTS', DEFAULT_MAX_CONCURRENT_SUB_AGENTS, 1, 64));
        this.maxQueuedSubAgents = Math.max(0, options.maxQueuedSubAgents ??
            envInt('META_AGENT_MAX_QUEUED_SUB_AGENTS', DEFAULT_MAX_QUEUED_SUB_AGENTS, 0, 10_000));
        this.maxTotalSubAgentBudgetUsd = options.maxTotalSubAgentBudgetUsd ??
            this._envBudgetUsd('META_AGENT_MAX_TOTAL_SUB_AGENT_BUDGET_USD');
        this.startDelayMs = Math.max(0, options.startDelayMs ??
            envInt('META_AGENT_SUB_AGENT_START_DELAY_MS', DEFAULT_SUB_AGENT_START_DELAY_MS, 0, 60_000));
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
        void this._failStaleActiveTasks();
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
        this.destroyed = true;
        CampaignEventBus.off('subagent:completed', this._onCompleted);
        CampaignEventBus.off('subagent:failed', this._onFailed);
        for (const [taskId] of this.pollTimers)
            this._clearPollTimer(taskId);
        for (const [taskId, queued] of this.queuedStarts) {
            queued.abortController.abort();
            this._settleBudget(taskId, 0);
            this._clearParentAbortForwarder(taskId);
        }
        this.queuedStarts.clear();
        this.startQueue.length = 0;
        // Abort all in-flight runners
        for (const [taskId, runner] of this.runners) {
            runner.abort();
            this._clearParentAbortForwarder(taskId);
        }
        this.runners.clear();
        this.activeTaskIds.clear();
        SubAgentBridge._bridgesBySessionId.delete(this.parentSessionId);
    }
    // ── Spawn ───────────────────────────────────────────────────────────────────
    /**
     * Spawn a new sub-agent task. Returns the queued task record immediately;
     * the scheduler starts it asynchronously when capacity is available.
     */
    async spawnSubAgent(opts) {
        const config = {
            ...DEFAULT_SUB_AGENT_CONFIG,
            ...opts.config,
        };
        const outstandingTasks = this.activeTaskIds.size + this.queuedStarts.size;
        const maxOutstandingTasks = this.maxConcurrentSubAgents + this.maxQueuedSubAgents;
        if (outstandingTasks >= maxOutstandingTasks) {
            throw new Error(`[SubAgentBridge] Sub-agent queue is full ` +
                `(${outstandingTasks}/${maxOutstandingTasks} outstanding; ` +
                `${this.maxConcurrentSubAgents} running slots, ${this.maxQueuedSubAgents} queued slots). ` +
                'Wait for queued tasks to start or raise META_AGENT_MAX_QUEUED_SUB_AGENTS.');
        }
        const requestedBudget = Math.max(0, config.maxBudgetUsd);
        if (this.maxTotalSubAgentBudgetUsd !== undefined &&
            this.settledCostUsd + this.reservedBudgetUsd + requestedBudget > this.maxTotalSubAgentBudgetUsd) {
            throw new Error(`[SubAgentBridge] Sub-agent budget exceeded. ` +
                `Requested $${requestedBudget.toFixed(4)}, ` +
                `reserved $${this.reservedBudgetUsd.toFixed(4)}, ` +
                `settled $${this.settledCostUsd.toFixed(4)}, ` +
                `limit $${this.maxTotalSubAgentBudgetUsd.toFixed(4)}.`);
        }
        const taskId = opts.taskId ?? makeSubAgentTaskId();
        const record = {
            schemaVersion: '1.0',
            taskId,
            parentSessionId: this.parentSessionId,
            status: 'queued',
            config,
            createdAt: Date.now(),
            pendingHumanApproval: false,
        };
        await writeTask(record);
        this._reserveBudget(taskId, requestedBudget);
        const abortController = new AbortController();
        // If parent is aborted, cancel this sub-agent
        if (opts.abortSignal) {
            const forwardAbort = () => abortController.abort();
            opts.abortSignal.addEventListener('abort', forwardAbort, { once: true });
            this.parentAbortCleanups.set(taskId, () => {
                opts.abortSignal?.removeEventListener('abort', forwardAbort);
            });
        }
        // Start poll timer if not event-driven
        if (!config.useEventDriven) {
            this._startPollTimer(taskId, config.pollIntervalMs);
        }
        this.queuedStarts.set(taskId, { record, abortController });
        this.startQueue.push(taskId);
        this._scheduleDrain();
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
        const queued = this.queuedStarts.get(taskId);
        if (queued) {
            queued.abortController.abort();
            this.queuedStarts.delete(taskId);
            const idx = this.startQueue.indexOf(taskId);
            if (idx >= 0)
                this.startQueue.splice(idx, 1);
        }
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
        await releaseWriteChain(taskId);
        this._settleBudget(taskId, updated.result?.costUsd);
        CampaignEventBus.emit('subagent:failed', {
            taskId,
            parentSessionId: this.parentSessionId,
            error: 'cancelled',
        });
        this._clearPollTimer(taskId);
        this.runners.delete(taskId);
        this.activeTaskIds.delete(taskId);
        this._clearParentAbortForwarder(taskId);
        return true;
    }
    /**
     * Cancel ALL running sub-agent tasks spawned by this bridge.
     * Called by RoboticsSession.dispose() on graceful shutdown.
     */
    async cancelAll(reason = 'Session disposed') {
        const ids = [...new Set([...this.startQueue, ...this.queuedStarts.keys(), ...this.runners.keys()])];
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
    /**
     * Return a snapshot of the scheduler's current state.
     * Safe to call at any time — reads in-memory counters only.
     *
     * Use this for diagnostics, CLI status display, and the D-SubAgent prompt
     * section (to warn the AI when tasks have been queued for a long time).
     */
    getSchedulerStats() {
        const now = Date.now();
        let oldestQueuedMs = 0;
        for (const { record } of this.queuedStarts.values()) {
            const age = now - record.createdAt;
            if (age > oldestQueuedMs)
                oldestQueuedMs = age;
        }
        return {
            queued: this.queuedStarts.size,
            running: this.activeTaskIds.size,
            finishedThisSession: this._finishedCount,
            oldestQueuedMs,
            activeTaskIds: [...this.activeTaskIds],
            maxConcurrent: this.maxConcurrentSubAgents,
        };
    }
    // ── Internal helpers ────────────────────────────────────────────────────────
    _enqueueNotification(text) {
        this.pendingNotifications.push(text);
        if (this.pendingNotifications.length > MAX_PENDING_NOTIFICATIONS) {
            this.pendingNotifications.splice(0, this.pendingNotifications.length - MAX_PENDING_NOTIFICATIONS);
        }
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
        if (timer.unref)
            timer.unref();
        this.pollTimers.set(taskId, timer);
    }
    _clearPollTimer(taskId) {
        const timer = this.pollTimers.get(taskId);
        if (timer !== undefined) {
            clearInterval(timer);
            this.pollTimers.delete(taskId);
        }
    }
    _scheduleDrain() {
        if (this.drainingStarts || this.destroyed)
            return;
        this.drainingStarts = true;
        void this._drainStartQueue();
    }
    _envBudgetUsd(name) {
        const raw = process.env[name];
        if (raw === undefined || raw.trim() === '')
            return undefined;
        const parsed = Number.parseFloat(raw);
        if (!Number.isFinite(parsed) || parsed < 0)
            return undefined;
        return parsed;
    }
    _reserveBudget(taskId, amountUsd) {
        if (amountUsd <= 0)
            return;
        this.reservedBudgetByTask.set(taskId, amountUsd);
        this.reservedBudgetUsd += amountUsd;
    }
    _settleBudget(taskId, actualCostUsd) {
        const reserved = this.reservedBudgetByTask.get(taskId) ?? 0;
        if (reserved > 0) {
            this.reservedBudgetUsd = Math.max(0, this.reservedBudgetUsd - reserved);
            this.reservedBudgetByTask.delete(taskId);
        }
        if (actualCostUsd !== undefined && Number.isFinite(actualCostUsd) && actualCostUsd > 0) {
            this.settledCostUsd += actualCostUsd;
        }
    }
    _clearParentAbortForwarder(taskId) {
        const cleanup = this.parentAbortCleanups.get(taskId);
        if (!cleanup)
            return;
        cleanup();
        this.parentAbortCleanups.delete(taskId);
    }
    async _failStaleActiveTasks() {
        const records = await listTasksForSession(this.parentSessionId);
        await Promise.allSettled(records
            .filter(record => (record.status === 'pending' || record.status === 'queued' || record.status === 'running') &&
            record.createdAt < this.constructedAtMs)
            .map(async (record) => {
            const completedAt = Date.now();
            const summary = record.status === 'queued' || record.status === 'pending'
                ? 'Process terminated before sub-agent task started'
                : 'Process terminated before sub-agent task completed';
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
            });
            await releaseWriteChain(record.taskId);
        }));
    }
    async _drainStartQueue() {
        try {
            while (!this.destroyed &&
                this.activeTaskIds.size < this.maxConcurrentSubAgents &&
                this.startQueue.length > 0) {
                const taskId = this.startQueue.shift();
                const queued = this.queuedStarts.get(taskId);
                if (!queued)
                    continue;
                if (queued.abortController.signal.aborted) {
                    await this.cancelTask(taskId, 'cancelled before start').catch(() => undefined);
                    continue;
                }
                const diskRecord = await readTask(taskId);
                if (!diskRecord || TERMINAL_STATUSES.has(diskRecord.status)) {
                    this.queuedStarts.delete(taskId);
                    this._clearParentAbortForwarder(taskId);
                    continue;
                }
                const runner = new SubAgentRunner(queued.record, this.toolRegistry, queued.abortController.signal);
                this.queuedStarts.delete(taskId);
                this.runners.set(taskId, runner);
                this.activeTaskIds.add(taskId);
                void runner.start()
                    .catch(() => undefined)
                    .finally(async () => {
                    const finalRecord = await readTask(taskId).catch(() => null);
                    this._settleBudget(taskId, finalRecord?.result?.costUsd);
                    this.runners.delete(taskId);
                    this.activeTaskIds.delete(taskId);
                    this._clearParentAbortForwarder(taskId);
                    this._finishedCount++;
                    this._scheduleDrain();
                });
                if (this.startDelayMs > 0 && this.startQueue.length > 0) {
                    await new Promise(resolve => setTimeout(resolve, this.startDelayMs));
                }
            }
        }
        finally {
            this.drainingStarts = false;
            if (!this.destroyed &&
                this.activeTaskIds.size < this.maxConcurrentSubAgents &&
                this.startQueue.length > 0) {
                this._scheduleDrain();
            }
        }
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
const STALE_QUEUE_WARN_MS = 30_000;
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
export function buildSubAgentNotificationSection(bridge) {
    const notifications = bridge.drainNotifications();
    const stats = bridge.getSchedulerStats();
    const lines = [];
    // ── #12 Queue status warning ──────────────────────────────────────────────
    // Show whenever there are queued or running tasks, but upgrade the warning
    // to a prominent caution block when queued tasks have been waiting a while.
    if (stats.queued > 0 || stats.running > 0) {
        const oldestSec = Math.round(stats.oldestQueuedMs / 1_000);
        if (stats.queued > 0 && stats.oldestQueuedMs >= STALE_QUEUE_WARN_MS) {
            lines.push('## Sub-Agent Queue Status ⚠');
            lines.push(`- Running: ${stats.running}/${stats.maxConcurrent} | ` +
                `Queued: ${stats.queued} (oldest: ${oldestSec}s)`);
            lines.push('> Queued sub-agents have NOT started yet. ' +
                'Do NOT treat them as running or assume any work has been done. ' +
                'Wait or cancel before dispatching duplicates.');
        }
        else {
            lines.push(`## Sub-Agent Status: ${stats.running} running, ${stats.queued} queued` +
                (stats.queued > 0 && stats.oldestQueuedMs > 0 ? ` (oldest: ${oldestSec}s)` : ''));
        }
        lines.push('');
    }
    // ── Terminal notifications ─────────────────────────────────────────────────
    if (notifications.length > 0) {
        lines.push('## Sub-Agent Notifications (pending)');
        lines.push(...notifications.map(n => `- ${n}`));
        lines.push('');
        lines.push('> These sub-tasks just reached terminal state. ' +
            'Use `get_sub_agent_status` to retrieve full results. ' +
            'If `pending_human_approval` is true, you MUST present the result to the user before proceeding.');
    }
    return lines.join('\n');
}
//# sourceMappingURL=SubAgentBridge.js.map
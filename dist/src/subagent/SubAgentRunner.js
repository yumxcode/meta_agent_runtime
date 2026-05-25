/**
 * SubAgentRunner — isolated sub-agent lifecycle manager
 *
 * Wraps a MetaAgentSession in a fully isolated context:
 *   - Empty conversation history (no inheritance from parent)
 *   - Circuit-breaker enforcement (maxTurns, maxBudgetUsd)
 *   - Periodic checkpoint writes to SubAgentTaskStore
 *   - CampaignEventBus publication on completion / failure
 *
 * The runner is fire-and-forget from the caller's perspective:
 *   const runner = new SubAgentRunner(record, toolRegistry, abortSignal)
 *   runner.start()   // returns void; resolves internally
 *
 * Status progression: pending → running → completed | failed | cancelled
 */
import { MetaAgentSession } from '../core/MetaAgentSession.js';
import { DEFAULT_SUB_AGENT_SYSTEM_PROMPT } from '../core/staticPrompt.js';
import { writeTask, readTask } from './SubAgentTaskStore.js';
import { CampaignEventBus } from './CampaignEventBus.js';
import { TERMINAL_STATUSES, } from './types.js';
// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const SUMMARY_MAX_CHARS = 2_000;
const ERROR_MAX_CHARS = 500;
function truncate(s, max) {
    return s.length <= max ? s : s.slice(0, max - 3) + '...';
}
// ── Progress state extraction ─────────────────────────────────────────────────
/** Regex matching provenance IDs: prov-{8+ hex chars} */
const PROV_ID_RE = /\bprov-[a-f0-9]{8,}\b/g;
/**
 * Regex for numbered-step markers.  Matches common patterns:
 *   "Step 1:", "Step 1 —", "## Step 2", "**Step 3**", "### 4."
 * Counts distinct step numbers to avoid inflating from repeated references.
 */
const STEP_NUMBER_RE = /(?:^|\s)(?:##+ )?(?:\*{0,2})step\s+(\d+)(?:\*{0,2})?(?:[:\s—]|$)/gim;
/**
 * Extract a `SubAgentProgressState` from the accumulated output text.
 *
 * This is best-effort regex analysis — callers must treat the output as an
 * orientation cue only, not as authoritative structured data.
 */
function extractProgressState(text, toolCallsCompleted, lastCheckpoint) {
    // Collect unique provenance IDs
    const provenanceIds = [];
    const seenIds = new Set();
    for (const match of text.matchAll(PROV_ID_RE)) {
        const id = match[0];
        if (!seenIds.has(id)) {
            seenIds.add(id);
            provenanceIds.push(id);
        }
    }
    // Count distinct step numbers (not raw match count — avoids double-counting)
    const stepNums = new Set();
    for (const match of text.matchAll(STEP_NUMBER_RE)) {
        if (match[1])
            stepNums.add(match[1]);
    }
    return {
        toolCallsCompleted,
        provenanceIds,
        stepsCompleted: stepNums.size,
        ...(lastCheckpoint ? { lastCheckpoint } : {}),
    };
}
// ─────────────────────────────────────────────────────────────────────────────
// SubAgentRunner
// ─────────────────────────────────────────────────────────────────────────────
export class SubAgentRunner {
    record;
    toolRegistry;
    abortSignal;
    _abortController;
    session;
    constructor(record, 
    /** All tools available in the runtime — runner filters by config.allowedTools */
    toolRegistry, abortSignal) {
        this.record = { ...record }; // local copy — mutated as status progresses
        this.toolRegistry = toolRegistry;
        this.abortSignal = abortSignal;
        this._abortController = new AbortController();
        // Forward parent abort signal into our internal controller
        abortSignal.addEventListener('abort', () => this._abortController.abort());
    }
    // ── Public API ──────────────────────────────────────────────────────────────
    get taskId() { return this.record.taskId; }
    /**
     * Start the sub-agent.  This is fire-and-forget — it resolves when the
     * sub-agent reaches a terminal state.  Errors are caught and written as
     * `failed` status, never rethrown.
     *
     * P1-1: The outer catch guarantees a terminal TaskStore write even if the
     * inner _run() catch handler itself throws — preventing the task from being
     * permanently stuck in 'running' state.
     */
    start() {
        const startMs = Date.now();
        void this._run().catch(async (err) => {
            // Inner _run() already writes terminal state for expected errors.
            // This outer handler catches unexpected throws from _run()'s own
            // error-handling code (e.g., writeTask() threw inside the catch block).
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`[SubAgentRunner:${this.taskId}] Unhandled error in _run() catch handler:`, err);
            try {
                await this._writeTerminal('failed', {
                    success: false,
                    summary: '',
                    error: truncate(`Internal runner error: ${errMsg}`, ERROR_MAX_CHARS),
                    turnsUsed: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    costUsd: 0,
                    durationMs: Date.now() - startMs,
                });
            }
            catch (writeErr) {
                // Last resort — at least log it; task will remain stale on disk
                console.error(`[SubAgentRunner:${this.taskId}] Failed to write terminal state after crash:`, writeErr);
            }
        });
    }
    /**
     * Abort the sub-agent's internal session.
     * Called by SubAgentBridge.destroy() to cancel in-flight sub-agents when
     * the parent session ends.
     */
    abort() {
        this._abortController.abort();
        this.session?.interrupt();
    }
    // ── Internal execution ──────────────────────────────────────────────────────
    async _run() {
        // Mark as running
        this.record.status = 'running';
        this.record.startedAt = Date.now();
        void writeTask(this.record);
        const cfg = this.record.config;
        const startMs = Date.now();
        let lastText = '';
        let turnsUsed = 0;
        let inputTokens = 0;
        let outputTokens = 0;
        let toolResultCount = 0; // counts completed tool-call rounds (turn proxy)
        // Build the isolated session config.
        // Forward provider credentials from the parent session when explicit —
        // otherwise MetaAgentSession.resolveConfig() picks them up from env vars.
        //
        // systemPrompt: when the caller omits it, default to DEFAULT_SUB_AGENT_SYSTEM_PROMPT
        // (the lean execution-focused identity) rather than falling through to the full
        // S1-S10 static prompt.  Sub-agents have no need for campaign/DOE domain knowledge,
        // V&V protocols, or provenance tooling guidance — those belong to the main agent.
        const sessionConfig = {
            systemPrompt: cfg.systemPrompt ?? DEFAULT_SUB_AGENT_SYSTEM_PROMPT,
            maxTurns: cfg.maxTurns,
            maxBudgetUsd: cfg.maxBudgetUsd,
            tools: this._resolveTools(),
            verbose: false,
            includeStreamEvents: false,
            // Optional credential forwarding — omit when undefined so env-var detection still works
            ...(cfg.apiKey !== undefined && { apiKey: cfg.apiKey }),
            ...(cfg.baseURL !== undefined && { baseURL: cfg.baseURL }),
            ...(cfg.model !== undefined && { model: cfg.model }),
            ...(cfg.fallbackModel !== undefined && { fallbackModel: cfg.fallbackModel }),
        };
        this.session = new MetaAgentSession(sessionConfig);
        try {
            // Abort signal forwarding
            if (this.abortSignal.aborted) {
                await this._writeTerminal('cancelled', {
                    success: false,
                    summary: 'Cancelled before start',
                    error: 'cancelled',
                    turnsUsed: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    costUsd: 0,
                    durationMs: 0,
                });
                return;
            }
            this.abortSignal.addEventListener('abort', () => {
                this.session?.interrupt();
            });
            // Run the agentic loop — consume the generator
            const gen = this.session.submit(cfg.taskDescription);
            for await (const event of gen) {
                // Accumulate text
                if (event.type === 'text') {
                    lastText += event.text;
                }
                // Each tool_result marks the end of one tool-use round.
                // We use this as a turn proxy for checkpoint scheduling.
                if (event.type === 'tool_result') {
                    toolResultCount++;
                    if (cfg.checkpointEveryNTurns > 0 &&
                        toolResultCount % cfg.checkpointEveryNTurns === 0 &&
                        lastText.trim()) {
                        await this._saveCheckpoint(lastText, toolResultCount);
                    }
                }
                // Terminal: final result event from the agentic loop
                if (event.type === 'result') {
                    turnsUsed = event.numTurns;
                    inputTokens = event.usage.inputTokens;
                    outputTokens = event.usage.outputTokens;
                    // Abort may have fired mid-stream — honour it as cancelled
                    if (this.abortSignal.aborted) {
                        await this._writeTerminal('cancelled', {
                            success: false,
                            summary: truncate(lastText, SUMMARY_MAX_CHARS),
                            error: 'cancelled',
                            turnsUsed,
                            inputTokens,
                            outputTokens,
                            costUsd: event.totalCostUsd,
                            durationMs: Date.now() - startMs,
                            progressState: extractProgressState(lastText, toolResultCount, this.record.latestCheckpoint),
                        });
                        return;
                    }
                    const isError = event.subtype !== 'success';
                    const result = {
                        success: !isError,
                        summary: truncate((lastText.trim() || event.result).trim(), SUMMARY_MAX_CHARS),
                        error: isError
                            ? truncate(this._stopReasonToError(event.subtype), ERROR_MAX_CHARS)
                            : undefined,
                        turnsUsed,
                        inputTokens,
                        outputTokens,
                        costUsd: event.totalCostUsd,
                        durationMs: Date.now() - startMs,
                        progressState: extractProgressState(lastText, toolResultCount, this.record.latestCheckpoint),
                    };
                    await this._writeTerminal(isError ? 'failed' : 'completed', result);
                    return;
                }
            }
            // Generator exhausted without a 'result' event — should not happen
            await this._writeTerminal('failed', {
                success: false,
                summary: truncate(lastText, SUMMARY_MAX_CHARS),
                error: 'Session ended without a result event',
                turnsUsed,
                inputTokens,
                outputTokens,
                costUsd: this.session.getEstimatedCost(),
                durationMs: Date.now() - startMs,
                progressState: extractProgressState(lastText, toolResultCount, this.record.latestCheckpoint),
            });
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await this._writeTerminal('failed', {
                success: false,
                summary: truncate(lastText, SUMMARY_MAX_CHARS),
                error: truncate(errMsg, ERROR_MAX_CHARS),
                turnsUsed,
                inputTokens,
                outputTokens,
                costUsd: this.session?.getEstimatedCost() ?? 0,
                durationMs: Date.now() - startMs,
                progressState: extractProgressState(lastText, toolResultCount, this.record.latestCheckpoint),
            });
        }
    }
    // ── Helpers ─────────────────────────────────────────────────────────────────
    _resolveTools() {
        const allowed = this.record.config.allowedTools;
        if (!allowed || allowed.length === 0)
            return [];
        return allowed
            .map(name => this.toolRegistry.get(name))
            .filter((t) => t !== undefined);
    }
    _stopReasonToError(subtype) {
        switch (subtype) {
            case 'error_max_turns': return `Turn limit exceeded (${this.record.config.maxTurns} turns)`;
            case 'error_max_budget': return `Budget exceeded ($${this.record.config.maxBudgetUsd.toFixed(2)} limit)`;
            case 'error_during_execution': return 'Error during execution';
            default: return `Stopped: ${subtype}`;
        }
    }
    /**
     * Write a terminal status record and publish the corresponding event.
     * Also sets pendingHumanApproval if requireHumanApproval=true and completed.
     */
    async _writeTerminal(status, result) {
        // Guard against double-terminal (e.g. abort + error racing)
        // Guard against double-terminal writes.
        // IMPORTANT: also guard if the in-memory record is 'running' but the on-disk
        // record has already been set to 'cancelled' by SubAgentBridge.cancelTask().
        // Re-read the disk state to pick up any external cancellation.
        if (TERMINAL_STATUSES.has(this.record.status) && this.record.status !== 'running')
            return;
        const diskRecord = await readTask(this.record.taskId);
        if (diskRecord && TERMINAL_STATUSES.has(diskRecord.status)) {
            // Another code path (e.g. cancelTask) already wrote a terminal state.
            // Update our in-memory record but do not overwrite the disk state.
            this.record.status = diskRecord.status;
            return;
        }
        this.record.status = status;
        this.record.completedAt = Date.now();
        this.record.result = result;
        this.record.pendingHumanApproval =
            status === 'completed' && this.record.config.requireHumanApproval;
        await writeTask(this.record);
        // Publish event
        if (status === 'completed') {
            CampaignEventBus.emit('subagent:completed', {
                taskId: this.record.taskId,
                parentSessionId: this.record.parentSessionId,
                result,
            });
        }
        else {
            CampaignEventBus.emit('subagent:failed', {
                taskId: this.record.taskId,
                parentSessionId: this.record.parentSessionId,
                error: result.error ?? status,
            });
        }
    }
    /**
     * Save a checkpoint — called internally after each turn when
     * checkpointEveryNTurns > 0 and the turn boundary is detected.
     */
    async _saveCheckpoint(text, turnNumber) {
        this.record.latestCheckpoint = truncate(text.trim(), SUMMARY_MAX_CHARS);
        this.record.latestCheckpointAt = Date.now();
        void writeTask(this.record);
        CampaignEventBus.emit('subagent:checkpoint', {
            taskId: this.record.taskId,
            parentSessionId: this.record.parentSessionId,
            checkpoint: this.record.latestCheckpoint,
            turnNumber,
        });
    }
}
//# sourceMappingURL=SubAgentRunner.js.map
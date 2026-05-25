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
 *   runner.start()   // resolves internally; errors are converted to failed status
 *
 * Status progression: queued → running → completed | failed | cancelled
 */
import type { MetaAgentTool } from '../core/types.js';
import { type SubAgentRecord, type SubAgentTaskId } from './types.js';
export declare class SubAgentRunner {
    private readonly record;
    private readonly toolRegistry;
    private readonly abortSignal;
    private readonly _abortController;
    private readonly _forwardAbort;
    private readonly _interruptSessionOnAbort;
    private session?;
    constructor(record: SubAgentRecord, 
    /** All tools available in the runtime — runner filters by config.allowedTools */
    toolRegistry: Map<string, MetaAgentTool>, abortSignal: AbortSignal);
    get taskId(): SubAgentTaskId;
    /**
     * Start the sub-agent.  This is fire-and-forget — it resolves when the
     * sub-agent reaches a terminal state.  Errors are caught and written as
     * `failed` status, never rethrown.
     *
     * P1-1: The outer catch guarantees a terminal TaskStore write even if the
     * inner _run() catch handler itself throws — preventing the task from being
     * permanently stuck in 'running' state.
     */
    start(): Promise<void>;
    /**
     * Abort the sub-agent's internal session.
     * Called by SubAgentBridge.destroy() to cancel in-flight sub-agents when
     * the parent session ends.
     */
    abort(): void;
    private _run;
    /**
     * Resolve the allowed tool list for this sub-agent session.
     *
     * When a sandboxHandle is provided, the 'bash' tool is replaced with a
     * freshly-created sandboxed variant that captures the handle in its closure.
     * All other tools are returned unchanged from the tool registry.
     */
    private _resolveToolsWithSandbox;
    private _stopReasonToError;
    /**
     * Write a terminal status record and publish the corresponding event.
     * Also sets pendingHumanApproval if requireHumanApproval=true and completed.
     */
    private _writeTerminal;
    /**
     * Save a checkpoint — called internally after each turn when
     * checkpointEveryNTurns > 0 and the turn boundary is detected.
     */
    private _saveCheckpoint;
}
//# sourceMappingURL=SubAgentRunner.d.ts.map
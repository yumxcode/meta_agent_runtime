/**
 * KernelBridge — wires @meta-agent/cc-kernel (CC's production QueryEngine)
 * into the MetaAgentSession API surface.
 *
 * CC's QueryEngine provides:
 *   • Full multi-turn tool-use loop (no manual agentic loop needed)
 *   • Auto-compaction (5 strategies when context window fills)
 *   • Session persistence to disk
 *   • Production-grade permission/safety layer (configured permissive here)
 *
 * KernelBridge translates between the two type worlds:
 *   MetaAgentTool ←→ CC Tool (wrapped with minimal interface)
 *   SDKMessage    ←→ MetaAgentEvent
 */
import type { MetaAgentEvent, MetaAgentTool, TokenUsage, ConversationMessage } from '../core/types.js';
import type { MetaAgentConfig } from '../core/config.js';
export declare class KernelBridge {
    private cfg;
    private tools;
    private engine;
    private abortController;
    private totalUsage;
    private cwd;
    private sessionId;
    private readonly sessionStartMs;
    private _effectiveSystemPrompt;
    /**
     * True while submit() is iterating.  Guards _rebuildEngine() so that
     * registerTool() called concurrently with an active submit() doesn't replace
     * the engine under the live generator (Fix #3).  The deferred rebuild fires
     * after the current submit() finishes.
     */
    private _isSubmitting;
    private _rebuildPending;
    constructor(config: MetaAgentConfig);
    private _bootstrapEngine;
    private _rebuildEngine;
    registerTool(tool: MetaAgentTool): void;
    interrupt(): void;
    getMessages(): readonly ConversationMessage[];
    getUsage(): TokenUsage;
    getEstimatedCost(): number;
    getSessionId(): string;
    /**
     * Build the enriched system prompt suffix to append before each submit.
     *
     * Includes two blocks:
     *   1. Active campaign context (NEXT_ACTION, Pareto summary, phase)
     *   2. ## Compact Instructions (picked up by CC's auto-compact when it runs)
     *
     * CC's compact prompt explicitly looks for "## Compact Instructions" in the
     * conversation context and follows those instructions — so anything we put
     * here will be preserved in the compact summary without any CC code changes.
     *
     * Never throws — failures are silently swallowed.
     */
    private _buildEnrichedSuffix;
    submit(prompt: string): AsyncGenerator<MetaAgentEvent>;
}
//# sourceMappingURL=KernelBridge.d.ts.map
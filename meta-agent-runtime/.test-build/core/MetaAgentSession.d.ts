/**
 * MetaAgentSession — the primary entry point for meta-agent conversations.
 *
 * Mirrors the interface of Claude Code's QueryEngine so the two can be
 * swapped as CC internals become more accessible.
 *
 * Ref: claude-code-source-code-main/src/QueryEngine.ts
 *
 * Architecture highlights:
 *  - AsyncGenerator streaming (same pattern as CC's submitMessage)
 *  - AbortController for interrupt()
 *  - Multi-turn conversation state maintained in mutableMessages
 *  - Tool-use loop: model → tool_use → call() → tool_result → model (repeat)
 *  - Per-session cost tracking
 */
import { type MetaAgentConfig } from './config.js';
import type { SubAgentBridge } from '../subagent/SubAgentBridge.js';
import { type ConversationMessage, type MetaAgentEvent, type MetaAgentTool, type TokenUsage } from './types.js';
import { type AgentMode } from './dynamicPrompt.js';
import type { TaskContract } from './contract/types.js';
export declare class MetaAgentSession {
    private config;
    private client;
    private sessionId;
    private readonly sessionStartMs;
    private mutableMessages;
    private abortController;
    private totalUsage;
    private toolRegistry;
    /**
     * Resolved description strings, keyed by tool name.
     *
     * Mirrors CC's toolSchemaCache: descriptions are resolved once per session
     * (the first time buildApiToolsAsync() is called) and then reused.
     * The cache is invalidated (flag set to true) whenever registerTool() adds
     * or replaces a tool, so cross-tool references always reflect the current
     * registry.
     */
    private _descriptionCache;
    /**
     * When true, _descriptionCache must be rebuilt before the next API call.
     * Starts true so the first submit() always populates the cache.
     */
    private _descriptionCacheDirty;
    /** Cached once per deployment; never changes within a session. */
    private readonly staticPrompt;
    /** Per-session memoization cache for dynamic sections. */
    private readonly sectionRegistry;
    /**
     * Set to true by callTool() whenever a tool run completes (Fix #4).
     * submit() checks this flag instead of calling provenanceTracker.list() on
     * every turn — eliminating a potentially expensive I/O call from the hot path.
     * The flag is cleared after session_provenance is invalidated.
     */
    private _provenanceDirty;
    /**
     * True when the caller did NOT provide a custom systemPrompt.
     * Computed once in the constructor from the raw (unresolved) config so the
     * per-turn submit() path never has to reconstruct or compare the default
     * string — eliminating the risk of silent divergence when DEFAULT_SYSTEM_PROMPT
     * is updated in config.ts.
     */
    private readonly _usingDefaultPrompt;
    /**
     * The fully-assembled system prompt from the most recent submit() call.
     * Includes both static (S1-S10) and dynamic (D1-D10) sections, separated
     * by SYSTEM_PROMPT_DYNAMIC_BOUNDARY.  Null until the first submit().
     */
    private _lastSystemPrompt;
    /**
     * Plan-mode flag — shared mutable ref so EnterPlanMode / ExitPlanMode tools
     * can flip it without holding a reference to the session itself.
     * When true, every non-concurrency-safe tool call must be approved by the
     * user via askUser() before it executes.
     */
    readonly _planModeRef: {
        active: boolean;
    };
    /**
     * Guards against concurrent submit() calls on the same session instance.
     *
     * MetaAgentSession is NOT concurrent-safe: mutableMessages is a plain array
     * with no locking.  Two simultaneous submit() calls would interleave their
     * user messages and produce corrupted API payloads.
     *
     * When true, a submit() call is already in progress; new callers receive an
     * immediate error rather than silently corrupting the conversation state.
     */
    private _submitInFlight;
    /**
     * Optional SubAgentBridge — set via setSubAgentBridge().
     * When present, D11 sub-agent notification section is injected every turn.
     */
    private _subAgentBridge;
    /**
     * Optional TaskContract — set via setTaskContract().
     * When present, a memoized D0 goal-anchor section is prepended to every
     * prompt turn so the model always sees the original user intent and
     * acceptance criteria, even after compaction.
     * Also embedded in RunStateSnapshots on circuit-breaker exits.
     */
    private _taskContract;
    constructor(config?: MetaAgentConfig);
    /**
     * Submit a prompt and receive a stream of MetaAgentEvents.
     *
     * Usage:
     *   for await (const event of session.submit('Analyse this battery cell')) {
     *     if (event.type === 'text') process.stdout.write(event.text)
     *     if (event.type === 'result') console.log('Done:', event.result)
     *   }
     *
     * @param prompt  — the user message to submit.
     * @param mode    — detected agent mode (direct / agentic / campaign).
     *                  Defaults to 'agentic'. Pass the value from ModeDetector
     *                  when available; MetaAgentSession does not re-detect it.
     */
    submit(prompt: string, mode?: AgentMode): AsyncGenerator<MetaAgentEvent, void, unknown>;
    /** Internal generator — extracted so the try/finally above is clean. */
    private _submitInner;
    /** Abort any in-progress API call. Safe to call multiple times. */
    interrupt(): void;
    /** Register a new tool at runtime (no restart needed). */
    registerTool(tool: MetaAgentTool): void;
    /**
     * Dynamically update the appendSystemPrompt.
     *
     * Called by RoboticsSession (and other session wrappers) to inject
     * per-turn context (R1-R5 sections) without rebuilding the entire session.
     * The new value takes effect on the NEXT submit() call.
     */
    setAppendSystemPrompt(text: string): void;
    /**
     * Attach a SubAgentBridge to this session so that sub-agent completion
     * notifications are automatically injected into the system prompt on every
     * submit() turn (D11 section).
     *
     * Call this once after the bridge is created, before the first submit().
     * The bridge is held by reference — notifications are drained from it lazily
     * just before each API call so stale state never accumulates.
     */
    setSubAgentBridge(bridge: SubAgentBridge): void;
    /**
     * Attach a TaskContract to this session so that:
     *   1. A memoized D0 goal-anchor section is prepended to every prompt turn.
     *   2. The contract ID is embedded in RunStateSnapshots on circuit-breaker exits,
     *      enabling callers to resume with the full original user intent.
     *
     * Call this when a task becomes long-running (campaign launch, sub-agent spawn,
     * or explicit multi-step user request).  The contract is immutable — updates
     * must go through TaskContractStore.update() and then re-set here.
     */
    setTaskContract(contract: TaskContract): void;
    /** All messages in the current conversation. */
    getMessages(): readonly ConversationMessage[];
    /** Accumulated token usage across all turns. */
    getUsage(): TokenUsage;
    /** Estimated total cost in USD. */
    getEstimatedCost(): number;
    getSessionId(): string;
    /**
     * Returns the full system prompt assembled during the most recent submit() call.
     *
     * The string contains:
     *   • Static section (S1-S10): built once by buildStaticSystemPrompt()
     *   • SYSTEM_PROMPT_DYNAMIC_BOUNDARY: the HTML comment separator
     *   • Dynamic section (D1-D10): resolved per-turn by SectionRegistry
     *
     * Returns null if no submit() has been called yet.
     * Useful for debugging context engineering, prompt loading, and memory retrieval.
     */
    getLastSystemPrompt(): string | null;
    /**
     * Write a debug snapshot to ~/.meta-agent/debug/<sessionId>/turn-NNN-<kind>.json
     * Called fire-and-forget (void) — errors are silently swallowed so debug I/O
     * never interrupts the main conversation flow.
     *
     * Files are full-fidelity (no truncation) so they can be diffed / inspected
     * offline. The debug dir path is printed by the CLI at startup when --debug.
     */
    static _writeDebugFile(sessionId: string, turn: number, kind: 'req' | 'res', payload: unknown): Promise<void>;
    /** Return the debug log directory for this session (may not exist yet). */
    getDebugDir(): string;
    private buildApiMessages;
    /**
     * Resolve all tool descriptions (static strings pass through; async functions
     * are called with ToolDescriptionContext) and return Anthropic-format tool
     * schemas.
     *
     * Results are memoised in _descriptionCache for the lifetime of the tool
     * registry snapshot — mirrors CC's per-session toolSchemaCache.  The cache
     * is invalidated by registerTool() so cross-tool references stay accurate.
     */
    private buildApiToolsAsync;
    private callTool;
}
//# sourceMappingURL=MetaAgentSession.d.ts.map
/**
 * SessionRouter — unified session entry point with automatic mode routing.
 *
 * Replaces direct use of MetaAgentSession / KernelBridge. Consumers create a
 * SessionRouter, optionally register tools, and call submit() — the router
 * selects the right execution path transparently.
 *
 * Mode selection (in priority order):
 *   1. Caller explicitly sets mode: 'direct' | 'agentic' | 'campaign' | 'robotics'
 *   2. ModeDetector inspects the first prompt + environment (lazy, on submit)
 *   3. registerTool() auto-upgrades to minimum AGENTIC
 *
 * Mode selection is intentionally single-shot:
 *   - Mode is detected once on the FIRST submit() call.
 *   - registerTool() before the first submit() can raise mode to minimum AGENTIC.
 *   - After the backend is initialised, mode is FIXED for the session lifetime.
 *   - There is no mid-session mode upgrade (agentic → campaign mid-conversation).
 *
 * Rationale: backends (MetaAgentSession, KernelBridge, RoboticsSession) maintain
 * internal conversation state.  Transparently rebuilding a backend mid-session
 * would require history migration with no safe guarantee — it is better to start
 * a new session explicitly when mode needs to change.
 *
 * Mode upgrade (pre-first-submit only):
 *   DIRECT  → AGENTIC   triggered by registerTool()
 *   (any)   → explicit  triggered by RouterOptions.mode at construction time
 *
 * Execution backends:
 *   DIRECT   → MetaAgentSession (tools=[])          — one turn, no tool loop
 *   AGENTIC  → MetaAgentSession (with tools)         — full tool-use loop
 *   CAMPAIGN → KernelBridge     (with tools)         — CC engine + auto-compaction
 *   ROBOTICS → RoboticsSession  (with tools)         — ExperienceStore + WorkflowLoader
 *
 * Public API mirrors MetaAgentSession so it is a drop-in replacement:
 *   submit(), registerTool(), interrupt(), getMessages(), getUsage(),
 *   getEstimatedCost(), getSessionId()
 * Plus router-specific:
 *   get mode    — current SessionMode (null before first submit)
 *   get ready   — true once the impl is initialised
 */
import Anthropic from '@anthropic-ai/sdk';
import type { MetaAgentConfig } from '../core/config.js';
import type { ConversationMessage, MetaAgentEvent, MetaAgentTool, TokenUsage } from '../core/types.js';
import type { RouterOptions, SessionMode } from './types.js';
export declare class SessionRouter {
    private readonly _cfg;
    private readonly _hint;
    private readonly _debug;
    /**
     * Lightweight Anthropic client used exclusively for one-shot mode detection.
     * Separate from the backend session client: short timeout (3 s), 1 retry,
     * always uses the configured apiKey/baseURL. Null if no apiKey is available.
     */
    private readonly _detectionClient;
    /** Current active mode (null until first submit initialises the impl). */
    private _currentMode;
    /** Underlying session backend (created lazily on first submit). */
    private _impl;
    /** Tools registered before the impl was initialised, to be forwarded on init. */
    private _pendingTools;
    constructor(config?: MetaAgentConfig & RouterOptions);
    /** Current active mode — null before first submit(). */
    get mode(): SessionMode | null;
    /**
     * Return the lightweight Anthropic client used for side-calls (mode detection,
     * experience summaries, etc.).  This client is short-timeout (3 s) and always
     * targets the configured provider's API — it is intentionally separate from the
     * main session client so side-calls never pollute conversation history.
     *
     * Returns null when no API key is available or the provider is non-Anthropic
     * (third-party proxies don't expose claude-haiku-4-5-20251001).
     *
     * Callers that need a side-call model can use the fast haiku model for summaries
     * (cheap + low-latency) — callers are responsible for choosing the model string.
     */
    getSideCallClient(): Anthropic | null;
    /**
     * Return a minimal config snapshot needed for constructing a side-call client
     * when getSideCallClient() returns null (e.g. non-Anthropic provider that still
     * supports the messages API).  Exposes apiKey, baseURL, and resolved model.
     */
    getProviderConfig(): {
        apiKey: string | undefined;
        baseURL: string | undefined;
        model: string;
    };
    /** True once the backend impl has been created. */
    get ready(): boolean;
    /**
     * Submit a prompt. On the first call, ModeDetector runs and the appropriate
     * backend is created. Subsequent calls reuse the same backend.
     *
     * If the detected mode is higher than the current mode (e.g. prompt signals
     * campaign intent but session started in agentic), the backend is rebuilt
     * before forwarding the message.
     */
    submit(prompt: string): AsyncGenerator<MetaAgentEvent>;
    /**
     * Register a tool. Auto-upgrades mode to minimum AGENTIC — direct mode
     * cannot execute tools.
     *
     * If the backend is already initialised, the tool is forwarded immediately.
     * If not, it is buffered and applied when the backend starts.
     */
    registerTool(tool: MetaAgentTool): void;
    interrupt(): void;
    getMessages(): readonly ConversationMessage[];
    getUsage(): TokenUsage;
    getEstimatedCost(): number;
    getSessionId(): string;
    /**
     * Run mode detection for `prompt` without initialising the backend.
     * Returns the resolved SessionMode.
     *
     * Idempotent: once mode is fixed after the first submit(), subsequent calls
     * return immediately.  Intended for CLI callers that need to know mode
     * BEFORE streaming the first response — e.g. to prompt for a hardware
     * profile in robotics mode so the first AI turn already has hardware context.
     */
    primeMode(prompt: string): Promise<SessionMode>;
    /**
     * Gracefully dispose the active backend (if any).
     *
     * Only RoboticsSession implements dispose() — for MetaAgentSession and
     * KernelBridge this is a no-op.  Called by signal handlers in the CLI so
     * heartbeat timers, sub-agent runners, and git worktrees are cleaned up on
     * SIGTERM / uncaughtException without relying on GC.
     */
    dispose(): Promise<void>;
    /**
     * Return the robotics session's pending experience buffer (if mode=robotics).
     * Returns null in all other modes or before the first submit().
     * Uses duck-typing so SessionRouter does not import RoboticsSession directly.
     */
    getPendingExperiences(): import('../robotics/ExperiencePendingStore.js').ExperiencePendingStore | null;
    /**
     * Lazily initialise the backend on the first submit().
     * Mode is detected once here and fixed for the session lifetime.
     * Subsequent submit() calls skip this entirely (_impl is already set).
     */
    private _ensureImpl;
    /**
     * Raise the current mode to at least `newMode`.
     * Never downgrades. If mode increases after impl creation, a rebuild would
     * be needed — currently that's not triggered mid-session (registerTool raises
     * before the first submit; we guard here anyway).
     */
    private _raiseMode;
    /**
     * Instantiate the correct backend for the given mode.
     *
     *   DIRECT   → MetaAgentSession with no tools (tool list is not offered
     *               to the model; the agentic loop exits after one turn).
     *
     *   AGENTIC  → MetaAgentSession with registered tools and full loop.
     *
     *   CAMPAIGN → KernelBridge — uses CC's production QueryEngine which
     *               provides auto-compaction (essential for long-running
     *               campaigns that exhaust the context window).
     *
     *   ROBOTICS → RoboticsSession — wires ExperienceStore, GitWorkspaceManager,
     *               WorkflowLoader, and multi-agent orchestration for robot
     *               algorithm development. Imported lazily to avoid circular
     *               deps during bootstrap.
     */
    private _createImpl;
    /**
     * Convert the resolved internal config back into the shape accepted by
     * MetaAgentSession / KernelBridge constructors. We spread the full resolved
     * config and override `tools: []` — tools are injected separately via
     * registerTool() so the pending-buffer logic is honoured.
     *
     * Using spread (instead of a field-by-field copy) means any future fields
     * added to ResolvedConfig automatically flow through without an edit here.
     */
    private _cfgAsConfig;
}
//# sourceMappingURL=SessionRouter.d.ts.map
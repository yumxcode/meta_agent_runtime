/**
 * MetaAgentSession — the primary entry point for meta-agent conversations.
 *
 * Architecture (facade over AgenticSession):
 *
 *   MetaAgentSession
 *     ├─ SectionRegistry      — per-session prompt section memoisation
 *     ├─ toolRegistry         — MetaAgentTool map (used for dynamic sections)
 *     ├─ _planModeRef         — shared mutable plan-mode flag
 *     └─ _inner: AgenticSession  ← handles the actual agentic loop
 *          └─ KernelSession      ← the cc-kernel rewrite (query loop, compact, etc.)
 *
 * On every submit():
 *   1. Build the full system prompt (static + dynamic + appendSuffix)
 *   2. Push it into the inner session via setAppendSystemPrompt()
 *      (the inner session was created with systemPrompt:'', so the full
 *       prompt is always the appendSystemPrompt value)
 *   3. Delegate to AgenticSession.submit() and yield its events
 *
 * Compared to the old direct-Anthropic-SDK implementation:
 *   • The ~500-line agentic loop, streaming, tool execution, and auto-compact
 *     code are fully removed — all handled by cc-kernel via KernelSession.
 *   • System prompt building, SectionRegistry, plan-mode gating, and the
 *     beforeToolCall hook remain here and are wired in via tool wrappers and
 *     setAppendSystemPrompt().
 */
import { type MetaAgentConfig } from './config.js';
import type { SubAgentBridge } from '../subagent/SubAgentBridge.js';
import type { ConversationMessage, MetaAgentEvent, MetaAgentTool, TokenUsage } from './types.js';
import { type AgentMode } from './dynamicPrompt.js';
import type { TaskContract } from './contract/types.js';
export declare class MetaAgentSession {
    readonly sessionId: string;
    private readonly sessionStartMs;
    /**
     * Per-mode static prompt cache.  MetaAgentSession is never used for campaign
     * mode (CampaignSession handles that path), so in practice this map contains
     * at most one entry ('agentic' or 'robotics').  The Map avoids rebuilding the
     * string on every submit() while still supporting hypothetical mode switches.
     */
    private readonly _staticPromptCache;
    private readonly sectionRegistry;
    private readonly _usingDefaultPrompt;
    /**
     * Fully-assembled system prompt from the most recent submit() call.
     * null until the first submit().
     */
    private _lastSystemPrompt;
    /**
     * Stable (memoized-only) system prompt from the most recent submit().
     * Used to deduplicate setAppendSystemPrompt() calls: the inner session's
     * system message is only updated when content actually changes, preserving
     * the DeepSeek KV cache prefix across turns where only volatile context
     * (memory, subagent notifications, …) differs.
     */
    private _lastStableSystemPrompt;
    /**
     * Dynamic suffix set by setAppendSystemPrompt().
     * Injected after the dynamic sections on every submit().
     */
    private _appendSuffix;
    /**
     * True when callTool() has written a new provenance record since the last
     * submit(). Causes session_provenance to be re-resolved next turn.
     */
    private _provenanceDirty;
    /**
     * Shared mutable ref — EnterPlanMode / ExitPlanMode tools flip .active.
     * Exposed as `readonly` so callers can read it but only tools write it.
     */
    readonly _planModeRef: {
        active: boolean;
    };
    private _subAgentBridge;
    private _taskContract;
    private readonly _inner;
    private readonly toolRegistry;
    private readonly config;
    private readonly client;
    private _submitInFlight;
    private _sandboxHandles;
    constructor(config?: MetaAgentConfig);
    /**
     * Submit a prompt and receive a stream of MetaAgentEvents.
     *
     * @param prompt — the user message to submit.
     * @param mode   — agent execution mode hint (used for dynamic prompt sections).
     *                 Defaults to 'agentic'.
     */
    submit(prompt: string, mode?: AgentMode): AsyncGenerator<MetaAgentEvent, void, unknown>;
    private _submitInner;
    /**
     * Register a tool with the session.
     *
     * Wraps the tool's call() function to apply:
     *   1. The beforeToolCall hook (interactive confirmation guard)
     *   2. Plan-mode gating (ask user before non-safe tools)
     *   3. Provenance dirty-flagging (triggers session_provenance refresh)
     */
    registerTool(tool: MetaAgentTool): void;
    /** Interrupt the currently-running submit(). */
    interrupt(): void;
    /** All messages in the current conversation. */
    getMessages(): readonly ConversationMessage[];
    /** Accumulated token usage across all turns. */
    getUsage(): TokenUsage;
    /** Estimated total cost in USD. */
    getEstimatedCost(): number;
    getSessionId(): string;
    /**
     * Returns the full system prompt assembled during the most recent submit() call.
     * null until the first submit().
     */
    getLastSystemPrompt(): string | null;
    /**
     * Dynamically update the suffix appended to the system prompt.
     * Called by RoboticsSession to inject R1-R5 sections before each submit.
     * The new value takes effect on the NEXT submit() call.
     */
    setAppendSystemPrompt(text: string): void;
    /**
     * Attach a SubAgentBridge so sub-agent completion notifications are
     * injected into the system prompt on every submit turn (D11 section).
     */
    setSubAgentBridge(bridge: SubAgentBridge): void;
    /**
     * Attach a TaskContract so a memoized D0 goal-anchor section is prepended
     * to every prompt turn, embedding the original user intent and acceptance criteria.
     */
    setTaskContract(contract: TaskContract): void;
    /**
     * Release per-session resources. Call when a long-lived host is done with
     * this session; safe to call multiple times.
     *
     * S1 + S18: also forwards to the inner AgenticSession dispose (which clears
     * the kernel message buffer + tool closures + RuntimeContext-pinning
     * instrumentation), drops cached section results, and frees the static
     * prompt cache.
     */
    dispose(): Promise<void>;
    /** Backward-compatible synchronous teardown alias. */
    destroy(): void;
    /** Return the debug log directory for this session (may not exist yet). */
    getDebugDir(): string;
    /**
     * Write a debug snapshot to ~/.meta-agent/debug/<sessionId>/turn-NNN-<kind>.json
     * Called fire-and-forget — errors are silently swallowed so debug I/O
     * never interrupts the main conversation flow.
     */
    static _writeDebugFile(sessionId: string, turn: number, kind: 'req' | 'res', payload: unknown): Promise<void>;
    /**
     * Lazily create (or retrieve from cache) a SandboxHandle for the given policy.
     *
     * - `true`         → default policy: workspaceRoot writable, network unrestricted
     * - SandboxConfig  → caller-specified policy
     *
     * Handles are cached per session by policy key so tools with identical
     * policies reuse the same handle instance.  The Noop executor's handle is
     * also cached, so the overhead is just one Map lookup per tool call.
     */
    private _getOrCreateSandboxHandle;
    /**
     * Wrap a MetaAgentTool's call() to apply:
     *   1. Sandbox injection — if tool.permission.sandbox is set, a SandboxHandle
     *      is lazily created and injected into ToolCallContext.sandboxHandle before
     *      the tool's call() is invoked.  The tool reads ctx.sandboxHandle to wrap
     *      its subprocess execution (see BashTool).
     *   2. Provenance dirty-flag (triggers session_provenance refresh next turn)
     *
     * V&V/provenance instrumentation is applied by AgenticSession so direct
     * AgenticSession consumers and MetaAgentSession share one instrumentation path.
     * Permission hooks and plan-mode checks are enforced by the kernel policy.
     */
    private _wrapTool;
    /** Register a wrapped tool into the tool registry (for initial tools in constructor). */
    private _registerWrapped;
}
//# sourceMappingURL=MetaAgentSession.d.ts.map
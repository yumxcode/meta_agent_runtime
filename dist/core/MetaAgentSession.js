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
import Anthropic from '@anthropic-ai/sdk';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveConfig, isAnthropicProvider, DEFAULT_SYSTEM_PROMPT, } from './config.js';
import { createSandboxExecutor } from '../sandbox/index.js';
import { SectionRegistry } from './systemPromptSections.js';
import { buildStaticSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './staticPrompt.js';
import { buildDynamicSections, buildVolatileContextSections, formatVolatileContext, } from './dynamicPrompt.js';
import { AgenticSession } from '../modes/AgenticSession.js';
// ─────────────────────────────────────────────────────────────────────────────
// MetaAgentSession
// ─────────────────────────────────────────────────────────────────────────────
export class MetaAgentSession {
    // ── Identity ──────────────────────────────────────────────────────────────
    sessionId;
    sessionStartMs = Date.now();
    // ── Prompt engineering ────────────────────────────────────────────────────
    /**
     * Per-mode static prompt cache.  MetaAgentSession is never used for campaign
     * mode (CampaignSession handles that path), so in practice this map contains
     * at most one entry ('agentic' or 'robotics').  The Map avoids rebuilding the
     * string on every submit() while still supporting hypothetical mode switches.
     */
    _staticPromptCache = new Map();
    sectionRegistry = new SectionRegistry();
    _usingDefaultPrompt;
    /**
     * Fully-assembled system prompt from the most recent submit() call.
     * null until the first submit().
     */
    _lastSystemPrompt = null;
    /**
     * Stable (memoized-only) system prompt from the most recent submit().
     * Used to deduplicate setAppendSystemPrompt() calls: the inner session's
     * system message is only updated when content actually changes, preserving
     * the DeepSeek KV cache prefix across turns where only volatile context
     * (memory, subagent notifications, …) differs.
     */
    _lastStableSystemPrompt = null;
    /**
     * Dynamic suffix set by setAppendSystemPrompt().
     * Injected after the dynamic sections on every submit().
     */
    _appendSuffix = '';
    /**
     * True when callTool() has written a new provenance record since the last
     * submit(). Causes session_provenance to be re-resolved next turn.
     */
    _provenanceDirty = false;
    // ── Plan mode ─────────────────────────────────────────────────────────────
    /**
     * Shared mutable ref — EnterPlanMode / ExitPlanMode tools flip .active.
     * Exposed as `readonly` so callers can read it but only tools write it.
     */
    _planModeRef = { active: false };
    // ── External attachments ──────────────────────────────────────────────────
    _subAgentBridge = undefined;
    _taskContract = undefined;
    // ── Inner engine ──────────────────────────────────────────────────────────
    _inner;
    // ── Tool registry (for dynamic sections) ─────────────────────────────────
    toolRegistry;
    // ── Config (for prompt building) ──────────────────────────────────────────
    config;
    // ── Anthropic client (for memory relevance side-calls) ───────────────────
    client;
    // ── Concurrency guard ─────────────────────────────────────────────────────
    _submitInFlight = false;
    // ── Per-session sandbox handle cache ──────────────────────────────────────
    // Keyed by JSON.stringify(sandboxConfig) so tools with identical policies
    // share one handle rather than each spawning their own executor.
    // `true` policy is stored under the key '__default__'.
    _sandboxHandles = new Map();
    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────
    constructor(config = {}) {
        // Detect "no custom system prompt" BEFORE resolveConfig fills in the default
        this._usingDefaultPrompt =
            config.systemPrompt === undefined || config.systemPrompt === DEFAULT_SYSTEM_PROMPT;
        this.config = resolveConfig(config);
        this._appendSuffix = config.appendSystemPrompt ?? '';
        if (!this.config.apiKey) {
            throw new Error('API key is required. Set DEEPSEEK_API_KEY (DeepSeek), ANTHROPIC_API_KEY (Anthropic), ' +
                'or QWEN_API_KEY (Qwen) — the provider and endpoint are auto-detected from the key.\n' +
                'You can also pass config.apiKey and optionally config.baseURL for custom endpoints.');
        }
        // Anthropic client for memory relevance side-calls (not used for the loop)
        this.client = new Anthropic({
            apiKey: this.config.apiKey,
            baseURL: this.config.baseURL,
            maxRetries: this.config.maxRetries,
        });
        // Tool registry (for dynamic prompt sections)
        this.toolRegistry = new Map(this.config.tools.map(t => [t.name, t]));
        // ── Inner AgenticSession ─────────────────────────────────────────────────
        // Crucially, we set systemPrompt to '' so that the full assembled prompt
        // (built per-submit below) can be injected via setAppendSystemPrompt().
        // Empty string is falsy — KernelLoop's filter(Boolean) removes it so the
        // model only sees the dynamically-injected full prompt.
        this._inner = new AgenticSession({
            ...config,
            systemPrompt: '', // placeholder; real prompt injected per-submit
            appendSystemPrompt: '', // starts empty; set on first submit()
            tools: [], // registered below after MetaAgentSession wrapping
            planModeRef: this._planModeRef,
        });
        this.sessionId = this._inner.getSessionId();
        for (const tool of this.config.tools) {
            this.registerTool(tool);
        }
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Submit a prompt and receive a stream of MetaAgentEvents.
     *
     * @param prompt — the user message to submit.
     * @param mode   — agent execution mode hint (used for dynamic prompt sections).
     *                 Defaults to 'agentic'.
     */
    async *submit(prompt, mode = 'agentic') {
        if (this._submitInFlight) {
            throw new Error(`[MetaAgent:${this.sessionId.slice(0, 8)}] Cannot call submit() concurrently on the same session. ` +
                'Wait for the current turn to complete before submitting a new prompt.');
        }
        this._submitInFlight = true;
        try {
            yield* this._submitInner(prompt, mode);
        }
        finally {
            this._submitInFlight = false;
        }
    }
    async *_submitInner(prompt, mode) {
        // ── Step 1: Stable system prompt (memoized sections only) ──────────────
        //
        // These sections never change within a turn — they are computed once per
        // session (or on explicit invalidation) and cached by SectionRegistry.
        // Keeping the system message byte-identical across turns is the key
        // requirement for DeepSeek prefix KV cache: any change to messages[0]
        // collapses the cacheable prefix to zero, losing all conversation history.
        if (this._provenanceDirty) {
            this.sectionRegistry.invalidate('session_provenance');
            this._provenanceDirty = false;
        }
        const stableSections = buildDynamicSections({
            sessionId: this.sessionId,
            sessionStartMs: this.sessionStartMs,
            mode,
            domain: this.config.domain,
            rtx: this.config.runtimeContext,
            language: this.config.language,
            mcpServers: this.config.mcpServers,
            outputStyle: this.config.outputStyle,
            taskContract: this._taskContract,
            projectDir: this.config.projectDir,
            // NOTE: currentQuery / client / subAgentBridge are intentionally omitted —
            // those drove D1b and D11 which are now in the volatile user prefix.
        });
        const stablePrompt = await this.sectionRegistry.resolveToString(stableSections);
        // Assemble the full stable system prompt string
        let fullStablePrompt;
        if (!this._usingDefaultPrompt) {
            fullStablePrompt = this.config.systemPrompt ?? '';
            if (this._appendSuffix)
                fullStablePrompt += '\n\n' + this._appendSuffix;
            if (stablePrompt)
                fullStablePrompt += '\n\n' + stablePrompt;
        }
        else {
            // Build mode-specific static prompt lazily and cache per mode.
            // MetaAgentSession is only used for 'agentic' and 'robotics' modes;
            // 'campaign' would be a safety fallback (CampaignSession handles that path).
            const staticMode = mode === 'robotics' ? 'robotics' :
                mode === 'campaign' ? 'campaign' : 'agentic';
            let staticPrompt = this._staticPromptCache.get(staticMode);
            if (!staticPrompt) {
                staticPrompt = buildStaticSystemPrompt(staticMode);
                this._staticPromptCache.set(staticMode, staticPrompt);
            }
            fullStablePrompt = staticPrompt + SYSTEM_PROMPT_DYNAMIC_BOUNDARY + stablePrompt;
            if (this._appendSuffix)
                fullStablePrompt += '\n\n' + this._appendSuffix;
        }
        // Only call setAppendSystemPrompt when the content actually changed.
        // Identical content → identical messages[0] token sequence → cache hit.
        if (fullStablePrompt !== this._lastStableSystemPrompt) {
            this._inner.setAppendSystemPrompt(fullStablePrompt);
            this._lastStableSystemPrompt = fullStablePrompt;
        }
        this._lastSystemPrompt = fullStablePrompt;
        // ── Step 2: Volatile user-message prefix (per-turn, never cached) ─────
        //
        // D1b (memory), D11 (subagent notifications), and campaign D8/D9/D10 are
        // resolved here and prepended to the user message as XML-tagged context.
        // This keeps messages[0] stable while still giving the model fresh
        // per-turn state on every submission.
        const volatileSections = buildVolatileContextSections({
            currentQuery: prompt,
            client: isAnthropicProvider(this.config.baseURL) ? this.client : undefined,
            mode,
            domain: this.config.domain,
            subAgentBridge: this._subAgentBridge,
            rtx: this.config.runtimeContext,
            sessionStartMs: this.sessionStartMs,
        });
        const resolvedVolatile = await this.sectionRegistry.resolve(volatileSections);
        const volatilePrefix = formatVolatileContext(volatileSections, resolvedVolatile);
        const effectivePrompt = volatilePrefix
            ? `${volatilePrefix}\n\n---\n\n${prompt}`
            : prompt;
        // ── Step 3: Delegate to AgenticSession ────────────────────────────────
        yield* this._inner.submit(effectivePrompt);
    }
    /**
     * Register a tool with the session.
     *
     * Wraps the tool's call() function to apply:
     *   1. The beforeToolCall hook (interactive confirmation guard)
     *   2. Plan-mode gating (ask user before non-safe tools)
     *   3. Provenance dirty-flagging (triggers session_provenance refresh)
     */
    registerTool(tool) {
        const wrapped = this._wrapTool(tool);
        this.toolRegistry.set(tool.name, wrapped);
        this._inner.registerTool(wrapped);
    }
    /** Interrupt the currently-running submit(). */
    interrupt() {
        this._inner.interrupt();
    }
    /** All messages in the current conversation. */
    getMessages() {
        // KernelMessage is structurally compatible with ConversationMessage
        return this._inner.getMessages();
    }
    /** Accumulated token usage across all turns. */
    getUsage() {
        return this._inner.getUsage();
    }
    /** Estimated total cost in USD. */
    getEstimatedCost() {
        return this._inner.getEstimatedCost();
    }
    getSessionId() {
        return this.sessionId;
    }
    /**
     * Returns the full system prompt assembled during the most recent submit() call.
     * null until the first submit().
     */
    getLastSystemPrompt() {
        return this._lastSystemPrompt;
    }
    /**
     * Dynamically update the suffix appended to the system prompt.
     * Called by RoboticsSession to inject R1-R5 sections before each submit.
     * The new value takes effect on the NEXT submit() call.
     */
    setAppendSystemPrompt(text) {
        this._appendSuffix = text;
    }
    /**
     * Attach a SubAgentBridge so sub-agent completion notifications are
     * injected into the system prompt on every submit turn (D11 section).
     */
    setSubAgentBridge(bridge) {
        this._subAgentBridge = bridge;
    }
    /**
     * Attach a TaskContract so a memoized D0 goal-anchor section is prepended
     * to every prompt turn, embedding the original user intent and acceptance criteria.
     */
    setTaskContract(contract) {
        this._taskContract = contract;
    }
    /**
     * Release per-session resources. Call when a long-lived host is done with
     * this session; safe to call multiple times.
     *
     * S1 + S18: also forwards to the inner AgenticSession dispose (which clears
     * the kernel message buffer + tool closures + RuntimeContext-pinning
     * instrumentation), drops cached section results, and frees the static
     * prompt cache.
     */
    async dispose() {
        const handles = [...this._sandboxHandles.values()];
        this._sandboxHandles.clear();
        await Promise.allSettled(handles.map(handle => handle.destroy()));
        try {
            this._inner.dispose();
        }
        catch { /* best-effort */ }
        this.toolRegistry.clear();
        this._staticPromptCache.clear();
        this.sectionRegistry.clear();
        this._lastSystemPrompt = null;
        this._lastStableSystemPrompt = null;
        this._subAgentBridge = undefined;
        this._taskContract = undefined;
    }
    /** Backward-compatible synchronous teardown alias. */
    destroy() {
        void this.dispose();
    }
    /** Return the debug log directory for this session (may not exist yet). */
    getDebugDir() {
        return join(homedir(), '.meta-agent', 'debug', this.sessionId);
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Static helpers
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Write a debug snapshot to ~/.meta-agent/debug/<sessionId>/turn-NNN-<kind>.json
     * Called fire-and-forget — errors are silently swallowed so debug I/O
     * never interrupts the main conversation flow.
     */
    static async _writeDebugFile(sessionId, turn, kind, payload) {
        try {
            const dir = join(homedir(), '.meta-agent', 'debug', sessionId);
            await mkdir(dir, { recursive: true });
            const filename = `turn-${String(turn).padStart(3, '0')}-${kind}.json`;
            await writeFile(join(dir, filename), JSON.stringify(payload, null, 2), 'utf8');
        }
        catch (err) {
            process.stderr.write(`[meta-agent DEBUG] ⚠ 写入调试文件失败: ` +
                `${err instanceof Error ? err.message : String(err)}\n`);
        }
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Private helpers
    // ─────────────────────────────────────────────────────────────────────────
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
    async _getOrCreateSandboxHandle(policy) {
        const cacheKey = policy === true ? '__default__' : JSON.stringify(policy);
        const cached = this._sandboxHandles.get(cacheKey);
        if (cached)
            return cached;
        const config = policy === true ? {} : policy;
        const workspaceRoot = this.config.projectDir ?? process.cwd();
        const executor = createSandboxExecutor();
        if (executor.platform === 'noop' && !config.allowUnsandboxedFallback) {
            throw new Error('Sandbox requested, but no supported sandbox backend is available. ' +
                'Install sandbox-exec/bwrap or set sandbox.allowUnsandboxedFallback=true.');
        }
        const handle = await executor.create(config, workspaceRoot);
        this._sandboxHandles.set(cacheKey, handle);
        return handle;
    }
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
    _wrapTool(tool) {
        const hasRtx = Boolean(this.config.runtimeContext);
        const facade = this;
        const sandboxPolicy = tool.permission?.sandbox;
        return {
            ...tool,
            call: async (input, ctx) => {
                try {
                    // ── Sandbox context injection ──────────────────────────────────
                    // Enrich ctx with a sandboxHandle when the tool declares a sandbox
                    // policy.  The handle is created lazily and cached for the session.
                    let enrichedCtx = ctx;
                    if (sandboxPolicy !== undefined) {
                        const sandboxHandle = await facade._getOrCreateSandboxHandle(sandboxPolicy);
                        enrichedCtx = { ...ctx, sandboxHandle };
                    }
                    const result = await tool.call(input, enrichedCtx);
                    // Mark provenance dirty on any completion (success or error)
                    if (hasRtx)
                        facade._provenanceDirty = true;
                    return result;
                }
                catch (err) {
                    if (hasRtx)
                        facade._provenanceDirty = true;
                    return { content: `Tool error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
                }
            },
        };
    }
    /** Register a wrapped tool into the tool registry (for initial tools in constructor). */
    _registerWrapped(tool) {
        const wrapped = this._wrapTool(tool);
        this.toolRegistry.set(tool.name, wrapped);
    }
}
//# sourceMappingURL=MetaAgentSession.js.map
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
import { instrumentTool } from '../runtime/instrumentTool.js';
import { SectionRegistry } from './systemPromptSections.js';
import { buildStaticSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './staticPrompt.js';
import { buildDynamicSections } from './dynamicPrompt.js';
import { AgenticSession } from '../modes/AgenticSession.js';
// ─────────────────────────────────────────────────────────────────────────────
// MetaAgentSession
// ─────────────────────────────────────────────────────────────────────────────
export class MetaAgentSession {
    // ── Identity ──────────────────────────────────────────────────────────────
    sessionId;
    sessionStartMs = Date.now();
    // ── Prompt engineering ────────────────────────────────────────────────────
    staticPrompt = buildStaticSystemPrompt();
    sectionRegistry = new SectionRegistry();
    _usingDefaultPrompt;
    /**
     * Fully-assembled system prompt from the most recent submit() call.
     * null until the first submit().
     */
    _lastSystemPrompt = null;
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
            throw new Error('API key is required. Set it via config.apiKey or the ANTHROPIC_API_KEY environment variable.\n' +
                'For third-party providers (DeepSeek, Qwen, GLM…) also set config.baseURL to the provider\'s ' +
                'Anthropic-compatible endpoint (e.g. https://api.deepseek.com/anthropic).');
        }
        // Anthropic client for memory relevance side-calls (not used for the loop)
        this.client = new Anthropic({
            apiKey: this.config.apiKey,
            baseURL: this.config.baseURL,
            maxRetries: this.config.maxRetries,
        });
        // Tool registry (for dynamic prompt sections)
        if (this.config.runtimeContext) {
            const rtx = this.config.runtimeContext;
            const sp = this.config.systemPrompt;
            this.toolRegistry = new Map(this.config.tools.map(t => [t.name, instrumentTool(t, rtx, { systemPrompt: sp })]));
        }
        else {
            this.toolRegistry = new Map(this.config.tools.map(t => [t.name, t]));
        }
        // ── Inner AgenticSession ─────────────────────────────────────────────────
        // Crucially, we set systemPrompt to '' so that the full assembled prompt
        // (built per-submit below) can be injected via setAppendSystemPrompt().
        // Empty string is falsy — KernelLoop's filter(Boolean) removes it so the
        // model only sees the dynamically-injected full prompt.
        this._inner = new AgenticSession({
            ...config,
            systemPrompt: '', // placeholder; real prompt injected per-submit
            appendSystemPrompt: '', // starts empty; set on first submit()
            planModeRef: this._planModeRef,
        });
        this.sessionId = this._inner.getSessionId();
        // Register initial tools (they will be wrapped on the way in)
        for (const tool of this.config.tools) {
            this._registerWrapped(tool);
        }
        // Clear the initial registerTool calls above — they've been double-counted
        // because the AgenticSession constructor received config.tools already.
        // We reconstruct: create inner without tools, then register them.
        // → Actually, AgenticSession is constructed with config.tools (via ...config),
        //   which are passed down to KernelSession. Then the _registerWrapped calls
        //   above would double-register. Let's clear this up:
        // The correct approach: create AgenticSession with tools:[] and register here.
        // But we spread `...config` which includes `tools`. Fix: override tools:[].
        // We address this by not calling _registerWrapped in the constructor.
        // Instead, we rely on AgenticSession receiving config.tools via `...config`.
        // The tool wrapping (plan-mode, beforeToolCall, provenanceDirty) is applied
        // when registerTool() is called externally, not for initial tools.
        //
        // See registerTool() for the external-registration path.
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
        // ── Build system prompt ────────────────────────────────────────────────
        if (this._provenanceDirty) {
            this.sectionRegistry.invalidate('session_provenance');
            this._provenanceDirty = false;
        }
        const dynamicSections = buildDynamicSections({
            sessionId: this.sessionId,
            sessionStartMs: this.sessionStartMs,
            mode,
            domain: this.config.domain,
            rtx: this.config.runtimeContext,
            language: this.config.language,
            mcpServers: this.config.mcpServers,
            outputStyle: this.config.outputStyle,
            currentQuery: prompt,
            // Only pass Anthropic client for providers that support haiku side-calls
            client: isAnthropicProvider(this.config.baseURL) ? this.client : undefined,
            subAgentBridge: this._subAgentBridge,
            taskContract: this._taskContract,
            projectDir: this.config.projectDir,
        });
        const dynamicPrompt = await this.sectionRegistry.resolveToString(dynamicSections);
        // Assemble the full effective system prompt
        // Ordering mirrors the original MetaAgentSession exactly:
        //   Default  → staticPrompt + BOUNDARY + dynamicPrompt + '\n\n' + appendSuffix
        //   Custom   → config.systemPrompt + '\n\n' + appendSuffix + '\n\n' + dynamicPrompt
        let fullPrompt;
        if (!this._usingDefaultPrompt) {
            fullPrompt = this.config.systemPrompt ?? '';
            if (this._appendSuffix)
                fullPrompt += '\n\n' + this._appendSuffix;
            if (dynamicPrompt)
                fullPrompt += '\n\n' + dynamicPrompt;
        }
        else {
            fullPrompt = this.staticPrompt + SYSTEM_PROMPT_DYNAMIC_BOUNDARY + dynamicPrompt;
            if (this._appendSuffix)
                fullPrompt += '\n\n' + this._appendSuffix;
        }
        this._lastSystemPrompt = fullPrompt;
        // Inject into the inner session — because inner was created with
        // systemPrompt:'', the full prompt is injected entirely via appendSystemPrompt.
        this._inner.setAppendSystemPrompt(fullPrompt);
        // ── Delegate to AgenticSession ────────────────────────────────────────
        yield* this._inner.submit(prompt);
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
     * Wrap a MetaAgentTool's call() to apply:
     *   1. V&V instrumentation (if runtimeContext is present)
     *   2. Provenance dirty-flag (triggers session_provenance refresh next turn)
     *
     * Permission hooks and plan-mode checks are enforced by the kernel-level
     * canUseTool policy so every backend follows the same gate.
     */
    _wrapTool(tool) {
        // Apply V&V + provenance instrumentation first (innermost wrap)
        const instrumented = this.config.runtimeContext
            ? instrumentTool(tool, this.config.runtimeContext, { systemPrompt: this.config.systemPrompt })
            : tool;
        const hasRtx = Boolean(this.config.runtimeContext);
        const facade = this;
        return {
            ...instrumented,
            call: async (input, ctx) => {
                // ── Execute the (instrumented) tool ──────────────────────────────
                try {
                    const result = await instrumented.call(input, ctx);
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
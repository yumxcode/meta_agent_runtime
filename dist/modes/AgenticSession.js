/**
 * AgenticSession — full multi-turn agentic session backed by KernelSession.
 *
 * This is the main replacement for MetaAgentSession when running with the
 * new cc-kernel. Supports:
 *   - Multi-turn tool-use loop (up to maxTurns)
 *   - Auto-compact (flash model summariser)
 *   - Streaming events
 *   - Tool registration / upsert
 *   - Interrupt
 *   - Budget enforcement (maxBudgetUsd)
 */
import { KernelSession } from '../kernel/index.js';
import { resolveConfig, detectProvider, isAnthropicProvider } from '../core/config.js';
import { instrumentTool } from '../runtime/instrumentTool.js';
import { toKernelTool } from './toolAdapter.js';
import { translateKernelEvent } from './eventAdapter.js';
import { createPermissionPolicy } from '../kernel/permissions/PermissionPolicy.js';
function toKernelMessages(messages) {
    return (messages ?? []).map(message => ({
        uuid: crypto.randomUUID(),
        role: message.role,
        content: typeof message.content === 'string'
            ? [{ type: 'text', text: message.content }]
            : message.content,
    }));
}
export class AgenticSession {
    _engine;
    _config;
    _sessionId;
    _registeredTools = [];
    /** S1: guard against double dispose. */
    _disposed = false;
    _totalCostUsd = 0;
    _usage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
    };
    constructor(config) {
        this._config = config;
        const resolved = resolveConfig(config);
        const { apiKey, baseURL } = detectProvider(config);
        const isAnthropic = isAnthropicProvider(baseURL);
        this._engine = new KernelSession({
            apiKey,
            baseURL,
            model: resolved.model,
            fallbackModel: resolved.fallbackModel,
            fallbackThinkingConfig: resolved.fallbackThinkingConfig,
            fallbackBetas: resolved.fallbackBetas,
            fallbackIncludeDefaultBetas: resolved.fallbackIncludeDefaultBetas,
            sessionId: config.sessionId, // honour caller-pinned session ID
            cwd: resolved.projectDir ?? process.cwd(),
            systemPrompt: resolved.systemPrompt,
            appendSystemPrompt: resolved.appendSystemPrompt,
            initialMessages: toKernelMessages(resolved.initialMessages),
            tools: [],
            canUseTool: createPermissionPolicy({
                workspaceRoot: resolved.projectDir ?? process.cwd(),
                beforeToolCall: config.beforeToolCall,
                planModeRef: config.planModeRef,
                askUser: config.askUser,
                permissionConfig: config.permissionConfig,
            }),
            planModeRef: config.planModeRef,
            askUser: config.askUser,
            maxTurns: resolved.maxTurns,
            maxBudgetUsd: resolved.maxBudgetUsd,
            maxOutputTokens: resolved.maxTokens,
            maxRetries: resolved.maxRetries,
            compact: {
                enabled: true,
                model: resolved.flashModel,
            },
            // Thinking on the primary model — sourced from resolved.thinkingConfig
            // (default `{ type: 'adaptive' }`, set in resolveConfig).  When the
            // caller hasn't disabled it, the kernel:
            //   • Anthropic → sends `thinking: { type: 'enabled', budget_tokens: 16k }`
            //   • DeepSeek  → sends `reasoning_effort: 'max'`
            //   • Qwen      → goes through Anthropic-compat endpoint, thinking enabled
            // Fallback model still honours fallbackThinkingConfig (default disabled).
            thinkingConfig: resolved.thinkingConfig,
            // Anthropic-only betas: token-efficient-tools + interleaved-thinking
            // Skip for third-party providers (DeepSeek, Qwen, etc.) — they return 400
            includeDefaultBetas: isAnthropic ? undefined : false,
            betas: isAnthropic ? ['token-efficient-tools-2025-02-19'] : [],
            querySource: 'main',
            debug: resolved.debugMode,
        });
        this._sessionId = this._engine.getSessionId();
        for (const tool of resolved.tools) {
            this.registerTool(tool);
        }
    }
    // ── Tool registration ─────────────────────────────────────────────────────
    registerTool(tool) {
        const existingIdx = this._registeredTools.findIndex(t => t.name === tool.name);
        if (existingIdx >= 0) {
            this._registeredTools[existingIdx] = tool;
        }
        else {
            this._registeredTools.push(tool);
        }
        // Instrument with RuntimeContext if provided
        const wrapped = this._config.runtimeContext
            ? instrumentTool(tool, this._config.runtimeContext, {
                systemPrompt: this._config.systemPrompt,
            })
            : tool;
        // Build extensions for KernelToolContext
        const extensions = {};
        const rtx = this._config.runtimeContext;
        if (rtx) {
            extensions['jobManager'] = rtx.jobManager;
            extensions['vvChain'] = rtx.vvChain;
            extensions['provenanceTracker'] = rtx.provenanceTracker;
        }
        this._engine.upsertTool(toKernelTool(wrapped, extensions, () => ({
            tools: this._registeredTools,
            toolNames: new Set(this._registeredTools.map(t => t.name)),
            sessionId: this._sessionId,
            domain: this._config.domain,
        })));
    }
    // ── Submission ────────────────────────────────────────────────────────────
    async *submit(prompt) {
        const state = {
            sessionId: this._sessionId,
            startMs: Date.now(),
            turnCount: 0,
            totalCostUsd: this._totalCostUsd,
            usage: { ...this._usage },
        };
        for await (const event of this._engine.submitMessage(prompt)) {
            if (event.type === 'tool_use')
                state.turnCount++;
            if (event.type === 'result') {
                this._totalCostUsd = event.costUsd;
                this._usage = {
                    inputTokens: event.usage.inputTokens,
                    outputTokens: event.usage.outputTokens,
                    cacheCreationInputTokens: event.usage.cacheWriteTokens,
                    cacheReadInputTokens: event.usage.cacheReadTokens,
                };
                state.totalCostUsd = event.costUsd;
            }
            for (const translated of translateKernelEvent(event, state)) {
                yield translated;
            }
        }
    }
    // ── Lifecycle ─────────────────────────────────────────────────────────────
    interrupt() { this._engine.interrupt(); }
    /**
     * S1 + S9: Release all per-session resources.  Forwards to the inner
     * KernelSession dispose (which clears messages / fileCache / tools closures),
     * and empties our own _registeredTools array so any caller-supplied tools —
     * with their potentially heavy closures — become unreachable.
     *
     * Safe to call multiple times.  Once called the session must not be reused.
     */
    dispose() {
        if (this._disposed)
            return;
        this._disposed = true;
        try {
            this._engine.dispose();
        }
        catch { /* best-effort */ }
        this._registeredTools.length = 0;
    }
    getMessages() { return this._engine.getMessages(); }
    getSessionId() { return this._sessionId; }
    getUsage() { return { ...this._usage }; }
    getEstimatedCost() { return this._totalCostUsd; }
    /**
     * Update the system prompt suffix that is appended on every submit.
     * The full effective prompt is: systemPrompt + '\n\n' + appendSystemPrompt.
     * Used by MetaAgentSession to inject dynamic sections per-submit, and by
     * RoboticsSession to inject R1-R5 sections.
     */
    setAppendSystemPrompt(suffix) {
        this._engine.setAppendSystemPrompt(suffix);
    }
}
//# sourceMappingURL=AgenticSession.js.map
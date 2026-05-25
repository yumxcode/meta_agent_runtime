/**
 * AgenticSession — full multi-turn agentic session backed by KernelSession.
 *
 * This is the main replacement for MetaAgentSession when running with the
 * new cc-kernel. Supports:
 *   - Multi-turn tool-use loop (up to maxTurns)
 *   - Auto-compact (Haiku summariser)
 *   - Streaming events
 *   - Tool registration / upsert
 *   - Interrupt
 *   - Budget enforcement (maxBudgetUsd)
 */
import { KernelSession } from '../kernel/index.js';
import { resolveConfig, detectProvider } from '../core/config.js';
import { instrumentTool } from '../runtime/instrumentTool.js';
import { toKernelTool } from './toolAdapter.js';
import { translateKernelEvent } from './eventAdapter.js';
import { createPermissionPolicy } from '../kernel/permissions/PermissionPolicy.js';
export class AgenticSession {
    _engine;
    _config;
    _sessionId;
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
            maxTurns: resolved.maxTurns === Infinity ? 200 : resolved.maxTurns,
            maxBudgetUsd: resolved.maxBudgetUsd,
            maxOutputTokens: resolved.maxTokens,
            maxRetries: resolved.maxRetries,
            compact: {
                enabled: true,
                model: resolved.baseURL.includes('anthropic.com') ? 'claude-haiku-4-5-20251001' : resolved.model,
            },
            thinkingConfig: { type: 'adaptive' },
            querySource: 'main',
            // token-efficient-tools reduces schema token overhead for multi-tool sessions
            betas: ['token-efficient-tools-2025-02-19'],
        });
        this._sessionId = this._engine.getSessionId();
    }
    // ── Tool registration ─────────────────────────────────────────────────────
    registerTool(tool) {
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
        this._engine.upsertTool(toKernelTool(wrapped, extensions));
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
/**
 * DirectSession — single-turn session backed by KernelSession.
 *
 * Used for one-shot queries: maxTurns=1, compact disabled.
 * Equivalent to calling the Anthropic API once with tools.
 */
import { KernelSession } from '../kernel/index.js';
import { resolveConfig, detectProvider } from '../core/config.js';
import { toKernelTool } from './toolAdapter.js';
import { translateKernelEvent } from './eventAdapter.js';
import { createPermissionPolicy } from '../kernel/permissions/PermissionPolicy.js';
export class DirectSession {
    _engine;
    _sessionId;
    constructor(config) {
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
            cwd: resolved.projectDir ?? process.cwd(),
            systemPrompt: resolved.systemPrompt,
            tools: [], // added via registerTool()
            canUseTool: createPermissionPolicy({
                workspaceRoot: resolved.projectDir ?? process.cwd(),
                beforeToolCall: config.beforeToolCall,
                planModeRef: config.planModeRef,
                askUser: config.askUser,
                permissionConfig: config.permissionConfig,
            }),
            planModeRef: config.planModeRef,
            askUser: config.askUser,
            maxTurns: 1, // single-turn
            maxOutputTokens: resolved.maxTokens,
            maxRetries: resolved.maxRetries,
            compact: { enabled: false }, // no compact for single turns
            thinkingConfig: { type: 'disabled' },
        });
        this._sessionId = this._engine.getSessionId();
    }
    registerTool(tool) {
        this._engine.upsertTool(toKernelTool(tool));
    }
    async *submit(prompt) {
        const state = {
            sessionId: this._sessionId,
            startMs: Date.now(),
            turnCount: 0,
            totalCostUsd: 0,
            usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        };
        for await (const event of this._engine.submitMessage(prompt)) {
            if (event.type === 'tool_use')
                state.turnCount++;
            for (const translated of translateKernelEvent(event, state)) {
                yield translated;
            }
        }
    }
    getMessages() { return this._engine.getMessages(); }
    getSessionId() { return this._sessionId; }
    interrupt() { this._engine.interrupt(); }
}
//# sourceMappingURL=DirectSession.js.map
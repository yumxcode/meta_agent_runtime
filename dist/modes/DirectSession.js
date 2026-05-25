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
function toKernelMessages(messages) {
    return (messages ?? []).map(message => ({
        uuid: crypto.randomUUID(),
        role: message.role,
        content: typeof message.content === 'string'
            ? [{ type: 'text', text: message.content }]
            : message.content,
    }));
}
export class DirectSession {
    _engine;
    _sessionId;
    _registeredTools = [];
    /** #11: Guard against concurrent submit() calls on the same instance. */
    _submitInFlight = false;
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
            initialMessages: toKernelMessages(resolved.initialMessages),
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
        for (const tool of resolved.tools) {
            this.registerTool(tool);
        }
    }
    registerTool(tool) {
        const existingIdx = this._registeredTools.findIndex(t => t.name === tool.name);
        if (existingIdx >= 0)
            this._registeredTools[existingIdx] = tool;
        else
            this._registeredTools.push(tool);
        this._engine.upsertTool(toKernelTool(tool, undefined, () => ({
            tools: this._registeredTools,
            toolNames: new Set(this._registeredTools.map(t => t.name)),
            sessionId: this._sessionId,
            domain: undefined,
        })));
    }
    async *submit(prompt) {
        // #11: Friendlier reentrancy check at the DirectSession level, before the
        // KernelSession guard fires with its lower-level message.
        if (this._submitInFlight) {
            throw new Error('[DirectSession] Cannot submit a new prompt while a single-turn query is already in progress. ' +
                'Wait for the current turn to complete before calling submit() again.');
        }
        this._submitInFlight = true;
        const state = {
            sessionId: this._sessionId,
            startMs: Date.now(),
            turnCount: 0,
            totalCostUsd: 0,
            usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        };
        try {
            for await (const event of this._engine.submitMessage(prompt)) {
                if (event.type === 'tool_use')
                    state.turnCount++;
                for (const translated of translateKernelEvent(event, state)) {
                    yield translated;
                }
            }
        }
        finally {
            this._submitInFlight = false;
        }
    }
    getMessages() { return this._engine.getMessages(); }
    getSessionId() { return this._sessionId; }
    interrupt() { this._engine.interrupt(); }
}
//# sourceMappingURL=DirectSession.js.map
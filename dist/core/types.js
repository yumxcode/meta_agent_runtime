/**
 * Core type definitions for Meta-Agent Runtime
 *
 * Designed to be interface-compatible with Claude Code's SDKMessage types
 * so meta-agent-runtime and CC internals can be swapped in future.
 *
 * Ref: claude-code-source-code-main/src/entrypoints/agentSdkTypes.ts
 */
export const EMPTY_USAGE = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
};
export function accumulateUsage(a, b) {
    return {
        inputTokens: a.inputTokens + (b.inputTokens ?? 0),
        outputTokens: a.outputTokens + (b.outputTokens ?? 0),
        cacheCreationInputTokens: a.cacheCreationInputTokens + (b.cacheCreationInputTokens ?? 0),
        cacheReadInputTokens: a.cacheReadInputTokens + (b.cacheReadInputTokens ?? 0),
    };
}
//# sourceMappingURL=types.js.map
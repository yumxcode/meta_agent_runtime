/**
 * Translate a single KernelEvent to zero or more MetaAgentEvents.
 * Returns a (possibly empty) array — not a generator — to keep callers simple.
 */
export function translateKernelEvent(event, state) {
    switch (event.type) {
        case 'text_delta':
            return [{
                    type: 'text',
                    text: event.delta,
                    sessionId: state.sessionId,
                }];
        case 'tool_use':
            return [{
                    type: 'tool_use',
                    toolUseId: event.id,
                    toolName: event.name,
                    toolInput: event.input,
                    sessionId: state.sessionId,
                }];
        case 'tool_result':
            return [{
                    type: 'tool_result',
                    toolUseId: event.id,
                    content: event.content,
                    isError: event.isError,
                    sessionId: state.sessionId,
                }];
        case 'api_retry':
            return [{
                    type: 'api_retry',
                    attempt: event.attempt,
                    maxRetries: event.maxRetries,
                    retryDelayMs: event.retryDelayMs,
                    sessionId: state.sessionId,
                }];
        case 'result': {
            const durationMs = Date.now() - state.startMs;
            const subtype = mapResultSubtype(event.subtype);
            return [{
                    type: 'result',
                    subtype,
                    sessionId: state.sessionId,
                    result: event.resultText,
                    isError: subtype !== 'success',
                    durationMs,
                    numTurns: state.turnCount,
                    stopReason: event.stopReason,
                    totalCostUsd: event.costUsd,
                    usage: kernelUsageToMetaAgentUsage(event.usage),
                }];
        }
        // compact_boundary, system_message, tool_use_summary — not surfaced upstream
        default:
            return [];
    }
}
function mapResultSubtype(subtype) {
    if (subtype === 'success')
        return 'success';
    if (subtype === 'error_max_turns')
        return 'error_max_turns';
    if (subtype === 'error_max_budget_usd')
        return 'error_max_budget';
    return 'error_during_execution';
}
function kernelUsageToMetaAgentUsage(u) {
    return {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadInputTokens: u.cacheReadTokens,
        cacheCreationInputTokens: u.cacheWriteTokens,
    };
}
//# sourceMappingURL=eventAdapter.js.map
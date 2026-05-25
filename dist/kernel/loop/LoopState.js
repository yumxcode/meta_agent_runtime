export function initialLoopState(messages, model) {
    return {
        messages,
        autoCompactTracking: undefined,
        maxOutputTokensRecoveryCount: 0,
        maxOutputTokensOverride: undefined,
        hasAttemptedReactiveCompact: false,
        turnCount: 0,
        currentModel: model,
        fallbackTriggered: false,
    };
}
//# sourceMappingURL=LoopState.js.map
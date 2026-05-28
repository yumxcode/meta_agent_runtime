export function initialLoopState(messages, model, autoCompactTracking) {
    return {
        messages,
        autoCompactTracking,
        maxOutputTokensRecoveryCount: 0,
        maxOutputTokensOverride: undefined,
        hasAttemptedReactiveCompact: false,
        turnCount: 0,
        currentModel: model,
        fallbackTriggered: false,
    };
}
//# sourceMappingURL=LoopState.js.map
const RATES = {
    // ── Anthropic ──────────────────────────────────────────────────────────────
    'claude-opus-4-6': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
    'claude-sonnet-4-6': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    'claude-haiku-4-5-20251001': { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
    'claude-haiku-4-5': { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
    'claude-opus-4-5': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
    'claude-sonnet-4-5': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    'claude-3-7-sonnet-20250219': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    'claude-3-5-haiku-20241022': { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
    'claude-3-opus-20240229': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
    // ── DeepSeek ───────────────────────────────────────────────────────────────
    // Source: platform.deepseek.com/api-docs/pricing (cache = KV disk cache)
    // deepseek-chat / V3 / v4-flash: $0.27/M input, $1.10/M output, $0.07/M cache-hit
    'deepseek-chat': { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 },
    'deepseek-v3': { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 },
    'deepseek-v4-flash': { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 },
    // deepseek-reasoner / R1 / v4-pro: $0.55/M input, $2.19/M output, $0.14/M cache-hit
    'deepseek-reasoner': { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
    'deepseek-r1': { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
    'deepseek-v4-pro': { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
};
const FALLBACK_RATES = { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 };
function getRates(model) {
    for (const [key, rates] of Object.entries(RATES)) {
        if (model.startsWith(key))
            return rates;
    }
    return FALLBACK_RATES;
}
export function calcCostUsd(usage, model) {
    const r = getRates(model);
    return (usage.inputTokens * r.input +
        usage.outputTokens * r.output +
        usage.cacheReadTokens * r.cacheRead +
        usage.cacheWriteTokens * r.cacheWrite) / 1_000_000;
}
//# sourceMappingURL=CostTracker.js.map
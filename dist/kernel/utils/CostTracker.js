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
    // Source: platform.deepseek.com/api-docs/pricing — 原价（CNY ÷ 7.2 → USD/M tokens）
    //
    // deepseek-v4-flash:  ¥1/M input, ¥2/M output, ¥0.02/M cache-hit
    'deepseek-v4-flash': { input: 0.1389, output: 0.2778, cacheRead: 0.00278, cacheWrite: 0.1389 },
    'deepseek-v3': { input: 0.1389, output: 0.2778, cacheRead: 0.00278, cacheWrite: 0.1389 },
    // deepseek-v4-pro:   ¥12/M input, ¥24/M output, ¥0.1/M cache-hit
    'deepseek-v4-pro': { input: 1.6667, output: 3.3333, cacheRead: 0.01389, cacheWrite: 1.6667 },
    'deepseek-r1': { input: 1.6667, output: 3.3333, cacheRead: 0.01389, cacheWrite: 1.6667 },
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
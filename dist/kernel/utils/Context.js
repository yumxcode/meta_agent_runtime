/**
 * Context — model context window sizes and threshold calculations.
 * Mirrors CC's models.ts context window table and compactThreshold logic.
 */
// ── Model context windows (from CC source) ───────────────────────────────────
const MODEL_CONTEXT_WINDOWS = {
    'claude-opus-4-6': 200_000,
    'claude-sonnet-4-6': 200_000,
    'claude-haiku-4-5-20251001': 200_000,
    'claude-opus-4-5': 200_000,
    'claude-sonnet-4-5': 200_000,
    'claude-haiku-4-5': 200_000,
    'claude-3-7-sonnet-20250219': 200_000,
    'claude-3-5-sonnet-20241022': 200_000,
    'claude-3-5-haiku-20241022': 200_000,
    'claude-3-opus-20240229': 200_000,
    // DeepSeek — 1M context window (api.deepseek.com/anthropic)
    'deepseek-v4-flash': 1_000_000, // DeepSeek-V3-0324 (flash)
    'deepseek-v4-pro': 1_000_000, // DeepSeek-V3-0324 (pro)
    'deepseek-v3': 1_000_000, // DeepSeek-V3
    'deepseek-r1': 1_000_000, // DeepSeek-R1
    'deepseek-chat': 1_000_000, // api.deepseek.com default chat alias
    'deepseek-reasoner': 1_000_000, // api.deepseek.com default reasoner alias
};
const DEFAULT_CONTEXT_WINDOW = 200_000;
export function getContextWindowSize(model) {
    // Allow env override (CC: CLAUDE_CODE_AUTO_COMPACT_WINDOW)
    const envOverride = process.env['CLAUDE_CODE_AUTO_COMPACT_WINDOW'];
    if (envOverride) {
        const n = parseInt(envOverride, 10);
        if (!isNaN(n) && n > 0)
            return n;
    }
    // Prefix match for versioned models
    for (const [key, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
        if (model.startsWith(key))
            return size;
    }
    return DEFAULT_CONTEXT_WINDOW;
}
// ── Threshold calculations (mirroring CC's autocompact.ts) ───────────────────
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
const MANUAL_COMPACT_BUFFER_TOKENS = 3_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;
const LONG_CONTEXT_AUTOCOMPACT_CAP = 180_000;
export function calculateTokenWarningState(currentTokenCount, model, maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS) {
    // Allow override via env (CC: CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)
    const pctOverride = process.env['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'];
    const contextWindow = getContextWindowSize(model);
    const effectiveContextWindow = contextWindow - Math.min(maxOutputTokens, 20_000);
    let autoCompactThreshold;
    if (pctOverride) {
        const pct = parseFloat(pctOverride);
        if (!isNaN(pct) && pct > 0 && pct <= 1) {
            autoCompactThreshold = Math.floor(effectiveContextWindow * pct);
        }
        else {
            autoCompactThreshold = effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS;
        }
    }
    else {
        autoCompactThreshold = effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS;
    }
    if (!pctOverride && contextWindow > DEFAULT_CONTEXT_WINDOW) {
        const rawCap = process.env['META_AGENT_LONG_CONTEXT_AUTOCOMPACT_THRESHOLD'];
        const cap = rawCap ? Number.parseInt(rawCap, 10) : LONG_CONTEXT_AUTOCOMPACT_CAP;
        if (Number.isFinite(cap) && cap > 0) {
            autoCompactThreshold = Math.min(autoCompactThreshold, cap);
        }
    }
    const blockingLimit = effectiveContextWindow - MANUAL_COMPACT_BUFFER_TOKENS;
    return {
        isAtCompactThreshold: currentTokenCount >= autoCompactThreshold,
        isAtBlockingLimit: currentTokenCount >= blockingLimit,
        autoCompactThreshold,
        blockingLimit,
        effectiveContextWindow,
    };
}
export function isAutoCompactDisabled() {
    return !!(process.env['DISABLE_COMPACT'] ||
        process.env['DISABLE_AUTO_COMPACT']);
}
// ── Escalated max tokens (for max_output_tokens recovery) ────────────────────
export const ESCALATED_MAX_TOKENS = 131_072;
export const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;
//# sourceMappingURL=Context.js.map
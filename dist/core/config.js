/**
 * MetaAgentConfig — session-level configuration
 *
 * Mirrors the shape of QueryEngineConfig from CC but with engineering extensions.
 * Ref: claude-code-source-code-main/src/QueryEngine.ts → QueryEngineConfig
 *
 * Provider auto-detection:
 *   ANTHROPIC_API_KEY  → https://api.anthropic.com            (Claude models)
 *   DEEPSEEK_API_KEY   → https://api.deepseek.com              (deepseek-v4-flash / deepseek-v4-pro, native OpenAI format)
 *   QWEN_API_KEY       → https://dashscope.aliyuncs.com/apps/anthropic  (qwen-max / qwen-plus)
 *
 * Explicit config.apiKey / config.baseURL always take precedence over env vars.
 */
/** Provider-specific endpoint */
const PROVIDER_BASE_URLS = {
    anthropic: 'https://api.anthropic.com',
    deepseek: 'https://api.deepseek.com', // native OpenAI-compat endpoint
    qwen: 'https://dashscope.aliyuncs.com/apps/anthropic',
    unknown: 'https://api.anthropic.com',
};
/** Default (primary interaction) model for each provider */
const PROVIDER_DEFAULT_MODELS = {
    anthropic: 'claude-opus-4-6',
    deepseek: 'deepseek-v4-pro', // DeepSeek-V4 Pro (R1 reasoning) — primary interaction model
    qwen: 'qwen-plus',
    unknown: 'claude-opus-4-6',
};
const PROVIDER_FALLBACK_MODELS = {
    anthropic: 'claude-sonnet-4-6',
    deepseek: 'deepseek-v4-flash', // DeepSeek-V4 Flash — lighter fallback
    qwen: 'qwen-max',
    unknown: 'claude-sonnet-4-6',
};
/**
 * Fast auxiliary (flash) model per provider.
 * Used for side-calls: compact summarisation, mode detection, memory relevance,
 * experience summarisation.  Replaces the formerly Anthropic-only "haiku" pattern.
 */
const PROVIDER_FLASH_MODELS = {
    anthropic: 'claude-haiku-4-5-20251001',
    deepseek: 'deepseek-v4-flash',
    qwen: 'qwen-plus',
    unknown: 'deepseek-v4-flash',
};
/**
 * Detect which provider to use based on available environment variables.
 * Priority: explicit config values → DEEPSEEK_API_KEY → QWEN_API_KEY → ANTHROPIC_API_KEY
 */
export function detectProvider(config) {
    // If both apiKey and baseURL are explicit, trust the caller
    if (config.apiKey && config.baseURL) {
        const provider = inferProviderFromURL(config.baseURL);
        return {
            provider,
            apiKey: config.apiKey,
            baseURL: config.baseURL,
            defaultModel: PROVIDER_DEFAULT_MODELS[provider],
            fallbackModel: PROVIDER_FALLBACK_MODELS[provider],
            flashModel: PROVIDER_FLASH_MODELS[provider],
        };
    }
    // Auto-detect from environment
    const deepseekKey = process.env['DEEPSEEK_API_KEY'];
    const qwenKey = process.env['QWEN_API_KEY'];
    const anthropicKey = process.env['ANTHROPIC_API_KEY'];
    if (deepseekKey && !config.apiKey) {
        const baseURL = config.baseURL ?? PROVIDER_BASE_URLS['deepseek'];
        return { provider: 'deepseek', apiKey: deepseekKey, baseURL, defaultModel: PROVIDER_DEFAULT_MODELS['deepseek'], fallbackModel: PROVIDER_FALLBACK_MODELS['deepseek'], flashModel: PROVIDER_FLASH_MODELS['deepseek'] };
    }
    if (qwenKey && !config.apiKey) {
        const baseURL = config.baseURL ?? PROVIDER_BASE_URLS['qwen'];
        return { provider: 'qwen', apiKey: qwenKey, baseURL, defaultModel: PROVIDER_DEFAULT_MODELS['qwen'], fallbackModel: PROVIDER_FALLBACK_MODELS['qwen'], flashModel: PROVIDER_FLASH_MODELS['qwen'] };
    }
    // Fallback: Anthropic
    const apiKey = config.apiKey ?? anthropicKey ?? '';
    const baseURL = config.baseURL ?? PROVIDER_BASE_URLS['anthropic'];
    return { provider: 'anthropic', apiKey, baseURL, defaultModel: PROVIDER_DEFAULT_MODELS['anthropic'], fallbackModel: PROVIDER_FALLBACK_MODELS['anthropic'], flashModel: PROVIDER_FLASH_MODELS['anthropic'] };
}
function inferProviderFromURL(url) {
    if (url.includes('deepseek.com'))
        return 'deepseek';
    if (url.includes('dashscope'))
        return 'qwen';
    if (url.includes('anthropic.com'))
        return 'anthropic';
    return 'unknown';
}
/**
 * Returns true when `baseURL` resolves to Anthropic's own API endpoint.
 * Used to gate Anthropic-only features (interleaved-thinking, token-efficient-tools beta).
 *
 * Rules:
 *   • undefined/empty → true  (resolveConfig() fills in api.anthropic.com)
 *   • Contains "anthropic.com" → true
 *   • Anything else → false
 */
export function isAnthropicProvider(baseURL) {
    if (!baseURL)
        return true;
    return baseURL.includes('anthropic.com');
}
// `projectDir` is always present after resolveConfig() because we default to process.cwd().
// TypeScript's Required<> above already covers it; this comment is purely documentary.
export const DEFAULT_SYSTEM_PROMPT = `\
You are an expert engineering assistant. You help engineers solve complex problems \
in your domain with rigorous, quantitative analysis.

When performing calculations:
- Always include units with every numerical result
- State your assumptions explicitly before starting an analysis
- Flag any results that seem outside typical ranges for the domain
- If you use a simplifying assumption, note its potential impact on accuracy

When uncertain, say so clearly and suggest how to verify the result.`;
export function resolveConfig(config) {
    const { apiKey, baseURL, defaultModel, fallbackModel, flashModel } = detectProvider(config);
    const model = config.model ?? defaultModel;
    const resolvedFallbackModel = config.fallbackModel ?? (fallbackModel !== model ? fallbackModel : undefined);
    return {
        apiKey,
        baseURL,
        model,
        flashModel,
        fallbackModel: resolvedFallbackModel,
        fallbackThinkingConfig: config.fallbackThinkingConfig,
        fallbackBetas: config.fallbackBetas,
        fallbackIncludeDefaultBetas: config.fallbackIncludeDefaultBetas,
        domain: config.domain ?? 'generic',
        systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        appendSystemPrompt: config.appendSystemPrompt ?? '',
        maxTurns: config.maxTurns ?? Infinity,
        maxBudgetUsd: config.maxBudgetUsd ?? Infinity,
        maxTokens: config.maxTokens ?? 131_072,
        tools: config.tools ?? [],
        includeStreamEvents: config.includeStreamEvents ?? false,
        maxRetries: config.maxRetries ?? 3,
        verbose: config.verbose ?? false,
        // Optional — pass through as-is; undefined = feature disabled
        runtimeContext: config.runtimeContext,
        language: config.language,
        outputStyle: config.outputStyle,
        mcpServers: config.mcpServers,
        beforeToolCall: config.beforeToolCall,
        planModeRef: config.planModeRef,
        askUser: config.askUser,
        permissionConfig: config.permissionConfig,
        initialMessages: config.initialMessages,
        debugMode: config.debugMode,
        // projectDir: default to cwd so AGENT.md discovery works out-of-the-box
        projectDir: config.projectDir ?? process.cwd(),
    };
}
//# sourceMappingURL=config.js.map
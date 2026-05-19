/**
 * MetaAgentConfig — session-level configuration
 *
 * Mirrors the shape of QueryEngineConfig from CC but with engineering extensions.
 * Ref: claude-code-source-code-main/src/QueryEngine.ts → QueryEngineConfig
 *
 * Provider auto-detection:
 *   ANTHROPIC_API_KEY  → https://api.anthropic.com            (Claude models)
 *   DEEPSEEK_API_KEY   → https://api.deepseek.com/anthropic   (deepseek-chat / deepseek-reasoner)
 *   QWEN_API_KEY       → https://dashscope.aliyuncs.com/apps/anthropic  (qwen-max / qwen-plus)
 *
 * Explicit config.apiKey / config.baseURL always take precedence over env vars.
 */
import type { EngineeringDomain, MetaAgentTool } from './types.js';
import type { RuntimeContext } from '../runtime/RuntimeContext.js';
import type { OutputStyle } from './dynamicPrompt.js';
export type ModelProvider = 'anthropic' | 'deepseek' | 'qwen' | 'unknown';
/**
 * Detect which provider to use based on available environment variables.
 * Priority: explicit config values → DEEPSEEK_API_KEY → QWEN_API_KEY → ANTHROPIC_API_KEY
 */
export declare function detectProvider(config: {
    apiKey?: string;
    baseURL?: string;
    model?: string;
}): {
    provider: ModelProvider;
    apiKey: string;
    baseURL: string;
    defaultModel: string;
};
/**
 * Returns true when `baseURL` resolves to Anthropic's own API endpoint.
 *
 * Used to gate Haiku side-calls (mode detection, memory relevance selection)
 * that must be skipped when the session is configured for a third-party
 * provider (DeepSeek, Qwen, custom proxy) — those endpoints do not expose
 * `claude-haiku-4-5-20251001` and would return a 404/400 error.
 *
 * Rules:
 *   • undefined/empty → true  (resolveConfig() fills in api.anthropic.com)
 *   • Contains "anthropic.com" → true
 *   • Anything else → false
 */
export declare function isAnthropicProvider(baseURL?: string): boolean;
/**
 * Returned by `MetaAgentConfig.beforeToolCall` to control what happens
 * before a tool is executed.
 */
export type BeforeToolCallResult = {
    action: 'allow';
} | {
    action: 'deny';
    reason?: string;
} | {
    action: 'redirect';
    instructions: string;
};
export interface MetaAgentConfig {
    /**
     * Optional session ID override.  When set, MetaAgentSession uses this UUID
     * instead of generating a fresh one.  Used by RoboticsSession to align its
     * own sessionId with the inner session so debug file paths are consistent.
     */
    sessionId?: string;
    /** Anthropic API key. Falls back to ANTHROPIC_API_KEY env var. */
    apiKey?: string;
    /** Anthropic API base URL. Defaults to https://api.anthropic.com */
    baseURL?: string;
    /** Model to use. Default: 'claude-opus-4-6' */
    model?: string;
    /** Which engineering domain this session operates in. Default: 'generic' */
    domain?: EngineeringDomain;
    /** System prompt for the session. If not set, a default engineering prompt is used. */
    systemPrompt?: string;
    /** Append additional text to the system prompt (without replacing it). */
    appendSystemPrompt?: string;
    /** Maximum number of agentic turns before stopping. Default: 10 */
    maxTurns?: number;
    /** Maximum USD cost before stopping. */
    maxBudgetUsd?: number;
    /** Maximum output tokens per API call. Default: 8192 */
    maxTokens?: number;
    /** Tools available in this session. */
    tools?: MetaAgentTool[];
    /**
     * Whether to pass raw stream events through to the caller.
     * Useful for real-time UI rendering (typewriter effect).
     * Default: false
     */
    includeStreamEvents?: boolean;
    /** How many times to retry on transient API errors. Default: 3 */
    maxRetries?: number;
    verbose?: boolean;
    /**
     * BCP 47 language tag or natural-language instruction (e.g. "zh-CN", "French").
     * When set, the dynamic prompt instructs the model to respond in that language.
     * If omitted, the model replies in whatever language the user writes in.
     */
    language?: string;
    /**
     * Output verbosity preference.
     *   'summary'     — concise answers; omit intermediate steps.
     *   'detailed'    — show full working (assumptions + steps + results).
     *   'raw_numbers' — tables and values; minimal prose.
     * Defaults to unset (model decides based on context).
     */
    outputStyle?: OutputStyle;
    /**
     * Connected MCP servers and their tool-use instructions.
     * Injected into the D5 mcp_instructions dynamic section, grouped by server name.
     * Typically populated by the MCP connector registry after tool negotiation.
     */
    mcpServers?: import('./dynamicPrompt.js').McpServerInstruction[];
    /**
     * Root directory of the current project.  Used to discover `AGENT.md` /
     * `.meta-agent/AGENT.md` and inject its contents as the D1c agent_directives
     * section (workflow procedures, project-specific rules, important caveats).
     *
     * Resolution order (highest priority first):
     *   1. `<projectDir>/.meta-agent/AGENT.md`  — project-scoped directives
     *   2. `<projectDir>/AGENT.md`              — project root alternative
     *   3. `~/.meta-agent/AGENT.md`             — global user directives
     *
     * Defaults to `process.cwd()` when omitted.
     */
    projectDir?: string;
    /**
     * When provided, every tool registered in the session is automatically
     * wrapped with V&V + provenance tracking (instrumentTool), and each
     * session.submit() call injects recent computation summaries into the
     * system prompt (session preamble, path ③).
     */
    runtimeContext?: RuntimeContext;
    /**
     * Optional async hook called before every tool execution.
     *
     * Return values:
     *   { action: 'allow' }                          — proceed normally
     *   { action: 'deny',  reason?: string }         — block the call; the reason
     *     is returned to the model as a tool result so it can try another approach
     *   { action: 'redirect', instructions: string } — skip the call and return
     *     the user's instructions as a tool result; the model replans accordingly
     *
     * Typical use: interactive CLI confirmation for destructive / side-effectful
     * operations such as `pip install`, `rm -rf`, `git push`, `sudo`, etc.
     * The CLI registers this hook only when running in interactive TTY mode.
     */
    beforeToolCall?: (toolName: string, input: Record<string, unknown>) => Promise<BeforeToolCallResult>;
    /**
     * Pre-load conversation history to resume a previous session.
     * Messages are prepended to mutableMessages before the first submit().
     * Typically populated by SessionStore.loadHistory() in the CLI.
     */
    initialMessages?: import('./types.js').ConversationMessage[];
    /**
     * When true, prints the full assembled system prompt + message array to
     * stderr before each LLM API call, and prints the raw response content after.
     * Intended for development / prompt-engineering troubleshooting.
     * Enable via --debug CLI flag.
     */
    debugMode?: boolean;
}
export type ResolvedConfig = Required<Omit<MetaAgentConfig, 'sessionId' | 'runtimeContext' | 'language' | 'outputStyle' | 'mcpServers' | 'beforeToolCall' | 'initialMessages' | 'debugMode'>> & {
    runtimeContext?: RuntimeContext;
    language?: string;
    outputStyle?: OutputStyle;
    mcpServers?: import('./dynamicPrompt.js').McpServerInstruction[];
    beforeToolCall?: MetaAgentConfig['beforeToolCall'];
    initialMessages?: MetaAgentConfig['initialMessages'];
    debugMode?: boolean;
};
export declare const DEFAULT_SYSTEM_PROMPT = "You are an expert engineering assistant. You help engineers solve complex problems in your domain with rigorous, quantitative analysis.\n\nWhen performing calculations:\n- Always include units with every numerical result\n- State your assumptions explicitly before starting an analysis\n- Flag any results that seem outside typical ranges for the domain\n- If you use a simplifying assumption, note its potential impact on accuracy\n\nWhen uncertain, say so clearly and suggest how to verify the result.";
export declare function resolveConfig(config: MetaAgentConfig): ResolvedConfig;
//# sourceMappingURL=config.d.ts.map
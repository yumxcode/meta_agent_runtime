/**
 * KernelConfig — unified configuration for KernelSession.
 */
import type { KernelTool, KernelToolContext } from './KernelTool.js';
import type { KernelMessage } from './KernelMessage.js';
import type { PermissionDenial } from './KernelEvent.js';
export type ThinkingConfig = {
    type: 'disabled';
} | {
    type: 'enabled';
    budgetTokens: number;
} | {
    type: 'adaptive';
};
export interface CompactConfig {
    /** Whether to enable auto-compact (default: true) */
    enabled: boolean;
    /** Model to use for compact summarisation (default: haiku) */
    model?: string;
    /** Custom compact instructions (injected into the compact prompt's ## Compact Instructions section) */
    customInstructions?: string;
    /** querySource tag — 'compact' to prevent recursion */
    querySource?: string;
}
export type CanUseToolFn = (tool: KernelTool, input: unknown, assistantMessageUuid: string, toolUseId: string, context: KernelToolContext) => Promise<CanUseToolResult>;
export type CanUseToolResult = {
    behavior: 'allow';
} | {
    behavior: 'deny';
    reason: string;
} | {
    behavior: 'redirect';
    message: string;
};
export interface KernelConfig {
    /** Anthropic API key. Falls back to ANTHROPIC_API_KEY env var. */
    apiKey?: string;
    /** Main loop model (e.g. 'claude-sonnet-4-6'). */
    model: string;
    /** Fallback model — used when main model triggers a FallbackTriggeredError */
    fallbackModel?: string;
    /** Thinking config to use after fallback. Defaults to disabled. */
    fallbackThinkingConfig?: ThinkingConfig;
    /** Beta flags to use after fallback. Defaults to none. */
    fallbackBetas?: string[];
    /** Whether to include the kernel's default Anthropic beta flags after fallback. Defaults to false. */
    fallbackIncludeDefaultBetas?: boolean;
    /**
     * Additional Anthropic API beta feature flags sent on every request.
     * Merged with the kernel's default 'interleaved-thinking-2025-05-14' beta.
     *
     * Example — Campaign / agentic sessions with many tools should pass:
     *   betas: ['token-efficient-tools-2025-02-19']
     * This reduces token overhead for tool schema encoding (~40-70% savings on
     * tool-related prompt tokens in multi-tool sessions).
    */
    betas?: string[];
    /** Whether to include kernel default Anthropic beta flags. Defaults to true. */
    includeDefaultBetas?: boolean;
    /** Base URL override for the Anthropic client */
    baseURL?: string;
    /**
     * Optional pinned session ID. When omitted, KernelSession generates a random UUID.
     * Useful when callers (e.g. RoboticsSession) want the inner session ID to match
     * an outer session ID for consistent debug file paths and store entries.
     */
    sessionId?: string;
    /** Current working directory (used by tools). Defaults to process.cwd() */
    cwd?: string;
    /** System prompt text */
    systemPrompt?: string;
    /**
     * Suffix appended to systemPrompt on every submitMessage call.
     * Useful for Campaign/mode-specific dynamic context.
     */
    appendSystemPrompt?: string;
    /** Tools available to the model */
    tools: KernelTool[];
    /** Permission gate — called before each tool execution. Defaults to allow-all. */
    canUseTool?: CanUseToolFn;
    /** Mutable plan-mode state shared with enter/exit plan-mode tools. */
    planModeRef?: {
        active: boolean;
    };
    /** Optional user prompt function used by permission policies. */
    askUser?: (question: string, choices?: string[]) => Promise<string>;
    /** Maximum number of agentic turns per submitMessage call (default: 100) */
    maxTurns?: number;
    /** Maximum cumulative USD budget across this session's lifetime */
    maxBudgetUsd?: number;
    /** Override max_tokens sent to the API */
    maxOutputTokens?: number;
    /** Maximum API retries for transient errors (default: 5) */
    maxRetries?: number;
    /** Auto-compact configuration */
    compact?: CompactConfig;
    /**
     * querySource — prevents compact recursion.
     * Set to 'compact' when this session is used as a compact subagent.
     * Set to 'session_memory' for memory-update sessions.
     */
    querySource?: 'main' | 'compact' | 'session_memory' | string;
    thinkingConfig?: ThinkingConfig;
    /** Called whenever the internal messages array changes (for persistence). */
    onMessagesUpdate?: (messages: readonly KernelMessage[]) => void;
    /** Called when permission denials accumulate */
    onPermissionDenial?: (denial: PermissionDenial) => void;
    /** Enables verbose debug logging */
    debug?: boolean;
}
//# sourceMappingURL=KernelConfig.d.ts.map
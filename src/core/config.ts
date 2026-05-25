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

import type { EngineeringDomain, MetaAgentTool } from './types.js'
import type { RuntimeContext } from '../runtime/RuntimeContext.js'
import type { PermissionConfig } from '../kernel/permissions/PermissionPolicy.js'
import type { ThinkingConfig } from '../kernel/index.js'
import type { OutputStyle } from './dynamicPrompt.js'

// ─────────────────────────────────────────────────────────────────────────────
// Provider detection
// ─────────────────────────────────────────────────────────────────────────────

export type ModelProvider = 'anthropic' | 'deepseek' | 'qwen' | 'unknown'

/** Provider-specific endpoint */
const PROVIDER_BASE_URLS: Record<ModelProvider, string> = {
  anthropic: 'https://api.anthropic.com',
  deepseek:  'https://api.deepseek.com',          // native OpenAI-compat endpoint
  qwen:      'https://dashscope.aliyuncs.com/apps/anthropic',
  unknown:   'https://api.anthropic.com',
}

/** Default (primary interaction) model for each provider */
const PROVIDER_DEFAULT_MODELS: Record<ModelProvider, string> = {
  anthropic: 'claude-opus-4-6',
  deepseek:  'deepseek-v4-pro',    // DeepSeek-V4 Pro (R1 reasoning) — primary interaction model
  qwen:      'qwen-plus',
  unknown:   'claude-opus-4-6',
}

const PROVIDER_FALLBACK_MODELS: Record<ModelProvider, string | undefined> = {
  anthropic: 'claude-sonnet-4-6',
  deepseek:  'deepseek-v4-flash',  // DeepSeek-V4 Flash — lighter fallback
  qwen:      'qwen-max',
  unknown:   'claude-sonnet-4-6',
}

/**
 * Fast auxiliary (flash) model per provider.
 * Used for side-calls: compact summarisation, mode detection, memory relevance,
 * experience summarisation.  Replaces the formerly Anthropic-only "haiku" pattern.
 */
const PROVIDER_FLASH_MODELS: Record<ModelProvider, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  deepseek:  'deepseek-v4-flash',
  qwen:      'qwen-plus',
  unknown:   'deepseek-v4-flash',
}

/**
 * Detect which provider to use based on available environment variables.
 * Priority: explicit config values → DEEPSEEK_API_KEY → QWEN_API_KEY → ANTHROPIC_API_KEY
 */
export function detectProvider(config: {
  apiKey?: string
  baseURL?: string
  model?: string
}): { provider: ModelProvider; apiKey: string; baseURL: string; defaultModel: string; fallbackModel?: string; flashModel: string } {
  // If both apiKey and baseURL are explicit, trust the caller
  if (config.apiKey && config.baseURL) {
    const provider = inferProviderFromURL(config.baseURL)
    return {
      provider,
      apiKey:        config.apiKey,
      baseURL:       config.baseURL,
      defaultModel:  PROVIDER_DEFAULT_MODELS[provider],
      fallbackModel: PROVIDER_FALLBACK_MODELS[provider],
      flashModel:    PROVIDER_FLASH_MODELS[provider],
    }
  }

  // Auto-detect from environment
  const deepseekKey  = process.env['DEEPSEEK_API_KEY']
  const qwenKey      = process.env['QWEN_API_KEY']
  const anthropicKey = process.env['ANTHROPIC_API_KEY']

  if (deepseekKey && !config.apiKey) {
    const baseURL = config.baseURL ?? PROVIDER_BASE_URLS['deepseek']
    return { provider: 'deepseek', apiKey: deepseekKey, baseURL, defaultModel: PROVIDER_DEFAULT_MODELS['deepseek'], fallbackModel: PROVIDER_FALLBACK_MODELS['deepseek'], flashModel: PROVIDER_FLASH_MODELS['deepseek'] }
  }
  if (qwenKey && !config.apiKey) {
    const baseURL = config.baseURL ?? PROVIDER_BASE_URLS['qwen']
    return { provider: 'qwen', apiKey: qwenKey, baseURL, defaultModel: PROVIDER_DEFAULT_MODELS['qwen'], fallbackModel: PROVIDER_FALLBACK_MODELS['qwen'], flashModel: PROVIDER_FLASH_MODELS['qwen'] }
  }

  // Fallback: Anthropic
  const apiKey  = config.apiKey ?? anthropicKey ?? ''
  const baseURL = config.baseURL ?? PROVIDER_BASE_URLS['anthropic']
  return { provider: 'anthropic', apiKey, baseURL, defaultModel: PROVIDER_DEFAULT_MODELS['anthropic'], fallbackModel: PROVIDER_FALLBACK_MODELS['anthropic'], flashModel: PROVIDER_FLASH_MODELS['anthropic'] }
}

function inferProviderFromURL(url: string): ModelProvider {
  if (url.includes('deepseek.com'))    return 'deepseek'
  if (url.includes('dashscope'))       return 'qwen'
  if (url.includes('anthropic.com'))   return 'anthropic'
  return 'unknown'
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
export function isAnthropicProvider(baseURL?: string): boolean {
  if (!baseURL) return true
  return baseURL.includes('anthropic.com')
}

// ── Tool execution guard result ───────────────────────────────────────────────

/**
 * Returned by `MetaAgentConfig.beforeToolCall` to control what happens
 * before a tool is executed.
 */
export type BeforeToolCallResult =
  | { action: 'allow' }
  | { action: 'deny'; reason?: string }
  | { action: 'redirect'; instructions: string }

// ─────────────────────────────────────────────────────────────────────────────

export interface MetaAgentConfig {
  // ── Identity ───────────────────────────────────────────────────────────────
  /**
   * Optional session ID override.  When set, MetaAgentSession uses this UUID
   * instead of generating a fresh one.  Used by RoboticsSession to align its
   * own sessionId with the inner session so debug file paths are consistent.
   */
  sessionId?: string

  /** Anthropic API key. Falls back to ANTHROPIC_API_KEY env var. */
  apiKey?: string

  /** Anthropic API base URL. Defaults to https://api.anthropic.com */
  baseURL?: string

  // ── Model ──────────────────────────────────────────────────────────────────
  /** Model to use. Default: 'claude-opus-4-6' */
  model?: string

  /** Fallback model used when the primary model cannot satisfy request features. */
  fallbackModel?: string

  /** Thinking config to use after model fallback. Defaults to disabled. */
  fallbackThinkingConfig?: ThinkingConfig

  /** Beta flags to use after model fallback. Defaults to none. */
  fallbackBetas?: string[]

  /** Whether fallback requests include kernel default Anthropic beta flags. Defaults to false. */
  fallbackIncludeDefaultBetas?: boolean

  // ── Engineering domain ────────────────────────────────────────────────────
  /** Which engineering domain this session operates in. Default: 'generic' */
  domain?: EngineeringDomain

  /** System prompt for the session. If not set, a default engineering prompt is used. */
  systemPrompt?: string

  /** Append additional text to the system prompt (without replacing it). */
  appendSystemPrompt?: string

  // ── Limits ─────────────────────────────────────────────────────────────────
  /** Maximum number of agentic turns before stopping. Default: 10 */
  maxTurns?: number

  /** Maximum USD cost before stopping. */
  maxBudgetUsd?: number

  /** Maximum output tokens per API call. Default: 8192 */
  maxTokens?: number

  // ── Tools ──────────────────────────────────────────────────────────────────
  /** Tools available in this session. */
  tools?: MetaAgentTool[]

  // ── Streaming ──────────────────────────────────────────────────────────────
  /**
   * Whether to pass raw stream events through to the caller.
   * Useful for real-time UI rendering (typewriter effect).
   * Default: false
   */
  includeStreamEvents?: boolean

  // ── Retry ──────────────────────────────────────────────────────────────────
  /** How many times to retry on transient API errors. Default: 3 */
  maxRetries?: number

  // ── Verbosity ──────────────────────────────────────────────────────────────
  verbose?: boolean

  // ── Response personalisation ──────────────────────────────────────────────
  /**
   * BCP 47 language tag or natural-language instruction (e.g. "zh-CN", "French").
   * When set, the dynamic prompt instructs the model to respond in that language.
   * If omitted, the model replies in whatever language the user writes in.
   */
  language?: string

  /**
   * Output verbosity preference.
   *   'summary'     — concise answers; omit intermediate steps.
   *   'detailed'    — show full working (assumptions + steps + results).
   *   'raw_numbers' — tables and values; minimal prose.
   * Defaults to unset (model decides based on context).
   */
  outputStyle?: OutputStyle

  /**
   * Connected MCP servers and their tool-use instructions.
   * Injected into the D5 mcp_instructions dynamic section, grouped by server name.
   * Typically populated by the MCP connector registry after tool negotiation.
   */
  mcpServers?: import('./dynamicPrompt.js').McpServerInstruction[]

  // ── Project directory ─────────────────────────────────────────────────────
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
  projectDir?: string

  // ── Phase 1 integration ───────────────────────────────────────────────────
  /**
   * When provided, every tool registered in the session is automatically
   * wrapped with V&V + provenance tracking (instrumentTool), and each
   * session.submit() call injects recent computation summaries into the
   * system prompt (session preamble, path ③).
   */
  runtimeContext?: RuntimeContext

  // ── Tool execution guard ──────────────────────────────────────────────────
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
  beforeToolCall?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<BeforeToolCallResult>

  /** Shared plan-mode state consumed by the kernel permission policy. */
  planModeRef?: { active: boolean }

  /** Optional user prompt function consumed by the kernel permission policy. */
  askUser?: (question: string, choices?: string[]) => Promise<string>

  /** Runtime permission overrides merged after global/project permissions.json. */
  permissionConfig?: PermissionConfig

  // ── Session resume ────────────────────────────────────────────────────────
  /**
   * Pre-load conversation history to resume a previous session.
   * Messages are prepended to mutableMessages before the first submit().
   * Typically populated by SessionStore.loadHistory() in the CLI.
   */
  initialMessages?: import('./types.js').ConversationMessage[]

  // ── Debug mode ────────────────────────────────────────────────────────────
  /**
   * When true, prints the full assembled system prompt + message array to
   * stderr before each LLM API call, and prints the raw response content after.
   * Intended for development / prompt-engineering troubleshooting.
   * Enable via --debug CLI flag.
   */
  debugMode?: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolved config (all fields populated with defaults)
// ─────────────────────────────────────────────────────────────────────────────

// Fields that are truly optional in the resolved config (no meaningful default):
//   runtimeContext  — absent = no V&V / provenance instrumentation
//   language        — absent = model follows user's language
//   outputStyle     — absent = model decides verbosity
//   mcpServers      — absent = no MCP instructions injected
//   beforeToolCall  — absent = no interactive guard (non-TTY / programmatic use)
export type ResolvedConfig = Required<
  Omit<MetaAgentConfig,
    | 'sessionId'
    | 'runtimeContext'
    | 'language'
    | 'outputStyle'
    | 'mcpServers'
    | 'beforeToolCall'
    | 'planModeRef'
    | 'askUser'
    | 'permissionConfig'
    | 'initialMessages'
    | 'debugMode'
    | 'fallbackModel'
    | 'fallbackThinkingConfig'
    | 'fallbackBetas'
    | 'fallbackIncludeDefaultBetas'
  >
> & {
  runtimeContext?: RuntimeContext
  language?: string
  outputStyle?: OutputStyle
  mcpServers?: import('./dynamicPrompt.js').McpServerInstruction[]
  beforeToolCall?: MetaAgentConfig['beforeToolCall']
  planModeRef?: MetaAgentConfig['planModeRef']
  askUser?: MetaAgentConfig['askUser']
  permissionConfig?: PermissionConfig
  initialMessages?: MetaAgentConfig['initialMessages']
  debugMode?: boolean
  fallbackModel?: string
  fallbackThinkingConfig?: ThinkingConfig
  fallbackBetas?: string[]
  fallbackIncludeDefaultBetas?: boolean
  /** Fast auxiliary model for side-calls (compact, mode detection, memory, etc.) */
  flashModel: string
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

When uncertain, say so clearly and suggest how to verify the result.`

export function resolveConfig(config: MetaAgentConfig): ResolvedConfig {
  const { apiKey, baseURL, defaultModel, fallbackModel, flashModel } = detectProvider(config)
  const model = config.model ?? defaultModel
  const resolvedFallbackModel = config.fallbackModel ?? (fallbackModel !== model ? fallbackModel : undefined)
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
    runtimeContext:  config.runtimeContext,
    language:        config.language,
    outputStyle:     config.outputStyle,
    mcpServers:      config.mcpServers,
    beforeToolCall:  config.beforeToolCall,
    planModeRef:     config.planModeRef,
    askUser:         config.askUser,
    permissionConfig: config.permissionConfig,
    initialMessages: config.initialMessages,
    debugMode:       config.debugMode,
    // projectDir: default to cwd so AGENT.md discovery works out-of-the-box
    projectDir: config.projectDir ?? process.cwd(),
  }
}

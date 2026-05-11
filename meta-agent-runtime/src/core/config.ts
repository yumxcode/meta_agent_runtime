/**
 * MetaAgentConfig — session-level configuration
 *
 * Mirrors the shape of QueryEngineConfig from CC but with engineering extensions.
 * Ref: claude-code-source-code-main/src/QueryEngine.ts → QueryEngineConfig
 *
 * Provider auto-detection:
 *   ANTHROPIC_API_KEY  → https://api.anthropic.com       (Claude models)
 *   DEEPSEEK_API_KEY   → https://api.deepseek.com/anthropic  (deepseek-v4-flash / deepseek-v4-pro)
 *   QWEN_API_KEY       → https://dashscope.aliyuncs.com/apps/anthropic  (qwen-max / qwen-plus)
 *
 * Explicit config.apiKey / config.baseURL always take precedence over env vars.
 */

import type { EngineeringDomain, MetaAgentTool } from './types.js'
import type { RuntimeContext } from '../runtime/RuntimeContext.js'
import type { OutputStyle } from './dynamicPrompt.js'

// ─────────────────────────────────────────────────────────────────────────────
// Provider detection
// ─────────────────────────────────────────────────────────────────────────────

export type ModelProvider = 'anthropic' | 'deepseek' | 'qwen' | 'unknown'

/** Provider-specific endpoint (Anthropic-compatible) */
const PROVIDER_BASE_URLS: Record<ModelProvider, string> = {
  anthropic: 'https://api.anthropic.com',
  deepseek:  'https://api.deepseek.com/anthropic',
  qwen:      'https://dashscope.aliyuncs.com/apps/anthropic',
  unknown:   'https://api.anthropic.com',
}

/** Default model for each provider (cheapest capable of tool-use) */
const PROVIDER_DEFAULT_MODELS: Record<ModelProvider, string> = {
  anthropic: 'claude-opus-4-6',
  deepseek:  'deepseek-v4-flash',   // fast + cheap; use deepseek-v4-pro for heavy reasoning
  qwen:      'qwen-plus',
  unknown:   'claude-opus-4-6',
}

/**
 * Detect which provider to use based on available environment variables.
 * Priority: explicit config values → DEEPSEEK_API_KEY → QWEN_API_KEY → ANTHROPIC_API_KEY
 */
export function detectProvider(config: {
  apiKey?: string
  baseURL?: string
  model?: string
}): { provider: ModelProvider; apiKey: string; baseURL: string; defaultModel: string } {
  // If both apiKey and baseURL are explicit, trust the caller
  if (config.apiKey && config.baseURL) {
    const provider = inferProviderFromURL(config.baseURL)
    return {
      provider,
      apiKey:       config.apiKey,
      baseURL:      config.baseURL,
      defaultModel: PROVIDER_DEFAULT_MODELS[provider],
    }
  }

  // Auto-detect from environment
  const deepseekKey = process.env['DEEPSEEK_API_KEY']
  const qwenKey     = process.env['QWEN_API_KEY']
  const anthropicKey = process.env['ANTHROPIC_API_KEY']

  if (deepseekKey && !config.apiKey) {
    const baseURL = config.baseURL ?? PROVIDER_BASE_URLS['deepseek']
    return { provider: 'deepseek', apiKey: deepseekKey, baseURL, defaultModel: PROVIDER_DEFAULT_MODELS['deepseek'] }
  }
  if (qwenKey && !config.apiKey) {
    const baseURL = config.baseURL ?? PROVIDER_BASE_URLS['qwen']
    return { provider: 'qwen', apiKey: qwenKey, baseURL, defaultModel: PROVIDER_DEFAULT_MODELS['qwen'] }
  }

  // Fallback: Anthropic
  const apiKey  = config.apiKey ?? anthropicKey ?? ''
  const baseURL = config.baseURL ?? PROVIDER_BASE_URLS['anthropic']
  return { provider: 'anthropic', apiKey, baseURL, defaultModel: PROVIDER_DEFAULT_MODELS['anthropic'] }
}

function inferProviderFromURL(url: string): ModelProvider {
  if (url.includes('deepseek.com'))    return 'deepseek'
  if (url.includes('dashscope'))       return 'qwen'
  if (url.includes('anthropic.com'))   return 'anthropic'
  return 'unknown'
}

export interface MetaAgentConfig {
  // ── Identity ───────────────────────────────────────────────────────────────
  /** Anthropic API key. Falls back to ANTHROPIC_API_KEY env var. */
  apiKey?: string

  /** Anthropic API base URL. Defaults to https://api.anthropic.com */
  baseURL?: string

  // ── Model ──────────────────────────────────────────────────────────────────
  /** Model to use. Default: 'claude-opus-4-6' */
  model?: string

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

  // ── Phase 1 integration ───────────────────────────────────────────────────
  /**
   * When provided, every tool registered in the session is automatically
   * wrapped with V&V + provenance tracking (instrumentTool), and each
   * session.submit() call injects recent computation summaries into the
   * system prompt (session preamble, path ③).
   */
  runtimeContext?: RuntimeContext
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolved config (all fields populated with defaults)
// ─────────────────────────────────────────────────────────────────────────────

// Fields that are truly optional in the resolved config (no meaningful default):
//   runtimeContext — absent = no V&V / provenance instrumentation
//   language       — absent = model follows user's language
//   outputStyle    — absent = model decides verbosity
//   mcpServers      — absent = no MCP instructions injected
export type ResolvedConfig = Required<
  Omit<MetaAgentConfig, 'runtimeContext' | 'language' | 'outputStyle' | 'mcpServers'>
> & {
  runtimeContext?: RuntimeContext
  language?: string
  outputStyle?: OutputStyle
  mcpServers?: import('./dynamicPrompt.js').McpServerInstruction[]
}

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
  const { apiKey, baseURL, defaultModel } = detectProvider(config)
  return {
    apiKey,
    baseURL,
    model: config.model ?? defaultModel,
    domain: config.domain ?? 'generic',
    systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    appendSystemPrompt: config.appendSystemPrompt ?? '',
    maxTurns: config.maxTurns ?? 10,
    maxBudgetUsd: config.maxBudgetUsd ?? Infinity,
    maxTokens: config.maxTokens ?? 8192,
    tools: config.tools ?? [],
    includeStreamEvents: config.includeStreamEvents ?? false,
    maxRetries: config.maxRetries ?? 3,
    verbose: config.verbose ?? false,
    // Optional — pass through as-is; undefined = feature disabled
    runtimeContext: config.runtimeContext,
    language: config.language,
    outputStyle: config.outputStyle,
    mcpServers: config.mcpServers,
  }
}

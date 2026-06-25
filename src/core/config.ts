/**
 * MetaAgentConfig — session-level configuration
 *
 * Mirrors the shape of QueryEngineConfig from CC but with engineering extensions.
 * Ref: claude-code-source-code-main/src/QueryEngine.ts → QueryEngineConfig
 *
 * Provider auto-detection:
 *   ZHIPU_API_KEY      → https://open.bigmodel.cn/api/anthropic (GLM coding plan — glm-5.2, Anthropic-format, Bearer auth)
 *   DEEPSEEK_API_KEY   → https://api.deepseek.com              (deepseek-v4-flash, native OpenAI format)
 *   QWEN_API_KEY       → https://dashscope.aliyuncs.com/apps/anthropic  (qwen-max / qwen-plus)
 *   ANTHROPIC_API_KEY  → https://api.anthropic.com            (Claude models)
 *
 * Explicit config.apiKey / config.baseURL always take precedence over env vars.
 */

import type { AutonomyProfile, EngineeringDomain, MetaAgentTool } from './types.js'
import type { RuntimeContext } from '../runtime/RuntimeContext.js'
import type { PermissionConfig } from '../kernel/permissions/PermissionPolicy.js'
import type { ThinkingConfig } from '../kernel/index.js'
import type { CompactProfile } from '../kernel/compact/CompactPrompt.js'
import type { AgentMode, OutputStyle } from './dynamicPrompt.js'
import { loadModelConfig } from './config/ConfigService.js'
import { resolveProvider, inferProviderFromURL as registryInferFromURL } from '../providers/registry.js'
import type { Capabilities, Protocol } from '../providers/registry.js'

// ─────────────────────────────────────────────────────────────────────────────
// Provider detection
//
// All provider knowledge now lives in the Provider Registry
// (src/providers/registry.ts).  The thin wrappers below preserve the historical
// `detectProvider` / `inferProviderFromURL` / `isAnthropicProvider` API so
// existing call-sites keep working, while delegating the actual logic.
// ─────────────────────────────────────────────────────────────────────────────

export type ModelProvider = 'anthropic' | 'deepseek' | 'qwen' | 'zhipu' | 'unknown'

/**
 * Detect which provider to use from explicit values + environment variables.
 * Delegates to the registry's resolveProvider(); see its precedence rules.
 * Notably fixes the case where an explicit apiKey with no baseURL but a
 * provider-specific model name (e.g. `deepseek-…`) used to fall through to
 * Anthropic.
 */
export function detectProvider(config: {
  apiKey?: string
  baseURL?: string
  model?: string
}): { provider: ModelProvider; apiKey: string; baseURL: string; defaultModel: string; fallbackModel?: string; flashModel: string } {
  const r = resolveProvider(config)
  return {
    provider:      r.provider,
    apiKey:        r.apiKey,
    baseURL:       r.baseURL,
    defaultModel:  r.defaultModel,
    fallbackModel: r.fallbackModel,
    flashModel:    r.flashModel,
  }
}

/** Infer the provider id from a base URL (registry-backed). */
export function inferProviderFromURL(url: string): ModelProvider {
  return registryInferFromURL(url)
}

/**
 * Returns true when `baseURL` resolves to Anthropic's own API endpoint.
 * Kept for callers that only need the native-Anthropic distinction; prefer the
 * capability flags from resolveConfig() for feature gating.
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

  /**
   * Fast auxiliary (flash) model for side-calls: mode detection, memory
   * relevance, experience summarisation, and other small enrichments. When
   * omitted the provider's default flash model is used. Overridable via the
   * global config file (~/.meta-agent/config.json → flashModel).
   */
  flashModel?: string

  /**
   * Model used specifically for context compaction. Defaults to `flashModel`.
   * Use this when the best compact summariser has a larger context window but
   * is too slow for lightweight flash side-calls.
   */
  compactModel?: string

  /**
   * Compaction overrides forwarded to the kernel's CompactConfig.
   *
   * `customInstructions` may be a thunk resolved lazily at compaction time —
   * used by RoboticsSession to inject mode-specific compact guidance (active
   * sub-agent task IDs, current phase, hardware constraints) into the compact
   * side-call prompt only when compaction actually fires, instead of paying for
   * it on every turn in the volatile context prefix.
   */
  compact?: {
    customInstructions?: string | (() => string | null | undefined)
    /**
     * Deterministic state anchors appended to the compact OUTPUT (not just the
     * side-call prompt), surviving terse/empty summaries. Resolved lazily at
     * compaction time. Used by RoboticsSession to guarantee active/completed
     * sub-agent task IDs, phase, hardware safety limits and the experience
     * working set persist across compaction regardless of summary quality.
     */
    deterministicAnchors?: string | (() => string | null | undefined)
    /**
     * Per-mode compact section template. RoboticsSession sets 'robotics',
     * CampaignSession 'campaign'; defaults to 'agentic' downstream. Forwarded
     * into the kernel compact call so the summariser produces domain-appropriate
     * sections.
     */
    promptProfile?: CompactProfile
  }

  /**
   * Thinking ("extended thinking" / "reasoning") config for the primary model.
   *
   *   { type: 'disabled' }                            — no thinking blocks
   *   { type: 'adaptive' }                            — let the kernel pick a
   *                                                     budget (16 000 tokens
   *                                                     for Anthropic;
   *                                                     reasoning_effort='max'
   *                                                     for DeepSeek / Qwen)
   *   { type: 'enabled', budgetTokens: 32_000 }       — fixed Anthropic budget
   *
   * Default: `{ type: 'adaptive' }`. Thinking is ON by default so the model
   * can deliberate before responding; explicitly set `{ type: 'disabled' }` to
   * opt out (e.g. on cost-sensitive or latency-critical paths).
   */
  thinkingConfig?: ThinkingConfig

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

  /**
   * Default agent execution mode used for dynamic prompt sections when submit()
   * is called without an explicit mode (the SessionRouter path). Defaults to
   * 'agentic'. The router sets 'auto' so the auto backend renders the AUTO D4
   * section even though it reuses MetaAgentSession.
   *
   * NOTE: named `promptMode` (not `agentMode`) to avoid colliding with
   * RoboticsSessionOptions.agentMode, which is a different concept
   * (single/multi orchestration).
   */
  promptMode?: AgentMode

  /**
   * Autonomy profile (auto mode). Threaded into the kernel permission policy
   * and the sandbox handle factory:
   *   - autoApproveInWorkspace → in-workspace sensitive ops skip the confirm guard
   *   - lockWorkspace          → jail cannot be unlocked by config; OS sandbox is
   *                              fail-closed (no silent unsandboxed fallback)
   * Absent = legacy behaviour (interactive guard, fail-open sandbox fallback).
   */
  autonomy?: AutonomyProfile

  /**
   * Auto mode completion gate. Forwarded verbatim to the kernel (see
   * KernelConfig.verifyGate): at the moment the model declares itself done, an
   * independent judge verifies the original goal is actually met. Built by the
   * session/router layer (it owns the goal anchor + sub-agent dispatcher).
   * Absent = the model's own "done" is trusted.
   */
  verifyGate?: import('../kernel/loop/VerifyGate.js').VerifyGateFn

  /**
   * Auto mode mid-flight drift/reflection gate (Checkpoint + Learn). Forwarded
   * to the kernel (see KernelConfig.driftGate). Built by the router layer.
   */
  driftGate?: import('../kernel/loop/DriftGate.js').DriftGateFn

  /** Kernel execution-boundary hook used by auto checkpoint persistence. */
  onCheckpointBoundary?: import('../kernel/loop/CheckpointBoundary.js').CheckpointBoundaryFn

  /** Resume seed for the session-lifetime tool-batch counter. */
  initialToolBatchCount?: number

  /** Resume seed for the latest durable checkpoint revision. */
  initialCheckpointRevision?: number

  /**
   * Auto mode experience recall. When set, MetaAgentSession appends the returned
   * block (relevant prior lessons) to the stable system prompt each turn so the
   * main agent benefits from accumulated experience. Returns null when empty.
   */
  getExperienceRecallBlock?: () => Promise<string | null>

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
    | 'promptMode'
    | 'autonomy'
    | 'verifyGate'
    | 'driftGate'
    | 'onCheckpointBoundary'
    | 'initialToolBatchCount'
    | 'initialCheckpointRevision'
    | 'getExperienceRecallBlock'
    | 'initialMessages'
    | 'debugMode'
    | 'fallbackModel'
    | 'fallbackThinkingConfig'
    | 'fallbackBetas'
    | 'fallbackIncludeDefaultBetas'
    | 'thinkingConfig'
    | 'compact'
  >
> & {
  compact?: MetaAgentConfig['compact']
  runtimeContext?: RuntimeContext
  language?: string
  outputStyle?: OutputStyle
  mcpServers?: import('./dynamicPrompt.js').McpServerInstruction[]
  beforeToolCall?: MetaAgentConfig['beforeToolCall']
  planModeRef?: MetaAgentConfig['planModeRef']
  askUser?: MetaAgentConfig['askUser']
  permissionConfig?: PermissionConfig
  /** Default agent mode for prompt sections (absent → 'agentic'). */
  promptMode?: AgentMode
  /** Autonomy profile (auto mode); absent → legacy non-autonomous behaviour. */
  autonomy?: AutonomyProfile
  /** Auto mode completion gate (Verify); absent → trust the model's "done". */
  verifyGate?: MetaAgentConfig['verifyGate']
  /** Auto mode mid-flight drift gate; absent → no drift checking. */
  driftGate?: MetaAgentConfig['driftGate']
  onCheckpointBoundary?: MetaAgentConfig['onCheckpointBoundary']
  initialToolBatchCount?: number
  initialCheckpointRevision?: number
  /** Auto mode experience recall provider; absent → no recall injection. */
  getExperienceRecallBlock?: MetaAgentConfig['getExperienceRecallBlock']
  initialMessages?: MetaAgentConfig['initialMessages']
  debugMode?: boolean
  fallbackModel?: string
  /**
   * Resolved primary-model thinking config.  Always populated by
   * resolveConfig() — defaults to `{ type: 'adaptive' }` when the caller did
   * not specify it.
   */
  thinkingConfig: ThinkingConfig
  fallbackThinkingConfig?: ThinkingConfig
  fallbackBetas?: string[]
  fallbackIncludeDefaultBetas?: boolean
  /** Fast auxiliary model for side-calls (mode detection, memory, small enrichments, etc.) */
  flashModel: string
  /** Model used specifically for compact summarisation. */
  compactModel: string
  /** Wire protocol for the resolved provider ('anthropic' | 'openai'). */
  protocol: Protocol
  /** Effective capability flags (betas / thinking / prompt-cache) for the provider. */
  capabilities: Capabilities
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
  // Layered config (global ⊕ project ⊕ session, more-specific wins) takes
  // precedence over caller/CLI values, which in turn take precedence over
  // built-in provider defaults:  config-file > CLI > default. The project layer
  // is read from <projectDir>/.meta-agent/config.json when projectDir is set.
  const file = loadModelConfig({ projectDir: config.projectDir })

  // apiKey / baseURL / model fed into provider detection (file wins).
  const detectInput = {
    apiKey:  file.apiKey  ?? config.apiKey,
    baseURL: file.baseURL ?? config.baseURL,
    model:   file.mainModel ?? config.model,
  }
  const resolvedProvider = resolveProvider(detectInput)
  const { apiKey, baseURL, defaultModel, fallbackModel, flashModel } = {
    apiKey:        resolvedProvider.apiKey,
    baseURL:       resolvedProvider.baseURL,
    defaultModel:  resolvedProvider.defaultModel,
    fallbackModel: resolvedProvider.fallbackModel,
    flashModel:    resolvedProvider.flashModel,
  }

  const model = file.mainModel ?? config.model ?? defaultModel
  const resolvedFallbackModel =
    file.fallbackModel ?? config.fallbackModel ?? (fallbackModel !== model ? fallbackModel : undefined)
  const resolvedFlashModel = file.flashModel ?? config.flashModel ?? flashModel
  const resolvedCompactModel = file.compactModel ?? config.compactModel ?? resolvedFlashModel
  return {
    apiKey,
    baseURL,
    model,
    protocol: resolvedProvider.protocol,
    capabilities: resolvedProvider.capabilities,
    flashModel: resolvedFlashModel,
    compactModel: resolvedCompactModel,
    fallbackModel: resolvedFallbackModel,
    // Default to adaptive so the primary LLM thinks before answering. Callers
    // can opt out by passing `{ type: 'disabled' }`.
    thinkingConfig: config.thinkingConfig ?? { type: 'adaptive' },
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
    promptMode:      config.promptMode,
    autonomy:        config.autonomy,
    verifyGate:      config.verifyGate,
    driftGate:       config.driftGate,
    onCheckpointBoundary: config.onCheckpointBoundary,
    initialToolBatchCount: config.initialToolBatchCount,
    initialCheckpointRevision: config.initialCheckpointRevision,
    getExperienceRecallBlock: config.getExperienceRecallBlock,
    initialMessages: config.initialMessages,
    debugMode:       config.debugMode,
    // projectDir: default to cwd so AGENT.md discovery works out-of-the-box
    projectDir: config.projectDir ?? process.cwd(),
  }
}

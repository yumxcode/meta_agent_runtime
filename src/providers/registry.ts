/**
 * Provider Registry — single source of truth for model/provider behaviour.
 *
 * Every provider-specific decision the runtime makes — which wire protocol to
 * speak (Anthropic vs OpenAI), how to authenticate, which betas/thinking params
 * are safe to send, per-model pricing and context windows — is derived from the
 * `PROVIDERS` table below.  Other modules MUST query the helper functions here
 * instead of pattern-matching on model-name prefixes.
 *
 * This module is a dependency leaf: it imports nothing from `core/` or
 * `kernel/`, so both layers can depend on it without cycles.
 *
 * Adding a provider = appending one `ProviderSpec` entry.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Wire format / SDK used to talk to the provider. */
export type Protocol = 'anthropic' | 'openai'

/** Authentication scheme for the Anthropic-protocol path. */
export type AuthScheme = 'x-api-key' | 'bearer'

export type ProviderId = 'anthropic' | 'zhipu' | 'deepseek' | 'qwen' | 'unknown'

/** Feature flags that decide which request fields are safe to send. */
export interface Capabilities {
  /** Anthropic-only betas (interleaved-thinking, token-efficient-tools). */
  anthropicBetas: boolean
  /** Accepts the Anthropic `thinking: { type: 'enabled', budget_tokens }` param. */
  anthropicThinkingParam: boolean
  /** OpenAI-style `reasoning_effort` (DeepSeek and friends). */
  reasoningEffort: boolean
  /** Supports Anthropic prompt-cache control blocks. */
  promptCache: boolean
}

/** USD per million tokens. */
export interface ModelPricing {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Per-model overrides layered on top of the provider defaults. */
export interface ModelSpec {
  contextWindow: number
  maxOutput: number
  pricing: ModelPricing
  /** Optional per-model capability overrides (e.g. a tier with no thinking). */
  capabilities?: Partial<Capabilities>
}

export interface ProviderSpec {
  id: ProviderId
  protocol: Protocol
  auth: AuthScheme
  defaultBaseURL: string
  /** Env vars that select this provider, highest priority first. */
  envKeys: string[]
  /** Substrings that identify this provider from a baseURL. */
  urlMatchers: string[]
  /** Model-name prefixes that identify this provider. */
  modelMatchers: string[]
  models: { default: string; fallback?: string; flash: string }
  capabilities: Capabilities
  /** Per-model table keyed by model-name prefix (longest match wins). */
  modelTable: Record<string, ModelSpec>
}

/** Result of resolving a concrete provider for a request. */
export interface ResolvedProvider {
  provider: ProviderId
  protocol: Protocol
  auth: AuthScheme
  apiKey: string
  baseURL: string
  capabilities: Capabilities
  defaultModel: string
  fallbackModel?: string
  flashModel: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry data
// ─────────────────────────────────────────────────────────────────────────────

const CAP_ANTHROPIC: Capabilities = {
  anthropicBetas: true, anthropicThinkingParam: true, reasoningEffort: false, promptCache: true,
}
const CAP_ZHIPU: Capabilities = {
  // GLM speaks the Anthropic wire format and empirically accepts the thinking
  // param, but rejects Anthropic-only betas and prompt-cache control blocks.
  anthropicBetas: false, anthropicThinkingParam: true, reasoningEffort: false, promptCache: false,
}
const CAP_DEEPSEEK: Capabilities = {
  anthropicBetas: false, anthropicThinkingParam: false, reasoningEffort: true, promptCache: false,
}
const CAP_QWEN: Capabilities = {
  // Qwen rides the DashScope Anthropic-compat endpoint; treat thinking as
  // unsupported until proven (gate it off rather than risk a 400).
  anthropicBetas: false, anthropicThinkingParam: false, reasoningEffort: false, promptCache: false,
}

const CLAUDE_OPUS:   ModelPricing = { input: 15.0, output: 75.0, cacheRead: 1.5,  cacheWrite: 18.75 }
const CLAUDE_SONNET: ModelPricing = { input: 3.0,  output: 15.0, cacheRead: 0.3,  cacheWrite: 3.75 }
const CLAUDE_HAIKU:  ModelPricing = { input: 0.8,  output: 4.0,  cacheRead: 0.08, cacheWrite: 1.0 }

const GLM_STD: ModelPricing = { input: 0.43, output: 1.74, cacheRead: 0.043, cacheWrite: 0.43 }
const GLM_AIR: ModelPricing = { input: 0.11, output: 0.28, cacheRead: 0.011, cacheWrite: 0.11 }

export const PROVIDERS: Record<Exclude<ProviderId, 'unknown'>, ProviderSpec> = {
  anthropic: {
    id: 'anthropic',
    protocol: 'anthropic',
    auth: 'x-api-key',
    defaultBaseURL: 'https://api.anthropic.com',
    envKeys: ['ANTHROPIC_API_KEY'],
    urlMatchers: ['anthropic.com'],
    modelMatchers: ['claude-'],
    models: { default: 'claude-opus-4-6', fallback: 'claude-sonnet-4-6', flash: 'claude-haiku-4-5-20251001' },
    capabilities: CAP_ANTHROPIC,
    modelTable: {
      'claude-opus-4-6':            { contextWindow: 200_000, maxOutput: 131_072, pricing: CLAUDE_OPUS },
      'claude-opus-4-5':            { contextWindow: 200_000, maxOutput: 131_072, pricing: CLAUDE_OPUS },
      'claude-opus':                { contextWindow: 200_000, maxOutput: 131_072, pricing: CLAUDE_OPUS },
      'claude-sonnet-4-6':          { contextWindow: 200_000, maxOutput: 131_072, pricing: CLAUDE_SONNET },
      'claude-sonnet-4-5':          { contextWindow: 200_000, maxOutput: 131_072, pricing: CLAUDE_SONNET },
      'claude-3-7-sonnet-20250219': { contextWindow: 200_000, maxOutput: 65_536,  pricing: CLAUDE_SONNET },
      'claude-3-5-sonnet-20241022': { contextWindow: 200_000, maxOutput: 8_192,   pricing: CLAUDE_SONNET },
      'claude-sonnet':              { contextWindow: 200_000, maxOutput: 65_536,  pricing: CLAUDE_SONNET },
      'claude-haiku-4-5-20251001':  { contextWindow: 200_000, maxOutput: 131_072, pricing: CLAUDE_HAIKU },
      'claude-haiku-4-5':           { contextWindow: 200_000, maxOutput: 131_072, pricing: CLAUDE_HAIKU },
      'claude-3-5-haiku-20241022':  { contextWindow: 200_000, maxOutput: 8_192,   pricing: CLAUDE_HAIKU },
      'claude-3-opus-20240229':     { contextWindow: 200_000, maxOutput: 4_096,   pricing: CLAUDE_OPUS },
    },
  },

  zhipu: {
    id: 'zhipu',
    protocol: 'anthropic',
    auth: 'bearer',
    defaultBaseURL: 'https://open.bigmodel.cn/api/anthropic',
    envKeys: ['ZHIPU_API_KEY', 'ZAI_API_KEY', 'GLM_API_KEY'],
    urlMatchers: ['bigmodel.cn', 'z.ai'],
    modelMatchers: ['glm-'],
    // flash (compact / mode-detect / memory side-calls): glm-5.2 — its 1M window
    // sets the auto-compact trigger at 65% of the effective window (~637k).
    models: { default: 'glm-5.2', fallback: 'glm-4.6', flash: 'glm-5.2' },
    capabilities: CAP_ZHIPU,
    modelTable: {
      // -air entries MUST precede their bare prefixes; longest-match guards this
      // regardless, but keep the order readable.
      'glm-4.5-air': { contextWindow: 128_000, maxOutput: 131_072, pricing: GLM_AIR },
      'glm-5.2':     { contextWindow: 1_000_000, maxOutput: 131_072, pricing: GLM_STD },
      'glm-5.1':     { contextWindow: 1_000_000, maxOutput: 131_072, pricing: GLM_STD },
      'glm-5-turbo': { contextWindow: 200_000, maxOutput: 131_072, pricing: GLM_AIR },
      'glm-4.7':     { contextWindow: 200_000, maxOutput: 131_072, pricing: GLM_STD },
      'glm-4.6':     { contextWindow: 200_000, maxOutput: 131_072, pricing: GLM_STD },
      'glm-4.5':     { contextWindow: 128_000, maxOutput: 131_072, pricing: GLM_STD },
    },
  },

  deepseek: {
    id: 'deepseek',
    protocol: 'openai',
    auth: 'x-api-key',
    defaultBaseURL: 'https://api.deepseek.com',
    envKeys: ['DEEPSEEK_API_KEY'],
    urlMatchers: ['deepseek.com'],
    modelMatchers: ['deepseek-'],
    models: { default: 'deepseek-v4-flash', fallback: 'deepseek-v4-flash', flash: 'deepseek-v4-flash' },
    capabilities: CAP_DEEPSEEK,
    modelTable: {
      // Source: platform.deepseek.com pricing (CNY ÷ 7.2 → USD/M tokens)
      'deepseek-v4-flash': { contextWindow: 1_000_000, maxOutput: 131_072, pricing: { input: 0.1389, output: 0.2778, cacheRead: 0.00278, cacheWrite: 0.1389 } },
      'deepseek-v4-pro':   { contextWindow: 1_000_000, maxOutput: 131_072, pricing: { input: 1.6667, output: 3.3333, cacheRead: 0.01389, cacheWrite: 1.6667 } },
      'deepseek-v3':       { contextWindow: 1_000_000, maxOutput: 131_072, pricing: { input: 0.1389, output: 0.2778, cacheRead: 0.00278, cacheWrite: 0.1389 } },
      'deepseek-r1':       { contextWindow: 1_000_000, maxOutput: 131_072, pricing: { input: 1.6667, output: 3.3333, cacheRead: 0.01389, cacheWrite: 1.6667 } },
      'deepseek-chat':     { contextWindow: 1_000_000, maxOutput: 131_072, pricing: { input: 0.1389, output: 0.2778, cacheRead: 0.00278, cacheWrite: 0.1389 } },
      'deepseek-reasoner': { contextWindow: 1_000_000, maxOutput: 131_072, pricing: { input: 1.6667, output: 3.3333, cacheRead: 0.01389, cacheWrite: 1.6667 } },
    },
  },

  qwen: {
    id: 'qwen',
    protocol: 'anthropic',
    auth: 'x-api-key',
    defaultBaseURL: 'https://dashscope.aliyuncs.com/apps/anthropic',
    envKeys: ['QWEN_API_KEY'],
    urlMatchers: ['dashscope'],
    modelMatchers: ['qwen-', 'qwen3', 'qwq'],
    models: { default: 'qwen-plus', fallback: 'qwen-max', flash: 'qwen-plus' },
    capabilities: CAP_QWEN,
    modelTable: {
      // Source: Alibaba Cloud Model Studio / DashScope published USD pricing.
      'qwen-plus': { contextWindow: 1_000_000, maxOutput: 32_768, pricing: { input: 0.26, output: 0.78, cacheRead: 0.026, cacheWrite: 0.26 } },
      'qwen-max':  { contextWindow: 262_144,   maxOutput: 32_768, pricing: { input: 0.78, output: 3.90, cacheRead: 0.078, cacheWrite: 0.78 } },
    },
  },
}

/** Default context window / pricing for unknown models. */
export const DEFAULT_CONTEXT_WINDOW = 200_000
export const DEFAULT_PRICING: ModelPricing = { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 }

const PROVIDER_LIST: ProviderSpec[] = Object.values(PROVIDERS)

// ─────────────────────────────────────────────────────────────────────────────
// Inference helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Infer the provider from a base URL.  Returns 'unknown' if no match. */
export function inferProviderFromURL(url: string | undefined): ProviderId {
  if (!url) return 'unknown'
  for (const spec of PROVIDER_LIST) {
    if (spec.urlMatchers.some(m => url.includes(m))) return spec.id
  }
  return 'unknown'
}

/** Infer the provider from a model name.  Returns 'unknown' if no match. */
export function inferProviderFromModel(model: string | undefined): ProviderId {
  if (!model) return 'unknown'
  for (const spec of PROVIDER_LIST) {
    if (spec.modelMatchers.some(m => model.startsWith(m))) return spec.id
  }
  return 'unknown'
}

function specOf(id: ProviderId): ProviderSpec {
  return id === 'unknown' ? PROVIDERS.anthropic : PROVIDERS[id]
}

/** Look up the most specific ModelSpec for a model name (longest prefix wins). */
export function findModelSpec(model: string | undefined): ModelSpec | undefined {
  if (!model) return undefined
  let best: ModelSpec | undefined
  let bestLen = -1
  for (const spec of PROVIDER_LIST) {
    for (const [key, ms] of Object.entries(spec.modelTable)) {
      if (model.startsWith(key) && key.length > bestLen) {
        best = ms
        bestLen = key.length
      }
    }
  }
  return best
}

// ─────────────────────────────────────────────────────────────────────────────
// Public lookups used by other modules
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which wire protocol to speak for a request.
 * baseURL (when it identifies a provider) wins over the model name, so a custom
 * deepleek.com deployment routes correctly even with an unusual model name.
 */
export function getModelProtocol(model: string, baseURL?: string): Protocol {
  const fromUrl = inferProviderFromURL(baseURL)
  if (fromUrl !== 'unknown') return PROVIDERS[fromUrl].protocol
  const fromModel = inferProviderFromModel(model)
  if (fromModel !== 'unknown') return PROVIDERS[fromModel].protocol
  return 'anthropic'
}

/** Per-model pricing, falling back to a Sonnet-class default. */
export function getModelPricing(model: string): ModelPricing {
  return findModelSpec(model)?.pricing ?? DEFAULT_PRICING
}

/** Per-model context window, falling back to 200K. */
export function getModelContextWindow(model: string): number {
  return findModelSpec(model)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
}

/**
 * Effective capabilities for a model: provider defaults, with any per-model
 * overrides layered on top.  baseURL refines provider detection when present.
 */
export function getModelCapabilities(model: string, baseURL?: string): Capabilities {
  const id = inferProviderFromURL(baseURL) !== 'unknown'
    ? inferProviderFromURL(baseURL)
    : inferProviderFromModel(model)
  const base = specOf(id).capabilities
  const override = findModelSpec(model)?.capabilities
  return override ? { ...base, ...override } : base
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider resolution
// ─────────────────────────────────────────────────────────────────────────────

function envKeyFor(spec: ProviderSpec): string | undefined {
  for (const k of spec.envKeys) {
    const v = process.env[k]
    if (v) return v
  }
  return undefined
}

function build(spec: ProviderSpec, apiKey: string, baseURL: string): ResolvedProvider {
  return {
    provider: spec.id,
    protocol: spec.protocol,
    auth: spec.auth,
    apiKey,
    baseURL,
    capabilities: spec.capabilities,
    defaultModel: spec.models.default,
    fallbackModel: spec.models.fallback,
    flashModel: spec.models.flash,
  }
}

/**
 * Resolve a concrete provider for the given inputs.
 *
 * Precedence:
 *   1. Explicit baseURL → provider inferred from the URL (caller's apiKey, or
 *      that provider's env key).
 *   2. Explicit apiKey, no baseURL → provider inferred from the MODEL name.
 *      This fixes the bug where `--api-key <deepseek-key> --model deepseek-…`
 *      silently fell through to Anthropic.
 *   3. No apiKey → env-var detection, in registry order
 *      (zhipu → deepseek → qwen → anthropic).
 *   4. Nothing → Anthropic default.
 */
export function resolveProvider(input: {
  apiKey?: string
  baseURL?: string
  model?: string
}): ResolvedProvider {
  // 1. Explicit baseURL drives detection.
  if (input.baseURL) {
    const id = inferProviderFromURL(input.baseURL)
    const spec = specOf(id)
    const apiKey = input.apiKey ?? envKeyFor(spec) ?? ''
    return build(spec, apiKey, input.baseURL)
  }

  // 2. Explicit apiKey with no baseURL → infer provider from the model name.
  if (input.apiKey) {
    const id = inferProviderFromModel(input.model)
    const spec = specOf(id)
    return build(spec, input.apiKey, spec.defaultBaseURL)
  }

  // 3. Env-var detection, in registry order.
  for (const id of ['zhipu', 'deepseek', 'qwen', 'anthropic'] as const) {
    const spec = PROVIDERS[id]
    const key = envKeyFor(spec)
    if (key) return build(spec, key, spec.defaultBaseURL)
  }

  // 4. Anthropic default (no key available).
  return build(PROVIDERS.anthropic, '', PROVIDERS.anthropic.defaultBaseURL)
}

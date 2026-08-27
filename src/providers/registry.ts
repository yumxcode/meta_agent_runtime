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
  // NOTE: a `promptCache` flag used to live here. It was declared and set per
  // provider but never read anywhere in the codebase — a dead capability bit
  // that implied behaviour the runtime does not have (nothing emits
  // `cache_control`, for ANY provider, Anthropic included). Removed rather than
  // left misleading; see docs/reviews/graph-loop-token-cost-audit-2026-07-27.md
  // §2.R2-RETRACTED.
  //
  // If explicit prompt-cache breakpoints are ever implemented, the gate belongs
  // here and would be read where the Anthropic request body is assembled
  // (kernel/api/AnthropicClient). Measured 2026-07-27 via
  // scripts/probe-glm-cache.mjs: Zhipu already does implicit server-side prefix
  // caching (cache_read_input_tokens > 0 with no cache_control sent), and
  // sending cache_control changed nothing, so a flag alone buys nothing there.
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
  anthropicBetas: true, anthropicThinkingParam: true, reasoningEffort: false,
}
const CAP_ZHIPU: Capabilities = {
  // GLM speaks the Anthropic wire format and empirically accepts the thinking
  // param, but rejects Anthropic-only betas. (It does NOT reject cache_control
  // — measured 2026-07-27, HTTP 200; an earlier comment here claimed otherwise.
  // Nothing sends cache_control anyway; Zhipu caches prefixes implicitly.)
  anthropicBetas: false, anthropicThinkingParam: true, reasoningEffort: false,
}
const CAP_DEEPSEEK: Capabilities = {
  anthropicBetas: false, anthropicThinkingParam: false, reasoningEffort: true,
}
const CAP_QWEN: Capabilities = {
  // Qwen rides the DashScope Anthropic-compat endpoint; treat thinking as
  // unsupported until proven (gate it off rather than risk a 400).
  anthropicBetas: false, anthropicThinkingParam: false, reasoningEffort: false,
}

const CLAUDE_OPUS:   ModelPricing = { input: 15.0, output: 75.0, cacheRead: 1.5,  cacheWrite: 18.75 }
const CLAUDE_SONNET: ModelPricing = { input: 3.0,  output: 15.0, cacheRead: 0.3,  cacheWrite: 3.75 }
const CLAUDE_HAIKU:  ModelPricing = { input: 0.8,  output: 4.0,  cacheRead: 0.08, cacheWrite: 1.0 }

const GLM_STD: ModelPricing = { input: 0.43, output: 1.74, cacheRead: 0.043, cacheWrite: 0.43 }
/** Family-rule pricing for unpinned DeepSeek versions; matches deepseek-v4-flash. */
const DEEPSEEK_STD: ModelPricing = { input: 0.1389, output: 0.2778, cacheRead: 0.00278, cacheWrite: 0.1389 }
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
      'glm-5.3':     { contextWindow: 1_000_000, maxOutput: 131_072, pricing: GLM_STD },
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

/**
 * Canonical form for lookup: lower-cased, vendor prefix removed.
 *
 * Both normalisations fix silent misses that were indistinguishable from a
 * real match, because the fallback window happened to equal a real model's:
 * `GLM-4.6` and `zhipu/glm-5.2` both missed every table key and landed on the
 * 200k default.
 */
export function normalizeModelName(model: string): string {
  const withoutVendor = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
  return withoutVendor.trim().toLowerCase()
}

/**
 * Version-aware family rules, consulted when the exact table misses.
 *
 * An enumerated table cannot keep up with releases: every new version silently
 * became "unknown" and inherited a 200k window and Claude pricing. `glm-5.3`
 * was 1M in reality, 200k here, and it compacted at 117k while its cost was
 * tracked at roughly 7× the true rate — a wrong budget as well as a wrong
 * window, both invisible.
 *
 * Rules key off the family and the MAJOR/MINOR version, so a future `glm-5.9`
 * or `glm-6` resolves correctly without a code change. They are deliberately
 * only used when nothing more specific matched, so a pinned table entry always
 * wins over a rule.
 */
interface ModelFamilyRule {
  /** Stable id, reported as the resolution source for diagnostics. */
  id: string
  /** Must capture the version as groups 1 (major) and optionally 2 (minor). */
  test: RegExp
  resolve: (major: number, minor: number) => ModelSpec
}

const MODEL_FAMILY_RULES: ModelFamilyRule[] = [
  {
    id: 'glm',
    test: /^glm-(\d+)(?:\.(\d+))?/,
    resolve: (major, minor) => ({
      // 5.x and later ship a 1M window; 4.6/4.7 were 200k; earlier 4.x were 128k.
      contextWindow: major >= 5 ? 1_000_000 : minor >= 6 ? 200_000 : 128_000,
      maxOutput: 131_072,
      pricing: GLM_STD,
    }),
  },
  {
    id: 'deepseek',
    test: /^deepseek[-.]?(\d+)?/,
    // The whole current DeepSeek line is 1M.
    resolve: () => ({ contextWindow: 1_000_000, maxOutput: 131_072, pricing: DEEPSEEK_STD }),
  },
  {
    id: 'claude',
    test: /^claude-(\d+)?/,
    // Anthropic's published default remains 200k; a longer window is opt-in per
    // deployment, so it is not assumed here.
    resolve: () => ({ contextWindow: 200_000, maxOutput: 65_536, pricing: CLAUDE_SONNET }),
  },
]

/** How a model's spec was resolved. Reported so a fallback is never silent. */
export type ModelSpecSource = 'exact' | 'family' | 'default'

export interface ResolvedModelSpec {
  spec: ModelSpec
  source: ModelSpecSource
  /** Table key or family rule id that produced it; absent for 'default'. */
  matchedBy?: string
}

/**
 * Resolve a model's spec, saying how it got there.
 *
 * Order: exact table (longest prefix) → family rule → default. The `source` is
 * what makes a misconfigured model name diagnosable: a 200k window from
 * `source: 'default'` means "we do not know this model", which used to be
 * indistinguishable from a genuine 200k match.
 */
export function resolveModelSpec(model: string | undefined): ResolvedModelSpec {
  if (!model) return { spec: { contextWindow: DEFAULT_CONTEXT_WINDOW, maxOutput: 32_768, pricing: DEFAULT_PRICING }, source: 'default' }

  const normalized = normalizeModelName(model)

  let best: ModelSpec | undefined
  let bestKey = ''
  for (const provider of PROVIDER_LIST) {
    for (const [key, ms] of Object.entries(provider.modelTable)) {
      if (normalized.startsWith(key) && key.length > bestKey.length) {
        best = ms
        bestKey = key
      }
    }
  }
  if (best) return { spec: best, source: 'exact', matchedBy: bestKey }

  for (const rule of MODEL_FAMILY_RULES) {
    const match = normalized.match(rule.test)
    if (!match) continue
    const major = Number(match[1] ?? 0)
    const minor = Number(match[2] ?? 0)
    return {
      spec: rule.resolve(Number.isFinite(major) ? major : 0, Number.isFinite(minor) ? minor : 0),
      source: 'family',
      matchedBy: rule.id,
    }
  }

  return {
    spec: { contextWindow: DEFAULT_CONTEXT_WINDOW, maxOutput: 32_768, pricing: DEFAULT_PRICING },
    source: 'default',
  }
}

/** Look up the most specific ModelSpec for a model name. */
export function findModelSpec(model: string | undefined): ModelSpec | undefined {
  if (!model) return undefined
  const resolved = resolveModelSpec(model)
  return resolved.source === 'default' ? undefined : resolved.spec
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
const warnedUnknownModels = new Set<string>()

export function getModelContextWindow(model: string): number {
  const resolved = resolveModelSpec(model)
  if (resolved.source === 'default' && model && !warnedUnknownModels.has(model)) {
    warnedUnknownModels.add(model)
    // Said out loud, once per model. The previous silence was the actual
    // problem: an unrecognised name inherited a 200k window that looked exactly
    // like a real 200k model, so a mistyped or newly released model compacted
    // at 117k with nothing anywhere reporting why.
    console.warn(
      `[meta-agent] unknown model '${model}': assuming a ${DEFAULT_CONTEXT_WINDOW / 1000}k context window ` +
      `and default pricing. Set META_AGENT_AUTO_COMPACT_WINDOW to override the window if this is wrong.`,
    )
  }
  return resolved.spec.contextWindow
}

/** Reset the once-per-model warning. Tests only. */
export function clearUnknownModelWarningsForTests(): void {
  warnedUnknownModels.clear()
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

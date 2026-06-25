/**
 * RuntimeEnv — the single, auditable entry point for environment-variable
 * configuration.
 *
 * Why this module exists
 * ----------------------
 * Configuration env vars used to be read ad-hoc with `process.env['X']` and
 * bespoke parsing scattered across ~two dozen modules. That made the effective
 * config surface impossible to audit, inconsistent in how it parsed/validated
 * values, and hard to document. This module centralises:
 *   - the NAME of every config env var (see ENV_REGISTRY),
 *   - its TYPE, DEFAULT, valid RANGE, and human-readable MEANING,
 *   - a single typed accessor per var with consistent validation.
 *
 * Live reads, not a frozen snapshot
 * ---------------------------------
 * Accessors read `process.env` on each call rather than snapshotting once at
 * import. A hard snapshot would break the many unit tests (and embeddings) that
 * legitimately set env vars per-case AFTER import. Parsing/validation/defaults
 * are still centralised here, which is the property that actually matters for
 * auditability and consistency. Modules MUST go through this module instead of
 * reading process.env directly.
 *
 * Out of scope
 * ------------
 * Provider CREDENTIAL discovery (ZHIPU/DEEPSEEK/QWEN/ANTHROPIC keys, baseURL)
 * stays in the Provider Registry / auth layer: those keys are looked up by a
 * provider SPEC table that is itself the single source of truth for credentials,
 * and they participate in provider auto-detection rather than plain config.
 */

// ── Generic typed parsers (live process.env) ─────────────────────────────────

/** Raw string, trimmed; undefined when unset or empty after trim. */
export function readStringEnv(name: string): string | undefined {
  const raw = process.env[name]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Truthy PRESENCE test: any non-empty value counts as "set" (mirrors `!!env`). */
export function isEnvSet(name: string): boolean {
  return !!process.env[name]
}

/** Exact-match flag, e.g. `FOO=1`. Accepts any of the supplied truthy literals. */
export function envEquals(name: string, ...truthy: string[]): boolean {
  const v = process.env[name]
  return v !== undefined && truthy.includes(v)
}

/**
 * Integer env, or undefined when unset / unparyable / out of range. `min`/`max`
 * are inclusive bounds applied AFTER parsing; an out-of-range value yields
 * undefined (treated as "not configured") so the caller's default wins.
 */
export function readIntEnv(
  name: string,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return undefined
  if (opts.min !== undefined && n < opts.min) return undefined
  if (opts.max !== undefined && n > opts.max) return undefined
  return n
}

/**
 * Integer env clamped into [min,max] with a guaranteed fallback. Unparyable
 * values fall back; in-range values pass through; out-of-range values clamp.
 * Matches the historical `envInt(name, fallback, min, max)` helper semantics.
 */
export function readIntEnvOr(
  name: string,
  fallback: number,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Float env within (optional) bounds, else undefined. */
export function readFloatEnv(
  name: string,
  opts: { gt?: number; lte?: number; min?: number; max?: number } = {},
): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number.parseFloat(raw)
  if (!Number.isFinite(n)) return undefined
  if (opts.gt !== undefined && !(n > opts.gt)) return undefined
  if (opts.lte !== undefined && !(n <= opts.lte)) return undefined
  if (opts.min !== undefined && n < opts.min) return undefined
  if (opts.max !== undefined && n > opts.max) return undefined
  return n
}

// ── Named accessors (one per known config var) ───────────────────────────────
//
// Each getter encapsulates the EXACT rule for its variable so call sites never
// re-implement parsing. Keep ENV_REGISTRY below in sync when adding entries.

export const RuntimeEnv = {
  // ── Context / compaction ──────────────────────────────────────────────────
  /** Hard override of a model's context window (tokens). Positive int. */
  autoCompactWindowOverride(): number | undefined {
    return readIntEnv('META_AGENT_AUTO_COMPACT_WINDOW', { min: 1 })
  },
  /** Auto-compact trigger as a fraction of the window. Valid range (0, 1]. */
  autoCompactPctOverride(): number | undefined {
    return readFloatEnv('META_AGENT_AUTOCOMPACT_PCT_OVERRIDE', { gt: 0, lte: 1 })
  },
  /** Optional hard token cap that compacts earlier than the % rule. Positive int. */
  longContextAutoCompactCap(): number | undefined {
    return readIntEnv('META_AGENT_LONG_CONTEXT_AUTOCOMPACT_THRESHOLD', { min: 1 })
  },
  /** True when auto-compaction is disabled via either legacy flag. */
  compactDisabled(): boolean {
    return isEnvSet('DISABLE_COMPACT') || isEnvSet('DISABLE_AUTO_COMPACT')
  },

  // ── Jobs / executor ───────────────────────────────────────────────────────
  /** LocalExecutor default watchdog budget (ms). `0` disables. */
  jobTimeoutMs(fallback: number): number {
    return readIntEnvOr('META_AGENT_JOB_TIMEOUT_MS', fallback, 0)
  },
  /** JobManager terminal-job LRU cap. `>= 0`. */
  keepTerminalJobs(fallback: number): number {
    const n = readIntEnv('META_AGENT_KEEP_TERMINAL_JOBS', { min: 0 })
    return n ?? fallback
  },

  // ── Permissions ───────────────────────────────────────────────────────────
  /** Skip on-disk permission configs (hermetic mode) when set. */
  ignoreUserPermissions(): boolean {
    return envEquals('META_AGENT_IGNORE_USER_PERMISSIONS', '1', 'true')
  },

  // ── Web fetch / search ────────────────────────────────────────────────────
  /** Override the User-Agent for web_fetch. Falls back to the provided default. */
  webFetchUserAgent(defaultUa: string): string {
    return readStringEnv('META_AGENT_WEB_FETCH_UA') ?? defaultUa
  },
  /** Allow spoofed client IP headers in web_fetch (testing only). */
  trustFakeIp(): boolean {
    return envEquals('META_AGENT_TRUST_FAKE_IP', '1')
  },
  /** Tavily search API key (preferred web_search provider). */
  tavilyApiKey(): string | undefined {
    return readStringEnv('TAVILY_API_KEY')
  },
  /** Pinned web_search provider id (lowercased), or '' when unpinned. */
  searchProviderPin(): string {
    return (readStringEnv('META_AGENT_SEARCH_PROVIDER') ?? '').toLowerCase()
  },

  // ── Coordination ──────────────────────────────────────────────────────────
  /** Campaign eval-cache capacity. Positive int. */
  campaignEvalCacheCap(): number | undefined {
    return readIntEnv('META_AGENT_CAMPAIGN_EVAL_CACHE', { min: 1 })
  },

  // ── Tool execution ────────────────────────────────────────────────────────
  /** Global per-tool timeout (ms). `0` disables. Clamped >= 0. */
  toolTimeoutMs(fallback: number): number {
    return readIntEnvOr('META_AGENT_TOOL_TIMEOUT_MS', fallback, 0)
  },
  /** Auto-mode circuit cap on timed-out-but-still-running tools. Clamped >= 1. */
  maxTimedOutRunningTools(fallback: number): number {
    return readIntEnvOr('META_AGENT_MAX_TIMED_OUT_RUNNING_TOOLS', fallback, 1)
  },
  /** Max concurrent tool_use executions. Clamped [1,64] (CC parity). */
  toolUseConcurrency(fallback: number): number {
    return readIntEnvOr('META_AGENT_MAX_TOOL_USE_CONCURRENCY', fallback, 1, 64)
  },
  /** Max chars of a bash tool's combined output. Clamped [1KiB, 1MiB]. */
  maxToolOutputChars(fallback: number): number {
    return readIntEnvOr('META_AGENT_MAX_TOOL_OUTPUT_CHARS', fallback, 1024, 1024 * 1024)
  },
  /** Max chars of a tool RESULT surfaced to the model. Clamped [1KiB, 1MiB]. */
  maxToolResultChars(fallback: number): number {
    return readIntEnvOr('META_AGENT_MAX_TOOL_RESULT_CHARS', fallback, 1024, 1024 * 1024)
  },
  /** Whether max_output_tokens is pinned by the CC env var (disables escalation). */
  maxOutputTokensPinned(): boolean {
    return isEnvSet('META_AGENT_MAX_OUTPUT_TOKENS')
  },

  // ── CLI ───────────────────────────────────────────────────────────────────
  /** Max visible chars before the CLI truncates a rendered block. [10k, 2M]. */
  cliMaxVisibleChars(fallback: number): number {
    return readIntEnvOr('META_AGENT_CLI_MAX_VISIBLE_CHARS', fallback, 10_000, 2_000_000)
  },

  // ── Session resume ────────────────────────────────────────────────────────
  /**
   * Max messages loaded VERBATIM when resuming a session. Unset → unlimited
   * (full history is replayed; runtime auto-compaction shrinks it if it exceeds
   * the model window). Set a positive int to cap and fold older history into a
   * single local summary instead.
   */
  resumeMaxMessages(): number {
    return readIntEnv('META_AGENT_MAX_RESUME_MESSAGES', { min: 1 }) ?? Number.POSITIVE_INFINITY
  },
  /** Max bytes read from a session history file on resume (safety guard). */
  resumeMaxBytes(fallback: number): number {
    return readIntEnvOr('META_AGENT_MAX_RESUME_BYTES', fallback, 1)
  },
} as const

// ── Documentation registry (for `--help` / docs / auditing) ──────────────────

export interface EnvVarDoc {
  name: string
  type: 'int' | 'float' | 'flag' | 'string'
  default: string
  description: string
}

/**
 * Authoritative list of the config env vars this runtime reads. Keep in sync
 * with the accessors above. (Provider credential keys are intentionally omitted
 * — see the module header.)
 */
export const ENV_REGISTRY: readonly EnvVarDoc[] = [
  { name: 'META_AGENT_AUTO_COMPACT_WINDOW', type: 'int', default: 'model window', description: 'Override the context window size (tokens) used for compaction math.' },
  { name: 'META_AGENT_AUTOCOMPACT_PCT_OVERRIDE', type: 'float', default: '0.65', description: 'Fraction of the window at which auto-compaction triggers. Range (0,1].' },
  { name: 'META_AGENT_LONG_CONTEXT_AUTOCOMPACT_THRESHOLD', type: 'int', default: 'off', description: 'Hard token cap to compact earlier than the percentage rule.' },
  { name: 'DISABLE_COMPACT', type: 'flag', default: 'off', description: 'Disable auto-compaction entirely.' },
  { name: 'DISABLE_AUTO_COMPACT', type: 'flag', default: 'off', description: 'Alias of DISABLE_COMPACT.' },
  { name: 'META_AGENT_JOB_TIMEOUT_MS', type: 'int', default: '1800000', description: 'LocalExecutor watchdog budget per job (ms). 0 disables.' },
  { name: 'META_AGENT_KEEP_TERMINAL_JOBS', type: 'int', default: '200', description: 'Max terminal jobs retained in memory (LRU).' },
  { name: 'META_AGENT_IGNORE_USER_PERMISSIONS', type: 'flag', default: 'off', description: 'Ignore on-disk permission configs (hermetic mode).' },
  { name: 'META_AGENT_WEB_FETCH_UA', type: 'string', default: 'built-in UA', description: 'User-Agent header for web_fetch.' },
  { name: 'META_AGENT_TRUST_FAKE_IP', type: 'flag', default: 'off', description: 'Allow spoofed client IP headers in web_fetch (testing).' },
  { name: 'TAVILY_API_KEY', type: 'string', default: 'unset', description: 'Tavily key for the preferred web_search provider.' },
  { name: 'META_AGENT_SEARCH_PROVIDER', type: 'string', default: 'auto', description: 'Pin the web_search provider (e.g. "tavily", "anthropic").' },
  { name: 'META_AGENT_CAMPAIGN_EVAL_CACHE', type: 'int', default: '32', description: 'Campaign eval-cache capacity.' },
  { name: 'META_AGENT_MAX_CONCURRENT_SUB_AGENTS', type: 'int', default: '4 (auto: 3)', description: 'Max concurrently running sub-agents.' },
  { name: 'META_AGENT_MAX_QUEUED_SUB_AGENTS', type: 'int', default: '64', description: 'Max queued sub-agents beyond the running cap. Range [0,10000].' },
  { name: 'META_AGENT_SUB_AGENT_START_DELAY_MS', type: 'int', default: '50', description: 'Stagger delay before starting each queued sub-agent (ms).' },
  { name: 'META_AGENT_MAX_TOTAL_SUB_AGENT_BUDGET_USD', type: 'float', default: 'unlimited (auto: 5)', description: 'Total spend cap across all sub-agents (USD).' },
  { name: 'META_AGENT_HOME', type: 'string', default: '~/.meta-agent', description: 'Root directory for all persisted meta-agent state.' },
  { name: 'META_AGENT_TOOL_TIMEOUT_MS', type: 'int', default: '180000', description: 'Global per-tool timeout (ms). 0 disables.' },
  { name: 'META_AGENT_MAX_TIMED_OUT_RUNNING_TOOLS', type: 'int', default: '3', description: 'Auto-mode circuit cap on timed-out-but-running tools.' },
  { name: 'META_AGENT_MAX_TOOL_USE_CONCURRENCY', type: 'int', default: '10', description: 'Max concurrent tool_use executions. Range [1,64].' },
  { name: 'META_AGENT_MAX_TOOL_OUTPUT_CHARS', type: 'int', default: '102400', description: 'Max chars of a bash tool output. Range [1KiB,1MiB].' },
  { name: 'META_AGENT_MAX_TOOL_RESULT_CHARS', type: 'int', default: '204800', description: 'Max chars of a tool result surfaced to the model. Range [1KiB,1MiB].' },
  { name: 'META_AGENT_MAX_OUTPUT_TOKENS', type: 'flag', default: 'unset', description: 'When set, pins max output tokens and disables auto-escalation.' },
  { name: 'META_AGENT_CLI_MAX_VISIBLE_CHARS', type: 'int', default: '50000', description: 'Max visible chars before the CLI truncates a block. Range [10k,2M].' },
  { name: 'META_AGENT_MAX_RESUME_MESSAGES', type: 'int', default: 'unlimited', description: 'Max messages loaded verbatim on resume; older history is folded into one summary. Unset = full history.' },
  { name: 'META_AGENT_MAX_RESUME_BYTES', type: 'int', default: '67108864', description: 'Max bytes read from a session history file on resume (safety guard).' },
] as const

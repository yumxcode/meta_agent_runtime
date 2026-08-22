/**
 * timeouts — the single resolution point for every tunable timeout.
 *
 * ## Why this exists
 *
 * Before this module, timeouts were scattered across three unrelated
 * mechanisms with no common precedence rule:
 *
 *   - hard-coded module constants (the LLM request timeout was not even that:
 *     it was whatever the vendor SDK defaulted to, 10 minutes);
 *   - ad-hoc `process.env` reads, some routed through RuntimeEnv and some not
 *     (`META_AGENT_MCP_TIMEOUT_MS` was read with a private `envInt` helper, so
 *     it appeared in neither ENV_REGISTRY nor the docs);
 *   - per-call-site literals (`timeoutMs: 30_000` copy-pasted at eight flash
 *     call sites).
 *
 * None of them was reachable from the config file: `ModelConfigFile` accepted
 * exactly seven STRING fields and silently dropped everything else, so a user
 * who wrote `"toolTimeoutMs": 60000` got no effect and no warning.
 *
 * ## Precedence
 *
 *   config file (`timeouts` section)  >  environment variable  >  built-in default
 *
 * This matches the convention already documented for model fields
 * (`modelConfigFile.ts`: "config file > CLI flags > built-in provider defaults").
 *
 * ## Config file shape
 *
 * ```jsonc
 * {
 *   "mainModel": "glm-5.2",
 *   "timeouts": {
 *     "llmFirstTokenMs": 90000,
 *     "llmIdleMs":       60000,
 *     "compactMs":      720000,
 *     "flashTtftMs":     30000,
 *     "flashTokensPerSec":  20,
 *     "toolMs":         180000,
 *     "mcpMs":           60000,
 *     "mcpStdioMs":      60000,
 *     "jobMs":         1800000,
 *     "verifyMaxDurationMs": 1800000
 *   }
 * }
 * ```
 *
 * Layered like every other config value (session > project > global) — see
 * `configureTimeouts()`.
 */

// NOTE: this module deliberately does NOT go through RuntimeEnv. RuntimeEnv
// lives in infra/ and must not reach up into core/ (where the config file
// reader lives), so routing config-file precedence through it would invert the
// layering. Instead the env names live here in FIELD_SPECS, and ENV_REGISTRY
// (infra/env/RuntimeEnv.ts) documents them for `--help` / the docs.

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

/** Every tunable timeout, in ms (except the tokens/sec rate). */
export interface TimeoutConfig {
  /**
   * Streaming LLM call: budget from request start to the FIRST stream event.
   * Sized for a long-context prefill, which dominates time-to-first-token at
   * the compaction threshold — well above the ~30 s seen on a warm short call.
   */
  llmFirstTokenMs: number
  /**
   * Streaming LLM call: maximum silence BETWEEN two stream events. At a normal
   * ~20 tok/s the gap is sub-second, so a minute of silence is unambiguously a
   * stalled gateway rather than a slow model.
   *
   * There is deliberately NO total cap on a streaming call: the default
   * `maxTokens` is 131,072, which at 20 tok/s is ~109 minutes of legitimate
   * generation. A wall-clock cap would kill real work; an idle cap does not.
   */
  llmIdleMs: number
  /**
   * Compaction side-call (non-streaming, so this bounds the WHOLE call).
   * COMPACT_MAX_TOKENS is 12,000, which at 20 tok/s is 600 s of generation
   * alone — the vendor SDK's 600 s default left zero room for the prefill of a
   * nearly-full context window.
   */
  compactMs: number
  /** Flash side-calls: the time-to-first-token half of the derived budget. */
  flashTtftMs: number
  /** Flash side-calls: assumed output rate used to size the generation half. */
  flashTokensPerSec: number
  /** Global per-tool execution timeout. `0` disables. */
  toolMs: number
  /** One HTTP MCP JSON-RPC request. */
  mcpMs: number
  /** One stdio MCP JSON-RPC request. */
  mcpStdioMs: number
  /** LocalExecutor per-job watchdog. `0` disables. */
  jobMs: number
  /** Wall-clock cap for one auto-mode verify judge. */
  verifyMaxDurationMs: number
  /**
   * Wall-clock cap for one auto-mode drift judge.
   *
   * Must be a real, KNOWN value rather than an implicit sub-agent default: the
   * drift gate derives its own polling ceiling from it, and the two silently
   * disagreeing is what let a slow-but-healthy judge be recorded as
   * "unavailable" (see DriftAgent.resolveDriftLimits).
   */
  driftMaxDurationMs: number
}

export const TIMEOUT_DEFAULTS: Readonly<TimeoutConfig> = Object.freeze({
  llmFirstTokenMs:     90_000,
  llmIdleMs:           60_000,
  compactMs:          720_000,   // 12 min
  flashTtftMs:         30_000,
  flashTokensPerSec:       20,
  toolMs:             180_000,
  mcpMs:               60_000,
  mcpStdioMs:          60_000,
  jobMs:            1_800_000,
  verifyMaxDurationMs: 1_800_000,
  driftMaxDurationMs:  1_800_000,
})

/** Env var backing each field, plus its accepted range. */
const FIELD_SPECS: Readonly<Record<keyof TimeoutConfig, {
  env: string
  min: number
  max: number
}>> = Object.freeze({
  llmFirstTokenMs:     { env: 'META_AGENT_LLM_FIRST_TOKEN_TIMEOUT_MS', min: 1_000, max: 3_600_000 },
  llmIdleMs:           { env: 'META_AGENT_LLM_IDLE_TIMEOUT_MS',        min: 1_000, max: 3_600_000 },
  compactMs:           { env: 'META_AGENT_COMPACT_TIMEOUT_MS',         min: 10_000, max: 3_600_000 },
  flashTtftMs:         { env: 'META_AGENT_FLASH_TTFT_MS',              min: 1_000, max: 600_000 },
  flashTokensPerSec:   { env: 'META_AGENT_FLASH_TOKENS_PER_SEC',       min: 1,     max: 10_000 },
  toolMs:              { env: 'META_AGENT_TOOL_TIMEOUT_MS',            min: 0,     max: 3_600_000 },
  mcpMs:               { env: 'META_AGENT_MCP_TIMEOUT_MS',             min: 1_000, max: 600_000 },
  mcpStdioMs:          { env: 'META_AGENT_MCP_STDIO_TIMEOUT_MS',       min: 100,   max: 600_000 },
  jobMs:               { env: 'META_AGENT_JOB_TIMEOUT_MS',             min: 0,     max: 86_400_000 },
  verifyMaxDurationMs: { env: 'META_AGENT_VERIFY_MAX_DURATION_MS',     min: 10_000, max: 3_600_000 },
  driftMaxDurationMs:  { env: 'META_AGENT_DRIFT_MAX_DURATION_MS',      min: 10_000, max: 3_600_000 },
})

export const TIMEOUT_FIELD_NAMES = Object.keys(TIMEOUT_DEFAULTS) as (keyof TimeoutConfig)[]

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

function warn(msg: string): void {
  try { process.stderr.write(`meta-agent: ${msg}\n`) } catch { /* ignore */ }
}

/**
 * Validate one raw config-file value. Out-of-range / non-numeric values are
 * REJECTED with a warning rather than clamped: a user who wrote `"toolMs": -1`
 * has a bug in their config, and silently turning it into `0` (which DISABLES
 * the tool timeout) would be a dangerous reinterpretation.
 */
function coerceField(
  field: keyof TimeoutConfig,
  value: unknown,
  sourceLabel: string,
): number | undefined {
  if (value === undefined || value === null) return undefined
  const spec = FIELD_SPECS[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    warn(`${sourceLabel} timeouts.${field} must be a finite number — ignoring it.`)
    return undefined
  }
  const n = Math.floor(value)
  if (n < spec.min || n > spec.max) {
    warn(`${sourceLabel} timeouts.${field}=${value} is outside [${spec.min}, ${spec.max}] — ignoring it.`)
    return undefined
  }
  return n
}

/**
 * Extract and validate the `timeouts` section from a raw parsed config object.
 * Unknown keys inside the section are reported — silently dropping them is how
 * the pre-existing config surface hid typos from users.
 */
export function parseTimeoutSection(raw: unknown, sourceLabel = 'config.json'): Partial<TimeoutConfig> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const section = (raw as Record<string, unknown>)['timeouts']
  if (section === undefined) return {}
  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    warn(`${sourceLabel} "timeouts" must be an object — ignoring it.`)
    return {}
  }
  const out: Partial<TimeoutConfig> = {}
  const known = new Set<string>(TIMEOUT_FIELD_NAMES)
  for (const [key, value] of Object.entries(section as Record<string, unknown>)) {
    if (!known.has(key)) {
      warn(`${sourceLabel} unknown key "timeouts.${key}" — ignoring it. Known keys: ${TIMEOUT_FIELD_NAMES.join(', ')}.`)
      continue
    }
    const coerced = coerceField(key as keyof TimeoutConfig, value, sourceLabel)
    if (coerced !== undefined) out[key as keyof TimeoutConfig] = coerced
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

let _fileOverrides: Partial<TimeoutConfig> = {}
/**
 * Cache for the FILE layer only — never for the final table.
 *
 * Env vars must stay LIVE reads, matching RuntimeEnv's documented contract
 * ("Accessors read process.env on each call rather than snapshotting once at
 * import"): tests and embedders legitimately set env after module load, and a
 * frozen table silently ignored them. Only the file layer is worth caching —
 * it is the part that costs disk I/O. Re-merging ten fields per call is free.
 */
let _fileLayer: Partial<TimeoutConfig> | null = null
let _loader: (() => Partial<TimeoutConfig>) | null = null

/**
 * Register the config-file layer. Called once during session/CLI bootstrap
 * with a loader that reads the merged (global → project → session) config, so
 * deep call sites (the API clients, ToolExecution, the MCP clients) can resolve
 * timeouts without threading a config object through every signature.
 *
 * Lazy by design: the loader runs on first read, not here, so bootstrap order
 * does not matter.
 */
export function configureTimeouts(loader: () => Partial<TimeoutConfig>): void {
  _loader = loader
  _fileLayer = null
}

/** Last projectDir the loader was registered for — avoids redundant re-registration. */
let _loaderProjectDir: string | null | undefined

/**
 * Idempotent bootstrap used by resolveConfig(): registers a loader bound to the
 * given projectDir, but only when that scope actually changed, so the resolved
 * cache survives the many resolveConfig() calls a single run makes.
 */
export function bootstrapTimeoutsFor(
  projectDir: string | undefined,
  loader: (projectDir: string | undefined) => Partial<TimeoutConfig>,
): void {
  const key = projectDir ?? null
  if (_loaderProjectDir === key && _loader) return
  _loaderProjectDir = key
  configureTimeouts(() => loader(projectDir))
}

/**
 * Directly pin the config layer, WINNING over any registered loader.
 * For tests and for embedders that have no config file but do want to set
 * timeouts programmatically.
 */
export function setTimeoutOverrides(overrides: Partial<TimeoutConfig>): void {
  _fileOverrides = { ...overrides }
  _fileLayer = null
}

/**
 * Drop only the RESOLVED cache, keeping whatever layer was registered.
 * Called after a `/config` write so the next read picks up the new file
 * contents — it must NOT unregister the loader, or every later read would
 * silently fall back to env+defaults.
 */
export function invalidateTimeoutCache(): void {
  _fileLayer = null
}

/** Full reset — drops the registered layer too. Test hook. */
export function resetTimeoutsForTest(): void {
  _fileLayer = null
  _fileOverrides = {}
  _loader = null
  _loaderProjectDir = undefined
}

function envValue(field: keyof TimeoutConfig): number | undefined {
  const spec = FIELD_SPECS[field]
  const raw = process.env[spec.env]
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < spec.min || n > spec.max) return undefined
  return n
}

/**
 * The effective timeout table: config file > env var > built-in default.
 * Cached; `resetTimeoutCache()` invalidates.
 */
export function resolveTimeouts(): TimeoutConfig {
  const fromFile = fileLayer()
  const out = { ...TIMEOUT_DEFAULTS } as TimeoutConfig
  for (const field of TIMEOUT_FIELD_NAMES) {
    const fileValue = fromFile[field]
    if (fileValue !== undefined) { out[field] = fileValue; continue }
    const envVal = envValue(field)   // live read — see _fileLayer's comment
    if (envVal !== undefined) { out[field] = envVal }
  }
  return out
}

/** The cached config-file layer. Explicit overrides win over the loader. */
function fileLayer(): Partial<TimeoutConfig> {
  if (_fileLayer) return _fileLayer
  // Explicit overrides beat the registered loader: resolveConfig() re-registers
  // the loader on every call, so a test that pinned values must not be
  // silently undone by the next session construction.
  _fileLayer = Object.keys(_fileOverrides).length > 0
    ? { ..._fileOverrides }
    : (_loader ? safeLoad(_loader) : {})
  return _fileLayer
}

function safeLoad(loader: () => Partial<TimeoutConfig>): Partial<TimeoutConfig> {
  try { return loader() } catch { return {} }
}

/** Convenience accessor for one field. */
export function timeout<K extends keyof TimeoutConfig>(field: K): TimeoutConfig[K] {
  return resolveTimeouts()[field]
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived budgets
// ─────────────────────────────────────────────────────────────────────────────

/** Lower/upper rails on the derived flash budget. */
const FLASH_MIN_MS = 30_000
const FLASH_MAX_MS = 180_000

/**
 * Budget for one flash side-call, derived from how many tokens it may emit:
 *
 *   flashTtftMs + maxTokens / flashTokensPerSec × 1000, clamped to [30 s, 180 s]
 *
 * The previous flat 30 s was under-budgeted for the larger side-calls — a
 * 1,200-token knowledge extraction needs 60 s of generation alone at 20 tok/s,
 * so it could only ever succeed on a fast provider, and its failure mode is
 * silent (`query()` returns null and the caller falls back). Deriving from
 * maxTokens means new call sites get a sane budget without hand-tuning.
 */
export function flashTimeoutMs(maxTokens: number): number {
  const t = resolveTimeouts()
  const tokens = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 0
  const budget = t.flashTtftMs + (tokens / t.flashTokensPerSec) * 1000
  return Math.min(FLASH_MAX_MS, Math.max(FLASH_MIN_MS, Math.round(budget)))
}

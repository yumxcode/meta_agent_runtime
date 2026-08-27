/**
 * strictNumber — whole-string numeric parsing for configuration values.
 *
 * Why this is its own module (P2-3, review 2026-08-27):
 *
 * `Number.parseInt` / `Number.parseFloat` stop at the first character they
 * cannot consume and return the prefix they managed to read. For configuration
 * that is the worst possible failure mode, because a typo does not produce an
 * error — it produces a *different valid setting*, and usually a weaker one:
 *
 *   META_AGENT_JOB_TIMEOUT_MS=0oops  → parseInt → 0  → watchdog disabled
 *   --max-turns=3junk                → parseInt → 3  → silently accepted
 *   --max-budget-usd=1oops           → parseFloat → 1 → silently accepted
 *
 * Three separate layers needed the same rule — env vars (RuntimeEnv), the
 * timeout table (core/timeouts, which deliberately does not depend on
 * RuntimeEnv to keep the infra→core layering one-directional), and CLI
 * argument parsing — so the rule lives here where all three can reach it
 * without any of them depending on each other.
 */

/** Integer literal, whole-string. Allows a leading sign; rejects `1e3`, `0x10`, `1_000`. */
const STRICT_INT_PATTERN = /^[+-]?\d+$/

/** Decimal literal, whole-string. Allows `1`, `1.5`, `.5`, `1.`, `1e-3`. */
const STRICT_FLOAT_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

/**
 * Parse a whole-string integer.
 *
 * @returns the value, or `undefined` if the string is not entirely an integer
 *   or the value is outside the exactly-representable range. Beyond 2^53 the
 *   parse is lossy, so the number we would use is not the number that was
 *   written — refusing beats silently rounding a limit.
 */
export function parseStrictInt(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!STRICT_INT_PATTERN.test(trimmed)) return undefined
  const n = Number(trimmed)
  return Number.isSafeInteger(n) ? n : undefined
}

/**
 * Parse a whole-string finite decimal.
 *
 * @returns the value, or `undefined` for non-numeric strings and for the
 *   literals `Infinity` / `NaN`, which are never a meaningful budget or limit.
 */
export function parseStrictFloat(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!STRICT_FLOAT_PATTERN.test(trimmed)) return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : undefined
}

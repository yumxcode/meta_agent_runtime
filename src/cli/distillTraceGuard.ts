/**
 * Keeps a Distill phase from reading Distill's own bookkeeping.
 *
 * Architect and Reviewer are granted read_file/grep/glob over the whole
 * workspace, and glob's SKIP_DIRS covers node_modules/.git/dist but NOT
 * `.loop`. Since `.loop/distill/` holds the Architect checkpoint and the
 * per-attempt run trace (rejected envelopes, frozen graphs, previous layered
 * verdicts), an unguarded phase could anchor on an earlier attempt's rejected
 * graph or on what the last reviewer happened to say — converting a
 * deliberately independent review into an accidental, non-repeatable form of
 * state. Host bookkeeping is not source evidence.
 *
 * `.loop/instances/` stays readable: runtime state is legitimate evidence when
 * checking runtime_preconditions.
 */
const DISTILL_BOOKKEEPING_RE = /(?:^|[/\\])\.loop(?:[/\\]distill(?:[/\\]|$)|[/\\]?$)/

/** True when any string argument points into `.loop/distill`. Scanning every
 * string value rather than a fixed field name keeps the guard correct across
 * read_file/grep/glob, whose path parameters are not uniformly named. */
export function referencesDistillTrace(input: Record<string, unknown>): boolean {
  const scan = (value: unknown, depth: number): boolean => {
    if (depth > 3) return false
    if (typeof value === 'string') return DISTILL_BOOKKEEPING_RE.test(value)
    if (Array.isArray(value)) return value.some(item => scan(item, depth + 1))
    if (value && typeof value === 'object') return Object.values(value).some(item => scan(item, depth + 1))
    return false
  }
  return scan(input, 0)
}

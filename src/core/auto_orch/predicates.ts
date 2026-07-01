/**
 * predicates.ts — the small, data-only trigger DSL for auto_orch.
 *
 * A "trigger predicate" decides WHETHER a hook/role fires at a given loop point.
 * It is intentionally NOT arbitrary code: an LLM-authored plan emits these as
 * plain data, so the engine can validate, bound, serialise and replay them. The
 * evaluator below is total and side-effect-free, reading only a read-only
 * `LoopStateView`. This is what makes "the AI composes the loop" safe — the AI
 * picks from a closed predicate vocabulary, it never executes logic.
 */

/** Read-only snapshot the predicate evaluator may inspect. */
export interface LoopStateView {
  /** Completed tool-batch count so far. */
  turnCount: number
  /** Cumulative estimated cost. */
  estimatedCostUsd: number
  /** The intra-turn transition currently firing, when relevant. */
  point?: 'pre_query' | 'post_query' | 'pre_tool' | 'post_tool'
  /** The most recent structural boundary type, when relevant. */
  boundary?: string
  /** Label of the most recent verdict (for chaining decisions). */
  lastVerdictLabel?: string
  /** Tool names involved in the current transition. */
  toolNames?: readonly string[]
  /** Tool names that errored in the current transition. */
  erroredToolNames?: readonly string[]
  /** Arbitrary named counters the engine maintains (e.g. node visit counts). */
  counters?: Readonly<Record<string, number>>
}

/**
 * The predicate union. Composable via and/or/not. Every variant is a plain
 * object so a plan is fully serialisable.
 */
export type Predicate =
  | { kind: 'always' }
  | { kind: 'never' }
  /** True every Nth turn (turnCount > 0 && turnCount % n === 0). */
  | { kind: 'turnInterval'; n: number }
  /** True at/after a specific cumulative turn count. */
  | { kind: 'turnAtLeast'; n: number }
  /** True when the current transition matches. */
  | { kind: 'atPoint'; point: LoopStateView['point'] }
  /** True when the current structural boundary matches. */
  | { kind: 'onBoundary'; boundary: string }
  /** True when the last verdict carried this label. */
  | { kind: 'verdictLabel'; label: string }
  /** True when any tool in the current transition errored. */
  | { kind: 'anyToolErrored' }
  /** True when a named tool is in the current transition's tool set. */
  | { kind: 'toolUsed'; name: string }
  /** True when a named counter is >= n. */
  | { kind: 'counterAtLeast'; counter: string; n: number }
  /** True when cumulative cost >= usd. */
  | { kind: 'costAtLeast'; usd: number }
  | { kind: 'and'; of: Predicate[] }
  | { kind: 'or'; of: Predicate[] }
  | { kind: 'not'; of: Predicate }

/** Evaluate a predicate against a state view. Total and side-effect-free. */
export function evalPredicate(p: Predicate, s: LoopStateView): boolean {
  switch (p.kind) {
    case 'always':
      return true
    case 'never':
      return false
    case 'turnInterval':
      return p.n > 0 && s.turnCount > 0 && s.turnCount % p.n === 0
    case 'turnAtLeast':
      return s.turnCount >= p.n
    case 'atPoint':
      return s.point === p.point
    case 'onBoundary':
      return s.boundary === p.boundary
    case 'verdictLabel':
      return s.lastVerdictLabel === p.label
    case 'anyToolErrored':
      return (s.erroredToolNames?.length ?? 0) > 0
    case 'toolUsed':
      return (s.toolNames ?? []).includes(p.name)
    case 'counterAtLeast':
      return (s.counters?.[p.counter] ?? 0) >= p.n
    case 'costAtLeast':
      return s.estimatedCostUsd >= p.usd
    case 'and':
      return p.of.every(q => evalPredicate(q, s))
    case 'or':
      return p.of.some(q => evalPredicate(q, s))
    case 'not':
      return !evalPredicate(p.of, s)
    default: {
      // Exhaustiveness guard: a new predicate kind must be handled here.
      const _never: never = p
      return Boolean(_never)
    }
  }
}

/**
 * Validate a predicate is structurally well-formed (finite, no NaN, no empty
 * boolean groups). Returns the list of problems; empty = valid. Used to reject
 * malformed LLM-authored predicates before they ever run.
 */
export function validatePredicate(p: Predicate, path = '$'): string[] {
  const errs: string[] = []
  const num = (v: number, name: string): void => {
    if (!Number.isFinite(v)) errs.push(`${path}.${name} must be a finite number`)
  }
  switch (p.kind) {
    case 'turnInterval':
    case 'turnAtLeast':
    case 'counterAtLeast':
      num((p as { n: number }).n, 'n')
      break
    case 'costAtLeast':
      num(p.usd, 'usd')
      break
    case 'and':
    case 'or':
      if (p.of.length === 0) errs.push(`${path}.of must be non-empty`)
      p.of.forEach((q, i) => errs.push(...validatePredicate(q, `${path}.of[${i}]`)))
      break
    case 'not':
      errs.push(...validatePredicate(p.of, `${path}.of`))
      break
    default:
      break
  }
  return errs
}

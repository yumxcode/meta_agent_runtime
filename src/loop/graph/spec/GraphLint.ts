import type { LoopGraphSpec } from './GraphTypes.js'

/**
 * Static lint for the recurring "write surface" failure class.
 *
 * Three distilled graphs in a row failed the same way for different reasons:
 * an invented directory that did not exist, a git push blocked by the
 * project-root .git protection, and finally a work tree placed OUTSIDE the
 * project where the sandbox denies every write. The common root cause: the
 * facts about what is writable lived only in prose prompts, checked by a
 * semantic reviewer that misses variants. These rules make the cheap,
 * high-precision half of that check mechanical.
 *
 * Contract: Distill treats every finding as blocking (the Compiler can always
 * repair a prompt or a lane); `loop create` only PRINTS findings — a human
 * hand-authoring a graph may overrule a heuristic.
 */
export interface GraphLintFinding {
  level: 'error' | 'warning'
  rule: 'absolute-path' | 'outside-project-write' | 'undeclared-workspace-write' | 'prompt-writes-denied-path' | 'git-without-capability' | 'precomputed-routing' | 'duplicate-route-condition' | 'same-lane-agent-split' | 'dead-literal-route' | 'unbounded-wait' | 'mixed-snapshot-routing' | 'static-effect-idempotency' | 'terminal-fanout-cancellation' | 'agent-budget-walltime' | 'lane-write-overlap' | 'redundant-mkdir' | 'dead-state-field' | 'dead-null-input' | 'shadowed-route' | 'terminal-route-shadowed' | 'route-partition-gap'
  at: string
  message: string
}

export function lintLoopGraph(spec: LoopGraphSpec): GraphLintFinding[] {
  const findings: GraphLintFinding[] = []
  lintAgentWorkspacePrompts(spec, findings)
  lintAgentBudgetWallTime(spec, findings)
  lintLaneWriteOverlap(spec, findings)
  lintRedundantMkdir(spec, findings)
  lintDeadStateFields(spec, findings)
  lintDeadNullInputs(spec, findings)
  lintPrecomputedRouting(spec, findings)
  lintDuplicateRouteConditions(spec, findings)
  lintShadowedRoutes(spec, findings)
  lintTerminalRouteShadowing(spec, findings)
  lintRoutePartitionGaps(spec, findings)
  lintSameLaneAgentSplits(spec, findings)
  lintDeadLiteralRoutes(spec, findings)
  lintUnboundedWaits(spec, findings)
  lintMixedSnapshotRouting(spec, findings)
  lintStaticEffectIdempotency(spec, findings)
  lintTerminalFanOut(spec, findings)
  return findings
}

/**
 * Every Agent segment needs a basic wall-clock window for the model response,
 * tool execution and durable persistence. The 5-minute floor used to live only
 * in the Distill Compiler/Reviewer prose prompts, which meant a probabilistic
 * LLM reviewer was the sole enforcer of a purely mechanical, high-precision
 * invariant. Making it an error-level lint moves that enforcement into
 * deterministic code: Distill treats it as blocking (error-level lint blocks
 * lowering), while `loop create` for a hand-authored graph only PRINTS it — a
 * human may still overrule (see the contract note at the top of this file). ABI
 * Validate has already guaranteed any present wallTimeMs is a positive finite
 * number, so here we only add the floor and the "must be declared" requirement.
 */
export const AGENT_MIN_WALLTIME_MS = 300_000

function lintAgentBudgetWallTime(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  for (const [nodeId, node] of Object.entries(spec.nodes ?? {})) {
    if (!node || node.type !== 'agent') continue
    const wallTimeMs = node.budget?.wallTimeMs
    if (wallTimeMs === undefined) {
      findings.push({
        level: 'error', rule: 'agent-budget-walltime', at: `nodes.${nodeId}.budget.wallTimeMs`,
        message: `agent node must declare budget.wallTimeMs (>= ${AGENT_MIN_WALLTIME_MS}ms / 5 min); it reserves a basic window for the model response, tool execution and durable persistence and does not replace turns/usd/lifetime budgets`,
      })
    } else if (typeof wallTimeMs === 'number' && Number.isFinite(wallTimeMs) && wallTimeMs < AGENT_MIN_WALLTIME_MS) {
      findings.push({
        level: 'error', rule: 'agent-budget-walltime', at: `nodes.${nodeId}.budget.wallTimeMs`,
        message: `agent budget.wallTimeMs ${wallTimeMs} is below the ${AGENT_MIN_WALLTIME_MS}ms (5 min) floor; raise it so one segment can finish the model response, tools and persistence`,
      })
    }
  }
}

/** A lifetime Activation cap cannot release a bounded graph that is already
 * parked. Continuous graphs intentionally omit the lifetime cap and may wait
 * forever for their next external event. */
function lintUnboundedWaits(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  const bounded = spec.limits.maxTotalActivations !== undefined || spec.limits.maxActivations !== undefined
  if (!bounded || spec.limits.maxWallTimeMs !== undefined) return
  for (const [nodeId, node] of Object.entries(spec.nodes ?? {})) {
    const unboundedEvent = node.type === 'wait' && node.wait.kind === 'event' && node.wait.timeoutMs === undefined
    const unboundedJoin = node.type === 'join' && node.timeoutMs === undefined
    if (!unboundedEvent && !unboundedJoin) continue
    findings.push({
      level: 'warning', rule: 'unbounded-wait', at: `nodes.${nodeId}`,
      message: `${unboundedEvent ? 'event Wait' : 'Join'} has no timeout while this is a lifetime-bounded graph with no maxWallTimeMs; it can remain waiting forever before the total Activation cap is reached — add a node timeout or graph wall limit, or make the graph continuous by using maxLiveActivations without maxTotalActivations`,
    })
  }
}

function lintMixedSnapshotRouting(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  if ((spec.concurrency?.maxActivations ?? 1) <= 1 || spec.concurrency?.stateConsistency === 'serializable') return
  for (const transition of spec.transitions ?? []) {
    if (!transition.when?.includes('$state') || !transition.when.includes('$output')) continue
    findings.push({
      level: 'warning', rule: 'mixed-snapshot-routing', at: `transitions '${transition.id}'.when`,
      message: 'commit_latest evaluates fresh $state together with $output computed from the Activation claim snapshot; use serializable when this decision requires one coherent snapshot, or route only on raw output facts that are independent of mutable State',
    })
  }
}

function lintStaticEffectIdempotency(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  for (const [nodeId, node] of Object.entries(spec.nodes ?? {})) {
    if (node.type !== 'effect' || !node.idempotencyKey || !('literal' in node.idempotencyKey) || !nodeInCycle(spec, nodeId)) continue
    findings.push({
      level: 'warning', rule: 'static-effect-idempotency', at: `nodes.${nodeId}.idempotencyKey`,
      message: 'cyclic Effect uses a static idempotency key, so a provider may deduplicate later iterations; omit the key for the per-Activation default or include an iteration/correlation value',
    })
  }
}

function lintTerminalFanOut(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  for (const transition of spec.transitions ?? []) {
    const targets = targetNodeIds(transition.to)
    if (targets.length < 2 || !targets.some(nodeId => reachesTerminalBeforeJoin(spec, nodeId))) continue
    findings.push({
      level: 'warning', rule: 'terminal-fanout-cancellation', at: `transitions '${transition.id}'.to`,
      message: 'fan-out has a branch that can reach a Terminal before a Join; Terminal is a graph-wide barrier and cancels remaining ready/running/waiting siblings — add an explicit Join first unless race-to-terminal cancellation is intentional',
    })
  }
}

function nodeInCycle(spec: LoopGraphSpec, start: string): boolean {
  const pending = [...outgoingNodeIds(spec, start)]
  const seen = new Set<string>()
  while (pending.length) {
    const nodeId = pending.pop()!
    if (nodeId === start) return true
    if (seen.has(nodeId)) continue
    seen.add(nodeId)
    pending.push(...outgoingNodeIds(spec, nodeId))
  }
  return false
}

function reachesTerminalBeforeJoin(spec: LoopGraphSpec, start: string): boolean {
  const pending = [start]
  const seen = new Set<string>()
  while (pending.length) {
    const nodeId = pending.pop()!
    if (seen.has(nodeId)) continue
    seen.add(nodeId)
    const node = spec.nodes[nodeId]
    if (node?.type === 'terminal') return true
    if (node?.type === 'join') continue
    pending.push(...outgoingNodeIds(spec, nodeId))
  }
  return false
}

function outgoingNodeIds(spec: LoopGraphSpec, nodeId: string): string[] {
  return (spec.transitions ?? []).filter(transition => transition.from === nodeId).flatMap(transition => targetNodeIds(transition.to))
}

function targetNodeIds(to: LoopGraphSpec['transitions'][number]['to']): string[] {
  return (Array.isArray(to) ? to : [to]).map(target => typeof target === 'string' ? target : target.node)
}

/** A persistent Lane is a continuous session boundary, not a phase bucket.
 * Multiple Agents can be legitimate, so this is deliberately an advisory for
 * semantic review rather than a mechanical rejection. */
function lintSameLaneAgentSplits(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  for (const [laneId, lane] of Object.entries(spec.lanes ?? {})) {
    if (lane.context !== 'persistent') continue
    const agents = Object.entries(spec.nodes ?? {})
      .filter(([, node]) => node?.type === 'agent' && node.lane === laneId)
      .map(([nodeId]) => nodeId)
    if (agents.length < 2) continue
    findings.push({
      level: 'warning', rule: 'same-lane-agent-split', at: `lanes.${laneId}`,
      message: `persistent lane contains ${agents.length} Agent nodes (${agents.join(', ')}); verify every split has an independent persistence, permission/concurrency, Kernel Wait/Event, failure-isolation, or terminal boundary — a different prompt, role name, first-run flag, or budget is not such a boundary; otherwise merge bootstrap/pivot/monitor phases into one autonomous Agent mode`,
    })
  }
}

/** Two transitions with the same source, outcome and predicate are not two
 * branches: the higher-priority one permanently shadows the other. This is a
 * mechanical routing error, not a semantic-review judgement. */
function lintDuplicateRouteConditions(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  const firstByCondition = new Map<string, string>()
  for (const transition of spec.transitions ?? []) {
    if (typeof transition.when !== 'string' || transition.default === true) continue
    const condition = transition.when.trim().replace(/\s+/g, ' ')
    const key = `${transition.from}\0${transition.on ?? 'success'}\0${condition}`
    const first = firstByCondition.get(key)
    if (!first) {
      firstByCondition.set(key, transition.id)
      continue
    }
    findings.push({
      level: 'error', rule: 'duplicate-route-condition', at: `transitions '${transition.id}'.when`,
      message: `has the same from/on/when predicate as transition '${first}'; one branch will always shadow the other — make the predicates mutually exclusive (including any state threshold)`,
    })
  }
}

/**
 * Deterministic routing analysis over one `from`+`on` group.
 *
 * Nearly every semantic rejection observed in real Distill runs lived in a
 * single node's out-edge set: a source-mandated bound whose edge was outranked
 * by a looping edge, a terminal that no reachable predicate could select, or a
 * truth-table partition that silently fell through to a `default` whose updates
 * meant the opposite. ABI Validate only guarantees "every outcome has an edge
 * and at most one default", so a `default` makes any group look covered. These
 * rules move the decidable part of that review into code, where it lands on the
 * first attempt instead of the fourth — and, unlike the sampling reviewer, lands
 * every time.
 */
interface RouteAtom { ref: string; op: string; value: string }
type RouteExpr =
  | { kind: 'or'; parts: RouteExpr[] }
  | { kind: 'and'; parts: RouteExpr[] }
  | { kind: 'atom'; atom: RouteAtom }

const ROUTE_ATOM_RE = /^(\$[A-Za-z_][A-Za-z0-9_.]*)\s*(==|!=|>=|<=|>|<)\s*('[^']*'|"[^"]*"|-?\d+(?:\.\d+)?|true|false|null)/

/** Restricted grammar: refs compared to literals, joined by && / || with
 * parentheses. Anything else returns undefined and the caller skips the group —
 * these rules only speak when they fully understand every condition. */
function parseRouteExpression(source: string): RouteExpr | undefined {
  let index = 0
  const skip = (): void => { while (index < source.length && /\s/.test(source[index]!)) index++ }
  const eat = (token: string): boolean => {
    skip()
    if (!source.startsWith(token, index)) return false
    index += token.length
    return true
  }
  const parseFactor = (): RouteExpr | undefined => {
    skip()
    if (eat('(')) {
      const inner = parseOr()
      return inner && eat(')') ? inner : undefined
    }
    const match = ROUTE_ATOM_RE.exec(source.slice(index))
    if (!match) return undefined
    index += match[0]!.length
    return { kind: 'atom', atom: { ref: match[1]!, op: match[2]!, value: unquoteRouteLiteral(match[3]!) } }
  }
  const parseAnd = (): RouteExpr | undefined => {
    const parts: RouteExpr[] = []
    for (;;) {
      const part = parseFactor()
      if (!part) return undefined
      parts.push(part)
      if (!eat('&&')) break
    }
    return parts.length === 1 ? parts[0] : { kind: 'and', parts }
  }
  const parseOr = (): RouteExpr | undefined => {
    const parts: RouteExpr[] = []
    for (;;) {
      const part = parseAnd()
      if (!part) return undefined
      parts.push(part)
      if (!eat('||')) break
    }
    return parts.length === 1 ? parts[0] : { kind: 'or', parts }
  }
  const expr = parseOr()
  skip()
  return expr && index === source.length ? expr : undefined
}

function unquoteRouteLiteral(raw: string): string {
  return /^['"]/.test(raw) ? raw.slice(1, -1) : raw
}

function evaluateRouteExpression(expr: RouteExpr, env: ReadonlyMap<string, string>): boolean {
  if (expr.kind === 'or') return expr.parts.some(part => evaluateRouteExpression(part, env))
  if (expr.kind === 'and') return expr.parts.every(part => evaluateRouteExpression(part, env))
  const actual = env.get(expr.atom.ref)
  // A missing ref is treated as non-matching, mirroring Kernel `when` semantics.
  return actual === undefined ? false : compareRouteValue(actual, expr.atom.op, expr.atom.value)
}

function compareRouteValue(actual: string, op: string, expected: string): boolean {
  const left = Number(actual), right = Number(expected)
  const numeric = Number.isFinite(left) && Number.isFinite(right)
  switch (op) {
    case '==': return actual === expected
    case '!=': return actual !== expected
    case '>=': return numeric && left >= right
    case '<=': return numeric && left <= right
    case '>': return numeric && left > right
    case '<': return numeric && left < right
    default: return false
  }
}

function routeAtomsOf(expr: RouteExpr, output: RouteAtom[] = []): RouteAtom[] {
  if (expr.kind === 'atom') output.push(expr.atom)
  else for (const part of expr.parts) routeAtomsOf(part, output)
  return output
}

/** Conditional edges of one from+on group, in descending priority. */
function conditionalRouteGroup(spec: LoopGraphSpec, from: string, on: string): LoopGraphSpec['transitions'] {
  return (spec.transitions ?? [])
    .filter(transition => transition.from === from && (transition.on ?? 'success') === on
      && typeof transition.when === 'string' && transition.when.trim() && transition.default !== true)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
}

function routeGroupKeys(spec: LoopGraphSpec): Array<{ from: string; on: string }> {
  const keys = new Map<string, { from: string; on: string }>()
  for (const transition of spec.transitions ?? []) {
    const on = transition.on ?? 'success'
    keys.set(`${transition.from}\0${on}`, { from: transition.from, on })
  }
  return [...keys.values()]
}

/** Normalized `&&` conjuncts, used for the exact implication test. */
function conjunctsOf(when: string): string[] {
  return when.split('&&')
    .map(part => part.trim().replace(/^\((.*)\)$/s, '$1').trim().replace(/\s+/g, ' '))
    .filter(Boolean)
}

/**
 * Exact shadowing: if every conjunct of a higher-priority edge also appears in a
 * lower-priority edge, the lower one implies the higher one, so the higher one
 * always wins and the lower edge is dead. Pure conjunct-set containment, no
 * inference — a hit is certain, which is why it blocks.
 */
function lintShadowedRoutes(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  for (const { from, on } of routeGroupKeys(spec)) {
    const group = conditionalRouteGroup(spec, from, on)
    for (let lower = 0; lower < group.length; lower++) {
      const weak = group[lower]!
      const weakConjuncts = new Set(conjunctsOf(weak.when!))
      for (let higher = 0; higher < lower; higher++) {
        const strong = group[higher]!
        const strongConjuncts = conjunctsOf(strong.when!)
        if (!strongConjuncts.length || !strongConjuncts.every(conjunct => weakConjuncts.has(conjunct))) continue
        findings.push({
          level: 'error', rule: 'shadowed-route', at: `transitions '${weak.id}'.when`,
          message: `every condition of higher-priority transition '${strong.id}' (priority ${strong.priority ?? 0}) also appears in this one (priority ${weak.priority ?? 0}), so whenever this edge matches '${strong.id}' matches too and wins — this route can never fire; either raise this edge above '${strong.id}', or add the condition that distinguishes them (commonly the negation of what '${strong.id}' handles)`,
        })
        break
      }
    }
  }
}

/** Reachable-value candidates for one ref, derived from the constants the group
 * compares it against. Numeric refs get each cut point and its neighbours;
 * enumerated refs get their literals plus one value outside the set. */
function routeValueDomain(atoms: readonly RouteAtom[]): string[] | undefined {
  const numeric = atoms.filter(atom => Number.isFinite(Number(atom.value)))
  const literal = atoms.filter(atom => !Number.isFinite(Number(atom.value)))
  if (numeric.length && literal.length) return undefined // mixed use: not modellable
  if (numeric.length) {
    const values = new Set<number>([0])
    for (const atom of numeric) {
      const cut = Number(atom.value)
      values.add(cut - 1); values.add(cut); values.add(cut + 1)
    }
    return [...values].filter(value => value >= -1).sort((a, b) => a - b).slice(0, 6).map(String)
  }
  const values = [...new Set(literal.map(atom => atom.value))]
  // A boolean ref always has exactly two values, whichever one the conditions
  // happen to mention — modelling it as the single mentioned literal would
  // collapse the space and hide the partitions where it takes the other value.
  if (values.every(value => value === 'true' || value === 'false')) return ['true', 'false']
  // Deliberately NO sentinel for "some other enum value". Adding one invents
  // partitions the design never distinguishes (a status the group simply leaves
  // to the default), and on a healthy graph those invented rows were the only
  // thing this rule reported — pure noise in the reviewer's must-verify list.
  // Enumerating exactly the values the conditions themselves distinguish keeps
  // a finding meaningful: some combination of cases the design DOES separate is
  // claimed by nobody.
  return values.slice(0, 6)
}

const MAX_PARTITION_REFS = 10
const MAX_PARTITION_COMBOS = 50_000
const MIN_CONDITIONAL_EDGES_FOR_PARTITION_CHECK = 4
const MAX_REPORTED_PARTITIONS = 6
/**
 * Speak only when the uncovered pocket is small enough to enumerate exhaustively.
 * That single gate is what separates a real truth-table hole from the ordinary
 * "a few specific conditions over a broad default" style: on a graph that passed
 * review 378 partitions legitimately fell through to a "keep iterating" default,
 * while the graph whose recovery branch was genuinely mis-routed had a pocket of
 * ~18. A ratio test looked equivalent but is not — one missing cell in a small
 * table is a large fraction of it — so the bound is absolute, and the finding
 * then lists every gap instead of asking anyone to hand-verify hundreds of rows.
 */
const MAX_PARTITION_GAPS = 24

/**
 * Enumerate the group's truth table over the constants its own conditions use,
 * and report the partitions that no conditional edge claims. Falling through to
 * `default` is legal, so this is advisory — but it is exactly the information a
 * reviewer needs and repeatedly failed to derive by hand: in one run a partition
 * meaning "improved, with new findings, after a long stall" fell into a default
 * whose updates incremented the stall counter and escalated to a stop.
 */
function lintRoutePartitionGaps(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  for (const { from, on } of routeGroupKeys(spec)) {
    const group = conditionalRouteGroup(spec, from, on)
    if (group.length < MIN_CONDITIONAL_EDGES_FOR_PARTITION_CHECK) continue
    const fallback = (spec.transitions ?? []).find(transition =>
      transition.from === from && (transition.on ?? 'success') === on && transition.default === true)
    if (!fallback) continue

    const parsed: RouteExpr[] = []
    for (const transition of group) {
      const expr = parseRouteExpression(transition.when!)
      if (!expr) { parsed.length = 0; break }
      parsed.push(expr)
    }
    if (!parsed.length) continue

    const byRef = new Map<string, RouteAtom[]>()
    for (const expr of parsed) for (const atom of routeAtomsOf(expr)) {
      byRef.set(atom.ref, [...(byRef.get(atom.ref) ?? []), atom])
    }
    if (!byRef.size || byRef.size > MAX_PARTITION_REFS) continue
    const domains: Array<{ ref: string; values: string[] }> = []
    let combos = 1
    for (const [ref, atoms] of byRef) {
      const values = routeValueDomain(atoms)
      if (!values?.length) { combos = Number.POSITIVE_INFINITY; break }
      domains.push({ ref, values })
      combos *= values.length
    }
    if (!Number.isFinite(combos) || combos > MAX_PARTITION_COMBOS) continue

    const gaps: string[] = []
    let total = 0
    const walk = (position: number, env: Map<string, string>): void => {
      if (position === domains.length) {
        total++
        if (parsed.some(expr => evaluateRouteExpression(expr, env))) return
        if (gaps.length < MAX_REPORTED_PARTITIONS) {
          gaps.push([...env].map(([ref, value]) => `${ref}=${value}`).join(', '))
        } else gaps.push('')
        return
      }
      const { ref, values } = domains[position]!
      for (const value of values) {
        env.set(ref, value)
        walk(position + 1, env)
      }
      env.delete(ref)
    }
    walk(0, new Map())
    const examples = gaps.filter(Boolean)
    if (!examples.length || gaps.length > MAX_PARTITION_GAPS) continue
    findings.push({
      level: 'warning', rule: 'route-partition-gap', at: `transitions from '${from}' on '${on}'`,
      message: `only ${gaps.length} of ${total} enumerated partitions match no conditional edge, so these edges nearly tile their own value space and that small pocket falls through to default '${fallback.id}': ${examples.map(example => `{${example}}`).join(' ; ')}${gaps.length > examples.length ? ` (+${gaps.length - examples.length} more)` : ''}. Falling through is legal, so verify '${fallback.id}'.updates and target are right for each — a partition needing different updates (a counter reset instead of an increment, a different terminal) needs its own Transition`,
    })
  }
}

/** Provable mutual exclusion between two atoms over the same ref. Used only to
 * SUPPRESS a warning, so an inconclusive answer is the safe default. */
function provablyExclusiveAtoms(a: RouteAtom, b: RouteAtom): boolean {
  if (a.ref !== b.ref) return false
  if (a.op === '==' && b.op === '==') return a.value !== b.value
  if (a.op === '==' && b.op === '!=' || a.op === '!=' && b.op === '==') return a.value === b.value
  const left = Number(a.value), right = Number(b.value)
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false
  // Strictness is tracked as a flag, never as an epsilon: at magnitudes above 1
  // `value - Number.EPSILON` rounds straight back to `value`, which silently
  // turned "< 20" and ">= 20" into an unproven overlap.
  interface Interval { lo: number; loOpen: boolean; hi: number; hiOpen: boolean }
  const bound = (atom: RouteAtom, value: number): Interval | undefined => {
    switch (atom.op) {
      case '>=': return { lo: value, loOpen: false, hi: Number.POSITIVE_INFINITY, hiOpen: true }
      case '>': return { lo: value, loOpen: true, hi: Number.POSITIVE_INFINITY, hiOpen: true }
      case '<=': return { lo: Number.NEGATIVE_INFINITY, loOpen: true, hi: value, hiOpen: false }
      case '<': return { lo: Number.NEGATIVE_INFINITY, loOpen: true, hi: value, hiOpen: true }
      case '==': return { lo: value, loOpen: false, hi: value, hiOpen: false }
      default: return undefined
    }
  }
  const first = bound(a, left), second = bound(b, right)
  if (!first || !second) return false
  const disjoint = (low: Interval, high: Interval): boolean =>
    low.hi < high.lo || (low.hi === high.lo && (low.hiOpen || high.loOpen))
  return disjoint(first, second) || disjoint(second, first)
}

/** Pure conjunction of atoms, or undefined when the condition contains an `||`
 * we cannot reason about. */
function conjunctAtomsOf(expr: RouteExpr): RouteAtom[] | undefined {
  if (expr.kind === 'atom') return [expr.atom]
  if (expr.kind === 'or') return undefined
  const atoms: RouteAtom[] = []
  for (const part of expr.parts) {
    const inner = conjunctAtomsOf(part)
    if (!inner) return undefined
    atoms.push(...inner)
  }
  return atoms
}

/**
 * A bound the source mandates ("stop after N rounds", "escalate at N stalls") is
 * only enforced if its edge actually wins when the threshold is met. When a
 * higher-priority edge continues the loop and the two conditions are not
 * provably exclusive, the bound is unenforceable in the overlap — the exact
 * defect behind two `missing-source-bound` / unreachable-terminal rejections.
 * Proving exclusion is only partly decidable, so an unproven overlap is a
 * warning for the reviewer rather than a block.
 */
function lintTerminalRouteShadowing(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  const isTerminal = (transition: LoopGraphSpec['transitions'][number]): boolean =>
    targetNodeIds(transition.to).some(nodeId => spec.nodes?.[nodeId]?.type === 'terminal')
  for (const { from, on } of routeGroupKeys(spec)) {
    const group = conditionalRouteGroup(spec, from, on)
    for (let lower = 0; lower < group.length; lower++) {
      const bound = group[lower]!
      if (!isTerminal(bound)) continue
      const boundExpr = parseRouteExpression(bound.when!)
      const boundAtoms = boundExpr && conjunctAtomsOf(boundExpr)
      // Only guard bounds expressed as a threshold on persistent State — that is
      // what a source-mandated limit looks like, and it keeps this narrow.
      if (!boundAtoms?.some(atom => atom.ref.startsWith('$state.') && Number.isFinite(Number(atom.value)))) continue
      for (let higher = 0; higher < lower; higher++) {
        const looping = group[higher]!
        if (isTerminal(looping)) continue
        const loopingExpr = parseRouteExpression(looping.when!)
        const loopingAtoms = loopingExpr && conjunctAtomsOf(loopingExpr)
        if (!loopingAtoms) continue
        const exclusive = boundAtoms.some(a => loopingAtoms.some(b => provablyExclusiveAtoms(a, b)))
        if (exclusive) continue
        findings.push({
          level: 'warning', rule: 'terminal-route-shadowed', at: `transitions '${bound.id}'.when`,
          message: `this edge routes to a Terminal on a $state threshold, but higher-priority transition '${looping.id}' (priority ${looping.priority ?? 0} vs ${bound.priority ?? 0}) continues the loop and its condition is not provably exclusive with this one — in the overlap the loop wins and the bound never takes effect; either raise this edge above '${looping.id}', or add the mutually exclusive guard (e.g. the complementary threshold) to '${looping.id}'`,
        })
        break
      }
    }
  }
}

const ABSOLUTE_PATH_RE = /(?:^|[\s"'`(=])(?:\/(?:Users|home|root|srv|Volumes)\/|~\/)/
const WRITE_VERB_RE = /\b(edit|write|modify|update|commit|push|clone|create|save|append)\b|编辑|修改|写入|提交|推送/i
const OUTSIDE_PROJECT_RE = /outside\s+(?:of\s+)?(?:this|the)\s+project|项目之?外/i
const OUTSIDE_NEGATION_RE = /\b(?:never|not|don'?t|do\s+not|avoid|no)\b[^.\n]{0,40}outside|outside[^.\n]{0,40}\b(?:forbidden|prohibited|denied|read[- ]?only)\b|(?:禁止|不得|不要|勿)[^。\n]{0,20}项目之?外/i
const GIT_MUTATION_RE = /\bgit\s+(?:add|commit|push)\b/i
const EXPLICIT_WRITE_VERB_RE = /\b(?:write|edit|modify|update|create|save|append|replace)\b|(?:写入|编辑|修改|更新|创建|保存|追加|替换)/i
const NEGATED_WRITE_RE = /\b(?:never|not|don'?t|do\s+not|mustn'?t|avoid)\b[^.。\n]{0,28}\b(?:write|edit|modify|update|create|save|append|replace)\b|(?:禁止|不得|不要|无需|不应|绝不)[^。\n]{0,18}(?:写入|编辑|修改|更新|创建|保存|追加|替换)/i
const BACKTICK_PATH_RE = /`([^`\n]+)`/g
const PLAIN_PATH_RE = /(?:^|[\s("'])((?:\.?[A-Za-z0-9_-]+\/)+(?:[A-Za-z0-9_.*<>{}-]+\.[A-Za-z0-9_-]+)?)(?=$|[.\s,;:)'])/g

function lintAgentWorkspacePrompts(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  for (const [nodeId, node] of Object.entries(spec.nodes ?? {})) {
    if (!node || node.type !== 'agent') continue
    const lane = spec.lanes?.[node.lane]
    const text = [node.prompt, node.systemInstructions, lane?.agentProfile?.systemInstructions]
      .filter((part): part is string => typeof part === 'string').join('\n')
    const at = `nodes.${nodeId}.prompt`

    if (ABSOLUTE_PATH_RE.test(text)) {
      findings.push({
        level: 'error', rule: 'absolute-path', at,
        message: 'prompt references an absolute or home path; the workspace is project-relative and the sandbox denies all writes outside the project root — bring the resource inside the project under a Lane write prefix',
      })
    }
    if (OUTSIDE_PROJECT_RE.test(text) && WRITE_VERB_RE.test(text) && !OUTSIDE_NEGATION_RE.test(text)) {
      findings.push({
        level: 'error', rule: 'outside-project-write', at,
        message: "prompt directs write/edit/git work at a location outside the project; there is NO writable location outside the project root — clone or move it inside the project under an owned write prefix and declare it as a directory precondition",
      })
    }
    for (const target of explicitPromptWriteTargets(text)) {
      const declared = (lane?.workspace?.write ?? []).some(rule => pathCoveredByWriteRule(target, rule.path))
      if (declared) continue
      // Naming the lane that already owns the path turns a "you are missing a
      // declaration" report into an actionable ownership statement, and steers
      // the repair away from granting a second writer.
      const owner = owningLaneOf(spec, target, node.lane)
      const denied = (lane?.workspace?.deny ?? []).some(path => typeof path === 'string' && pathCoveredByWriteRule(target, path))
      if (denied) {
        findings.push({
          level: 'error', rule: 'prompt-writes-denied-path', at,
          message: `prompt instructs this Agent to write '${target}', but lane '${node.lane}' explicitly denies that path${owner ? ` and lane '${owner}' owns it` : ''}; a deny is an ownership boundary the design chose on purpose, not a missing declaration — delete the instruction from this prompt and let ${owner ? `the node on lane '${owner}'` : 'the owning node'} perform the write. Do NOT add a write rule to this lane: that installs a second writer on one path. Note the Kernel already injects this lane's workspace contract (read/write/deny plus mode semantics) into every Activation prompt, so the Agent does not need a hand-written path list — describe the persistence responsibility instead of enumerating paths`,
        })
        continue
      }
      findings.push({
        level: 'error', rule: 'undeclared-workspace-write', at,
        message: `prompt explicitly writes '${target}', but lane '${node.lane}' does not declare a covering workspace.write rule; either add the write rule when this node genuinely owns the path, or delete the instruction and leave the write to ${owner ? `the node on lane '${owner}', which already owns that path` : 'the node that owns the path'}. The Kernel injects this lane's workspace contract into every Activation prompt, so a hand-written path list in the prose is a second, non-authoritative copy — prefer describing the persistence responsibility and let lane.workspace be the single source of truth for the write surface`,
      })
    }
    if (GIT_MUTATION_RE.test(text)) {
      const hasScm = lane?.scm === 'git'
      const ownedPrefixes = (lane?.workspace?.write ?? []).filter(rule => rule.mode === 'owned').map(rule => rule.path)
      if (!hasScm && ownedPrefixes.length === 0) {
        findings.push({
          level: 'error', rule: 'git-without-capability', at,
          message: `prompt performs git add/commit/push but lane '${node.lane}' has neither scm:'git' nor an owned write prefix that could host a nested repository`,
        })
      } else if (!hasScm) {
        findings.push({
          level: 'warning', rule: 'git-without-capability', at,
          message: `git add/commit/push relies on a nested repository; verify the repo lives under an owned prefix of lane '${node.lane}' (${ownedPrefixes.join(', ')}) — the project-root .git stays protected without scm:'git'`,
        })
      }
    }
  }
}

/** Extract only explicit backtick-delimited project paths from imperative
 * write sentences. This intentionally avoids guessing paths from general prose:
 * false negatives go to semantic review, while a hit is safe to block. */
function explicitPromptWriteTargets(text: string): string[] {
  const targets = new Set<string>()
  for (const line of text.split('\n')) {
    // Keep the verb and target in the same sentence. A common prompt shape is
    // "create state/task.json. Use the baseline from .oma/history.md"; scanning
    // the whole line incorrectly grants the write verb to the read-only source.
    const clauses = line.split(/(?:[。！？；]|[.!?;](?=\s|$))\s*/)
    for (const clause of clauses) {
      if (!EXPLICIT_WRITE_VERB_RE.test(clause) || NEGATED_WRITE_RE.test(clause)) continue
      for (const match of clause.matchAll(BACKTICK_PATH_RE)) {
        const target = normalizePromptPath(match[1]!)
        if (target) targets.add(target)
      }
      // Models often omit Markdown delimiters in imperative prose ("create
      // state/ and logs/"). Restrict plain matches to directory-looking tokens
      // or filenames with extensions to avoid treating branch names as paths.
      for (const match of clause.matchAll(PLAIN_PATH_RE)) {
        const target = normalizePromptPath(match[1]!)
        if (target) targets.add(target)
      }
    }
  }
  return [...targets]
}

function normalizePromptPath(raw: string): string | null {
  let path = raw.trim().replace(/^\.\//, '')
  if (!path || path.startsWith('$') || /\s/.test(path) || !path.includes('/')) return null
  // Templates such as exp-loop-iter<N>-<slug> remain beneath the stable prefix.
  path = path.split(/[<*{]/, 1)[0]!.replace(/\/+$/, '')
  if (!path || path === '..' || path.startsWith('../')) return null
  return path
}

function pathCoveredByWriteRule(target: string, declared: string): boolean {
  const prefix = declared.replace(/^\.\//, '').replace(/\/+$/, '')
  return target === prefix || target.startsWith(`${prefix}/`)
}

/** The lane that already declares a write rule covering this path, if any.
 * Used to point a prompt/permission mismatch at the existing owner instead of
 * suggesting a second writer. */
function owningLaneOf(spec: LoopGraphSpec, target: string, exclude: string): string | undefined {
  for (const [laneId, lane] of Object.entries(spec.lanes ?? {})) {
    if (laneId === exclude) continue
    if ((lane?.workspace?.write ?? []).some(rule => typeof rule?.path === 'string' && pathCoveredByWriteRule(target, rule.path))) return laneId
  }
  return undefined
}

function normalizeWritePrefix(path: string): string {
  return path.replace(/^\.\//, '').replace(/\/+$/, '')
}

/**
 * "One path may have only one owning Lane" (see LaneWorkspaceContract.write).
 * A single-writer boundary is the mechanism Distill relies on to keep durable
 * state consistent, and two lanes claiming the same prefix silently dissolves
 * it. The check is a pure prefix comparison over declared rules, so it belongs
 * in deterministic code rather than in the semantic reviewer's prose contract.
 */
function lintLaneWriteOverlap(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  const claims: Array<{ laneId: string; prefix: string }> = []
  for (const [laneId, lane] of Object.entries(spec.lanes ?? {})) {
    for (const rule of lane?.workspace?.write ?? []) {
      if (typeof rule?.path === 'string') claims.push({ laneId, prefix: normalizeWritePrefix(rule.path) })
    }
  }
  const reported = new Set<string>()
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i]!, b = claims[j]!
      if (a.laneId === b.laneId) continue
      if (!pathCoveredByWriteRule(a.prefix, b.prefix) && !pathCoveredByWriteRule(b.prefix, a.prefix)) continue
      const key = [a.laneId, a.prefix, b.laneId, b.prefix].sort().join('|')
      if (reported.has(key)) continue
      reported.add(key)
      findings.push({
        level: 'error', rule: 'lane-write-overlap', at: `lanes.${a.laneId}.workspace.write`,
        message: `lanes '${a.laneId}' ('${a.prefix}') and '${b.laneId}' ('${b.prefix}') both claim write access to overlapping paths; one path may have only one owning Lane — narrow one prefix or route the writes through the single owning Lane`,
      })
    }
  }
}

/**
 * A State field no Reducer ever writes is frozen at its initial value, so every
 * `when` reading it is a dead condition and every threshold on it is
 * unreachable. Distilled graphs repeatedly declared counters the source asked
 * for (rounds, retries, stale streaks) and then never incremented them —
 * detected until now only by the semantic reviewer, which sees each graph once
 * and reported it inconsistently. Set membership is exact, so this belongs in
 * deterministic code.
 */
function lintDeadStateFields(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  const updated = new Set<string>()
  for (const transition of spec.transitions ?? []) {
    for (const update of transition.updates ?? []) {
      if (typeof update?.target === 'string') updated.add(update.target)
    }
  }
  for (const name of Object.keys(spec.state ?? {})) {
    if (updated.has(name)) continue
    findings.push({
      level: 'error', rule: 'dead-state-field', at: `state.${name}`,
      message: `state field '${name}' is never written by any transition update, so it stays at its initial value forever; add the Reducer update that maintains it, or drop it and route on the raw $output fact instead`,
    })
  }
}

/**
 * An input every supplier binds to { "literal": null } can never carry data:
 * the node reads $input.<key>, but its reachable value is exactly null on every
 * incoming transition and entrypoint. The strict $input-closure contract makes
 * { "literal": null } the documented idiom for "absent on THIS path", which
 * also turns it into a validator-blessed escape hatch: a compiler can satisfy
 * closure by nulling a field on every path, silently severing a producer→
 * consumer dataflow the source demanded (evidence records, summaries, payloads
 * — the domain does not matter). All-paths-null is exact set inspection, so it
 * belongs in deterministic code instead of the semantic reviewer's budget.
 * Scope is deliberately narrow to stay domain-neutral:
 * - fires only when EVERY supplier binds literal null — null on just some
 *   edges is the legitimate optional-value idiom;
 * - only literal null — empty strings, false or 0 are real values a graph may
 *   intentionally pass as constants;
 * - only agent/function nodes — a terminal result or effect key of null is a
 *   benign "no payload".
 */
function lintDeadNullInputs(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  const suppliers = new Map<string, Array<{ label: string; inputs: Record<string, unknown> }>>()
  const supply = (node: unknown, label: string, inputs: unknown): void => {
    if (typeof node !== 'string') return
    const list = suppliers.get(node) ?? []
    list.push({
      label,
      inputs: inputs && typeof inputs === 'object' && !Array.isArray(inputs) ? inputs as Record<string, unknown> : {},
    })
    suppliers.set(node, list)
  }
  for (const entry of spec.entrypoints ?? []) supply(entry?.node, `entrypoint '${entry?.id}'`, entry?.inputs)
  for (const transition of spec.transitions ?? []) {
    for (const target of Array.isArray(transition.to) ? transition.to : [transition.to]) {
      if (typeof target === 'string') supply(target, `transition '${transition.id}'`, {})
      else supply(target?.node, `transition '${transition.id}'`, target?.inputs)
    }
  }
  for (const [nodeId, node] of Object.entries(spec.nodes ?? {})) {
    if (!node || (node.type !== 'agent' && node.type !== 'function')) continue
    const referenced = new Set<string>()
    if ('inputs' in node) for (const expression of Object.values(node.inputs ?? {})) collectInputKeys(expression, referenced)
    if (!referenced.size) continue
    const nodeSuppliers = suppliers.get(nodeId) ?? []
    if (!nodeSuppliers.length) continue
    for (const key of referenced) {
      const allNull = nodeSuppliers.every(supplier => {
        const binding = supplier.inputs[key]
        return Boolean(binding) && typeof binding === 'object' && 'literal' in (binding as object)
          && (binding as { literal: unknown }).literal === null
      })
      if (!allNull) continue
      findings.push({
        level: 'error', rule: 'dead-null-input', at: `nodes.${nodeId}.inputs.${key}`,
        message: `every supplier (${nodeSuppliers.map(supplier => supplier.label).join(', ')}) binds $input.${key} to { "literal": null }, so the node can only ever observe null and the dataflow this input was meant to carry is severed; wire at least one edge to a real $output/$state ref (adding the field to the producer outputSchema and passing it through intermediate hops if needed), persist the value into State or a workspace file and read it back, or drop the input`,
      })
    }
  }
}

/** Mirror of GraphValidate's collectInputKeyRefs: top-level $input keys a node
 * spec actually reads, including refs nested in call args. Runtime-injected
 * "__" keys are excluded. */
function collectInputKeys(expression: unknown, output: Set<string>, depth = 0): void {
  if (!expression || typeof expression !== 'object' || Array.isArray(expression) || depth > 20) return
  const record = expression as Record<string, unknown>
  if (typeof record.ref === 'string') {
    const match = /^\$input\.([^.]+)/.exec(record.ref)
    if (match && !match[1]!.startsWith('__')) output.add(match[1]!)
  }
  if (Array.isArray(record.args)) for (const argument of record.args) collectInputKeys(argument, output, depth + 1)
}

const MKDIR_RE = /\bmkdir\b(?:\s+-\w+)*\s+(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`|([^\s;&|]+))/gi

/**
 * write_file / append_file create missing parent directories for an approved
 * target, so an extra `bash mkdir` is dead weight — and worse, it tempts the
 * Compiler to widen a precise per-file rule into an `owned` directory just so
 * the mkdir is permitted. Cheap to detect textually; keep it out of the
 * reviewer's budget.
 */
function lintRedundantMkdir(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  for (const [nodeId, node] of Object.entries(spec.nodes ?? {})) {
    if (!node || node.type !== 'agent') continue
    const lane = spec.lanes?.[node.lane]
    const text = [node.prompt, node.systemInstructions, lane?.agentProfile?.systemInstructions]
      .filter((part): part is string => typeof part === 'string').join('\n')
    for (const match of text.matchAll(MKDIR_RE)) {
      const raw = match[1] ?? match[2] ?? match[3] ?? match[4]
      const target = raw ? normalizePromptPath(raw) : undefined
      if (!target) continue
      const covered = (lane?.workspace?.write ?? []).some(rule => pathCoveredByWriteRule(target, rule.path))
      if (!covered) continue
      findings.push({
        level: 'warning', rule: 'redundant-mkdir', at: `nodes.${nodeId}.prompt`,
        message: `prompt runs 'mkdir ${target}' for a path lane '${node.lane}' already covers; write_file/append_file create missing parent directories for approved targets — drop the mkdir instead of widening the write rule to an owned directory`,
      })
    }
  }
}

const PRECOMPUTED_BOOLEAN_RE = /\$output\.((?:is|should|need|needs|has)_[A-Za-z0-9_]+)\s*[!=]=\s*(?:true|false)/

function lintPrecomputedRouting(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  for (const transition of spec.transitions ?? []) {
    if (typeof transition.when !== 'string') continue
    const match = PRECOMPUTED_BOOLEAN_RE.exec(transition.when)
    if (!match) continue
    findings.push({
      level: 'warning', rule: 'precomputed-routing', at: `transitions '${transition.id}'.when`,
      message: `routes on the agent-precomputed boolean '$output.${match[1]}'; prefer raw facts so the deterministic rule lives in the graph (e.g. "$output.new_findings_count == 0 || $output.improvement == 'worsened'") and add those fields to the outputSchema`,
    })
  }
}

/**
 * Precise dead-route detection for the decidable subclass: a string state
 * variable whose every update is a literal `builtin/set`. Its reachable value
 * domain is exactly {initial} ∪ {set literals}; an equality route against a
 * value outside that domain can never fire.
 */
function lintDeadLiteralRoutes(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  for (const [name, variable] of Object.entries(spec.state ?? {})) {
    if (typeof variable?.initial !== 'string') continue
    const domain = new Set<string>([variable.initial])
    let fullyLiteral = true
    for (const transition of spec.transitions ?? []) for (const update of transition.updates ?? []) {
      if (update.target !== name) continue
      const argument = update.args?.[0]
      if (update.reducer?.startsWith('builtin/set@') && update.args?.length === 1 &&
          argument && typeof argument === 'object' && 'literal' in argument && typeof argument.literal === 'string') {
        domain.add(argument.literal)
      } else fullyLiteral = false
    }
    if (!fullyLiteral) continue
    const equalityRe = new RegExp(`\\$state\\.${name}\\s*==\\s*'([^']*)'`, 'g')
    for (const transition of spec.transitions ?? []) {
      if (typeof transition.when !== 'string') continue
      for (const match of transition.when.matchAll(equalityRe)) {
        if (domain.has(match[1]!)) continue
        findings.push({
          level: 'warning', rule: 'dead-literal-route', at: `transitions '${transition.id}'.when`,
          message: `compares $state.${name} to '${match[1]}' but reducers only ever assign {${[...domain].join(', ')}}; this route can never fire — remove it or assign the value somewhere`,
        })
      }
    }
  }
}

export function formatGraphLintFindings(findings: readonly GraphLintFinding[]): string[] {
  return findings.map(finding => `lint(${finding.level}) ${finding.rule} at ${finding.at}: ${finding.message}`)
}

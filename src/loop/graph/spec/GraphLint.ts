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
  rule: 'absolute-path' | 'outside-project-write' | 'undeclared-workspace-write' | 'prompt-writes-denied-path' | 'git-without-capability' | 'precomputed-routing' | 'single-agent-terminal-authority' | 'duplicate-route-condition' | 'same-lane-agent-split' | 'dead-literal-route' | 'unbounded-wait' | 'mixed-snapshot-routing' | 'static-effect-idempotency' | 'terminal-fanout-cancellation' | 'agent-budget-walltime' | 'lane-write-overlap' | 'redundant-mkdir' | 'dead-state-field' | 'dead-null-input' | 'shadowed-route' | 'terminal-route-shadowed' | 'terminal-unreachable'
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
  lintSingleAgentTerminalAuthority(spec, findings)
  lintDuplicateRouteConditions(spec, findings)
  lintShadowedRoutes(spec, findings)
  lintTerminalRouteShadowing(spec, findings)
  lintSameLaneAgentSplits(spec, findings)
  lintDeadLiteralRoutes(spec, findings)
  lintUnboundedWaits(spec, findings)
  lintMixedSnapshotRouting(spec, findings)
  lintStaticEffectIdempotency(spec, findings)
  lintTerminalFanOut(spec, findings)
  lintUnreachableTerminals(spec, findings)
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
/**
 * Splitting one agent's work across nodes is a smell only when the nodes are
 * ALTERNATIVES — bootstrap/pivot/monitor variants the loop keeps flipping
 * between. Nodes arranged in SEQUENCE are a different thing entirely: a
 * source-mandated phase order (convert → retarget → train, each with its own
 * counters and gate) is exactly the structure that keeps the phase out of every
 * `when` conjunct, and flagging it would argue against the design the Compiler
 * is now told to produce.
 *
 * Mutual reachability separates the two precisely: alternatives can reach each
 * other, sequential stages cannot go back.
 */
function lintSameLaneAgentSplits(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  const reach = reachableNodeSets(spec)
  for (const [laneId, lane] of Object.entries(spec.lanes ?? {})) {
    if (lane.context !== 'persistent') continue
    const agents = Object.entries(spec.nodes ?? {})
      .filter(([, node]) => node?.type === 'agent' && node.lane === laneId)
      .map(([nodeId]) => nodeId)
    if (agents.length < 2) continue
    const alternating = agents.filter(agent =>
      agents.some(other => other !== agent && reach.get(agent)?.has(other) && reach.get(other)?.has(agent)))
    if (alternating.length < 2) continue
    findings.push({
      level: 'warning', rule: 'same-lane-agent-split', at: `lanes.${laneId}`,
      message: `persistent lane contains ${alternating.length} mutually reachable Agent nodes (${alternating.join(', ')}) — the loop can flip between them, so they are alternatives rather than sequential stages; verify every split has an independent persistence, permission/concurrency, Kernel Wait/Event, failure-isolation, or terminal boundary — a different prompt, role name, first-run flag, or budget is not such a boundary; otherwise merge bootstrap/pivot/monitor phases into one autonomous Agent mode`,
    })
  }
}

/** Forward reachability closure over transition targets, for every node. */
function reachableNodeSets(spec: LoopGraphSpec): Map<string, Set<string>> {
  const edges = new Map<string, string[]>()
  for (const transition of spec.transitions ?? []) {
    if (typeof transition?.from !== 'string') continue
    edges.set(transition.from, [...(edges.get(transition.from) ?? []), ...targetNodeIds(transition.to)])
  }
  const closure = new Map<string, Set<string>>()
  for (const start of Object.keys(spec.nodes ?? {})) {
    const seen = new Set<string>()
    const queue = [...(edges.get(start) ?? [])]
    while (queue.length) {
      const next = queue.shift()!
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(...(edges.get(next) ?? []))
    }
    closure.set(start, seen)
  }
  return closure
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
      message: `has the same from/on/when predicate as transition '${first}'; routing is first-match in declaration order, so '${first}' always wins and this edge is dead — merge the two branches, or change this predicate to the case it was actually meant to catch`,
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


/** Conditional edges of one from+on group, in descending priority. */
/** Evaluation order for one (from, on): priority first, then declaration order.
 * `Array.prototype.sort` is stable, so equal priorities keep array order —
 * exactly what `decideTransition` does. */
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
          message: `every condition of the earlier transition '${strong.id}' also appears in this one, so whenever this edge matches '${strong.id}' matches too and is evaluated first — this route can never fire; move this edge BEFORE '${strong.id}' in the transitions array (routing is first-match in declaration order), or drop it if '${strong.id}' already covers it`,
        })
        break
      }
    }
  }
}



/**
 * `route-partition-gap` used to live here.
 *
 * It enumerated a group's truth table and reported the partitions no
 * conditional edge claimed. That was worth reporting only while routing was a
 * flat set of edges that had to tile their own value space: a cell nobody
 * claimed might have been an oversight. Conditional edges out of one (from, on)
 * are now an ORDERED first-match list ending in an explicit default, so
 * "matches no earlier branch, therefore takes the default" is not a gap — it is
 * how the construct is defined. On a real graph the rule fired with 20 of 288
 * partitions falling through, every one of them correct, and that noise went
 * into the reviewer's must-verify list.
 */

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
          message: `this edge routes to a Terminal on a $state threshold, but the earlier transition '${looping.id}' continues the loop and its condition is not provably exclusive with this one — in the overlap the loop is matched first and the bound never takes effect; move this edge BEFORE '${looping.id}' in the transitions array (a source-mandated limit belongs above the branches that continue the loop)`,
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
 * A work Agent may propose completion, but a semantic boolean from that same
 * Agent is not an independent completion certificate. This is a warning rather
 * than a mechanical rejection because a read-only independent reviewer is also
 * an Agent node; semantic review verifies that authority boundary using the
 * source contract and Lane ownership.
 */
function lintSingleAgentTerminalAuthority(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  for (const transition of spec.transitions ?? []) {
    if ((transition.on ?? 'success') !== 'success') continue
    const source = spec.nodes[transition.from]
    if (source?.type !== 'agent') continue
    const businessTerminal = targetNodeIds(transition.to).some(nodeId => {
      const target = spec.nodes[nodeId]
      return target?.type === 'terminal' && (target.status === 'done' || target.status === 'failed')
    })
    if (!businessTerminal || isIndependentReadOnlyReviewer(spec, transition.from)) continue
    findings.push({
      level: 'warning',
      rule: 'single-agent-terminal-authority',
      at: `transitions '${transition.id}'`,
      message: `work-producing agent '${transition.from}' reaches a business Terminal from its own success; route the completion candidate and evidence through an independent read-only Agent on a different Lane (or a registered deterministic Function) before done/failed`,
    })
  }
}

function isIndependentReadOnlyReviewer(spec: LoopGraphSpec, nodeId: string): boolean {
  const node = spec.nodes[nodeId]
  if (node?.type !== 'agent') return false
  const lane = spec.lanes[node.lane]
  if ((lane?.workspace.write ?? []).length > 0) return false
  return (spec.transitions ?? []).some(transition =>
    transition.from !== nodeId &&
    spec.nodes[transition.from]?.type === 'agent' &&
    targetNodeIds(transition.to).includes(nodeId) &&
    (spec.nodes[transition.from] as { lane?: string }).lane !== node.lane)
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

/**
 * Terminal reachability — a graph algorithm, not a judgement call.
 *
 * "The terminal cannot be reached" used to be part of a blocking semantic rule
 * class, which meant a sampling LLM was asked to infer, from prose and a JSON
 * manifest, something that is exactly decidable. It produced both false
 * positives (rejecting graphs that ran fine) and a re-derivation cost on every
 * review round.
 *
 * The closure below deliberately ignores `when`: every Transition is treated as
 * potentially firing, so the result is an UPPER BOUND on reachability. A
 * terminal outside an upper bound is unreachable under every possible condition
 * assignment, which makes this rule exact in one direction and silent in the
 * other — zero false positives, which is the property that lets the reviewer
 * stop checking it entirely.
 */
function lintUnreachableTerminals(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  const terminals = Object.entries(spec.nodes ?? {}).filter(([, node]) => node?.type === 'terminal').map(([id]) => id)
  if (!terminals.length) return
  const outgoing = new Map<string, string[]>()
  for (const transition of spec.transitions ?? []) {
    if (typeof transition?.from !== 'string') continue
    const targets = (Array.isArray(transition.to) ? transition.to : [transition.to])
      .map(target => typeof target === 'string' ? target : target?.node)
      .filter((node): node is string => typeof node === 'string')
    outgoing.set(transition.from, [...(outgoing.get(transition.from) ?? []), ...targets])
  }
  const reachable = new Set<string>()
  const queue = (spec.entrypoints ?? []).map(entrypoint => entrypoint?.node).filter((node): node is string => typeof node === 'string')
  // No entrypoints at all is an ABI concern, not this rule's business; without
  // a starting set every terminal would be reported and the signal would be
  // noise.
  if (!queue.length) return
  for (const node of queue) reachable.add(node)
  while (queue.length) {
    const current = queue.shift()!
    for (const next of outgoing.get(current) ?? []) {
      if (reachable.has(next)) continue
      reachable.add(next)
      queue.push(next)
    }
  }
  for (const terminal of terminals) {
    if (reachable.has(terminal)) continue
    findings.push({
      level: 'error', rule: 'terminal-unreachable', at: `nodes.${terminal}`,
      message: 'no sequence of Transitions reaches this terminal from any entrypoint, even ignoring every `when` condition; route to it or remove it',
    })
  }
}

export function formatGraphLintFindings(findings: readonly GraphLintFinding[]): string[] {
  return findings.map(finding => `lint(${finding.level}) ${finding.rule} at ${finding.at}: ${finding.message}`)
}

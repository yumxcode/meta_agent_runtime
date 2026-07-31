import { createHash } from 'node:crypto'
import type { JsonValue, LoopGraphSpec, NodeSpec, ValueExpression } from '../spec/GraphTypes.js'

export const LOOP_CONSTRAINTS_SCHEMA = 'loop-constraints-2.0' as const
export const LOOP_BLUEPRINT_SCHEMA = 'loop-blueprint-2.0' as const
export const LOOP_DESIGN_SCHEMA = LOOP_BLUEPRINT_SCHEMA
export const GRAPH_TRACEABILITY_SCHEMA = 'graph-traceability-2.0' as const
export const GRAPH_MANIFEST_SCHEMA = 'graph-manifest-2.0' as const
/**
 * 2.2 adds the per-constraint verdict table. The reviewer used to report a
 * sampled handful of findings per round, which made "it did not mention C7"
 * indistinguishable from "it decided C7 is satisfied" — the mechanism behind
 * the observed "every round reports different problems". A complete table
 * removes the ambiguity; the ratchet below then keeps the answered subset from
 * being re-derived every round.
 */
export const SEMANTIC_REVIEW_SCHEMA = 'loop-semantic-review-2.2' as const
/** Read-compatible only: historical artifacts render, but never re-adjudicate. */
export const LEGACY_SEMANTIC_REVIEW_SCHEMAS = ['loop-semantic-review-2.1'] as const
export const LOOP_PRECONDITIONS_SCHEMA = 'loop-preconditions-1.0' as const

export type LoopConstraintKind =
  | 'goal' | 'success_criteria' | 'deterministic_rule' | 'workspace_protocol'
  | 'terminal_obligation' | 'ownership' | 'capability' | 'timer' | 'event'
  | 'failure_boundary' | 'recovery' | 'budget' | 'other'

export interface LoopSourceRef { path: string; locator: string; excerpt?: string }

/**
 * Who produced a ledger entry.
 *
 * Absent means `architect`, which keeps the compatibility path (no Intake
 * record) byte-identical to its previous behaviour. When an Intake record is
 * present the Architect may still APPEND entries — it is the only stage that
 * reads the real project, so discovering an obligation the human never wrote
 * down is its job — but it may not restate, reclassify or weaken an entry the
 * human already confirmed. That asymmetry is enforced mechanically by
 * `validateIntakeLedgerPreservation`, not by prompt discipline.
 */
export type LoopConstraintOrigin = 'intake' | 'architect'
export const LOOP_CONSTRAINT_ORIGINS: readonly LoopConstraintOrigin[] = ['intake', 'architect']

export interface LoopConstraint {
  id: string
  kind: LoopConstraintKind
  statement: string
  strength: 'hard' | 'soft'
  sources: LoopSourceRef[]
  acceptance?: string[]
  origin?: LoopConstraintOrigin
}
export interface LoopConstraintLedger {
  schemaVersion: typeof LOOP_CONSTRAINTS_SCHEMA
  goal: string
  constraints: LoopConstraint[]
  unresolved?: Array<{ id: string; question: string; affects: string[] }>
}

/**
 * Where a constraint is enforced — the missing axis that made semantic review
 * unsatisfiable.
 *
 * Architect and Compiler are both told to prefer a sparse control skeleton with
 * thick Agent nodes, i.e. to keep tightly-coupled semantics *inside* the Agent.
 * Review then demanded that every hard constraint resolve to an executable
 * Graph element. A goal like "pick the hypothesis most worth testing" has no
 * such element and never can: the only ways to produce one are forbidden
 * (inventing a Function) or rejected (pointing at prose). Those findings were
 * unfixable by construction, and their number grew with the length of the
 * source document.
 *
 * The locus makes the split explicit:
 *   - `graph` — must resolve to routing, permission or a bound. This is the
 *     determinism the design actually asks for.
 *   - `agent` — deliberately delegated to the long-lived work Agent; the
 *     obligation is that it is briefed, not that the Graph encodes the domain
 *     procedure.
 *   - `reviewer` — a completion/gate claim needs an authority independent of
 *     the Agent that produced the work. It is implemented by a read-only Agent
 *     reviewer or a registered deterministic Function, never by trusting the
 *     worker's own "done" boolean.
 *   - `human` — cannot be settled by either; belongs in preconditions.
 *
 * Derived by the host from `kind`, never chosen by a model. `kind` is already a
 * closed enum the Architect assigns against the source text before any Graph
 * exists, so there is no path by which a later stage can relabel an
 * inconvenient routing rule as "judgement" to get a candidate through.
 */
export type SemanticEnforcementLocus = 'graph' | 'agent' | 'reviewer' | 'human'

/** Unclassifiable kinds default to the thick Agent. Graph is the governance
 * shell, not a domain workflow compiler; an unknown prose obligation must not
 * manufacture State/Transition structure merely because its label is broad. */
const ENFORCEMENT_LOCUS_BY_KIND: Readonly<Record<LoopConstraintKind, SemanticEnforcementLocus>> = {
  deterministic_rule: 'graph',
  workspace_protocol: 'graph',
  ownership: 'graph',
  terminal_obligation: 'graph',
  failure_boundary: 'graph',
  budget: 'graph',
  timer: 'graph',
  event: 'graph',
  // Operational recovery is normally an in-Activation skill/tool procedure.
  // Only its cross-Activation bound or terminal consequence is Graph-owned and
  // should be extracted separately as budget/failure_boundary.
  recovery: 'agent',
  other: 'agent',
  // Intent-shaped: the source states an outcome to pursue, not a rule to encode.
  goal: 'agent',
  // The worker may propose completion, but cannot certify its own work.
  success_criteria: 'reviewer',
  // A capability the runtime does not have is not a lowering defect.
  capability: 'human',
}

export function deriveEnforcementLocus(kind: LoopConstraintKind): SemanticEnforcementLocus {
  return ENFORCEMENT_LOCUS_BY_KIND[kind] ?? 'agent'
}

/** Constraint id → locus, for the reviewer contract and traceability checks. */
export function enforcementLocusIndex(ledger: LoopConstraintLedger): Map<string, SemanticEnforcementLocus> {
  const index = new Map<string, SemanticEnforcementLocus>()
  for (const constraint of ledger.constraints ?? []) {
    if (constraint?.id) index.set(constraint.id, deriveEnforcementLocus(constraint.kind))
  }
  return index
}

/** Compact per-constraint locus table injected into the reviewer prompt. */
export function formatEnforcementLoci(ledger: LoopConstraintLedger): string {
  const rows = (ledger.constraints ?? [])
    .filter(constraint => constraint?.id)
    .map(constraint => `${constraint.id}=${deriveEnforcementLocus(constraint.kind)}(${constraint.kind})`)
  return rows.join(' · ')
}

/** Small semantic handoff. The executable structure exists only in LoopGraphSpec. */
export interface LoopBlueprint {
  schemaVersion: typeof LOOP_BLUEPRINT_SCHEMA
  goal: string
  intent: string
  successCriteria: string[]
  workspace: string[]
  lanes: string[]
  control: string[]
  assumptions: string[]
  capabilityGaps: string[]
}
export type LayeredLoopDesign = LoopBlueprint

export interface GraphTraceabilityMap {
  schemaVersion: typeof GRAPH_TRACEABILITY_SCHEMA
  mappings: Array<{ constraintId: string; graphRefs: string[]; rationale: string }>
}

export interface GraphImplementationManifest {
  schemaVersion: typeof GRAPH_MANIFEST_SCHEMA
  graph: { id: string; version: number; goal: string }
  state: Record<string, { type: unknown; initial: JsonValue }>
  lanes: Record<string, unknown>
  nodes: Record<string, unknown>
  transitions: unknown[]
  entrypoints: unknown[]
  limits: unknown
}

export const SEMANTIC_REVIEW_LAYERS = [
  'intent_constraints',
  'workspace_contract',
  'lane_ownership',
  'control_flow',
  'capability_resolution',
  'runtime_preconditions',
] as const
export type SemanticReviewLayer = typeof SEMANTIC_REVIEW_LAYERS[number]

/**
 * Machine-checkable launch contract. Distill lists everything the loop needs
 * to exist BEFORE the first activation (files the loop itself never creates,
 * external CLIs, credentials) plus every decision the Architect could not
 * resolve from the source (ask_user unavailable/timeout, defaults taken).
 * `loop create` verifies file/directory items mechanically and refuses to
 * start while blocking decisions remain unconfirmed.
 */
export type LoopPreconditionKind = 'file' | 'directory' | 'command' | 'credential' | 'decision'
export interface LoopPrecondition {
  kind: LoopPreconditionKind
  /** Project-relative path, command name, credential name, or decision id. */
  target: string
  reason: string
  /** Blocking items stop `loop create` when unmet; default true. */
  blocking?: boolean
}
export interface LoopPreconditions {
  schemaVersion: typeof LOOP_PRECONDITIONS_SCHEMA
  items: LoopPrecondition[]
}

export function emptyLoopPreconditions(): LoopPreconditions {
  return { schemaVersion: LOOP_PRECONDITIONS_SCHEMA, items: [] }
}

export function validateLoopPreconditions(value: LoopPreconditions): string[] {
  const errors: string[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['preconditions must be an object']
  if (value.schemaVersion !== LOOP_PRECONDITIONS_SCHEMA) errors.push(`preconditions.schemaVersion must be '${LOOP_PRECONDITIONS_SCHEMA}'`)
  if (!Array.isArray(value.items)) { errors.push('preconditions.items must be an array'); return errors }
  const kinds: LoopPreconditionKind[] = ['file', 'directory', 'command', 'credential', 'decision']
  for (const [index, item] of value.items.entries()) {
    const at = `preconditions.items[${index}]`
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`${at} must be an object`); continue }
    if (!kinds.includes(item.kind)) errors.push(`${at}.kind must be one of ${kinds.join(', ')}`)
    if (!text(item.target)) errors.push(`${at}.target must be non-empty`)
    if (!text(item.reason)) errors.push(`${at}.reason must be non-empty`)
    if (item.blocking !== undefined && typeof item.blocking !== 'boolean') errors.push(`${at}.blocking must be a boolean`)
    if ((item.kind === 'file' || item.kind === 'directory') && typeof item.target === 'string' &&
        (item.target.startsWith('/') || item.target.startsWith('\\') || item.target.split(/[\\/]/).some(part => part === '..'))) {
      errors.push(`${at}.target must be a project-relative path`)
    }
  }
  return errors
}

/**
 * Severity vocabulary for the semantic reviewer.
 *
 * The reviewer used to be all-or-nothing: any layer `fail` rejected the graph,
 * and the prompt forbade `warnings` outright. That made every stylistic
 * observation as fatal as an unimplemented hard constraint, so a run could
 * bounce indefinitely on a different cosmetic finding each round while the
 * mechanical linter — the one component with no sampling variance — happily
 * distinguished `error` from `warning`.
 *
 * Severity is now derived by the HOST from the rule class, never chosen by the
 * model. That preserves the invariant the old prompt was protecting: a reviewer
 * cannot downgrade a real hard-contract violation to "advisory" and let the
 * graph through, because picking `unimplemented-hard-constraint` is by
 * definition blocking. Misfiling remains possible, but a fixed enum is
 * auditable in the trace where free-text warnings were not.
 */
export const BLOCKING_SEMANTIC_RULE_CLASSES = [
  'unimplemented-hard-constraint',
  'constraint-weakened',
  'dangling-traceability',
  'fabricated-capability',
  'annotation-only-satisfaction',
  /** An `agent`-locus constraint the responsible node was never told about.
   * Delegating a constraint to Agent judgement is legitimate; delegating it to
   * nobody is not. */
  'unbriefed-agent-constraint',
  'unbounded-or-unreachable-control',
  'missing-source-bound',
  /** A work-producing Agent's success output reaches a done/failed business
   * Terminal without an independent read-only reviewer or deterministic gate. */
  'single-agent-terminal-authority',
  'writer-boundary-bypass',
  'state-routing-divergence',
  'missing-precondition',
] as const

export const ADVISORY_SEMANTIC_RULE_CLASSES = [
  /** A control-flow rejection the reviewer could not back with a structurally
   * valid witness. The observation is kept — it is often a real smell — but it
   * no longer stops a graph that nobody could demonstrate is broken. */
  'unwitnessed-control-flow',
  'topology-granularity',
  'session-continuity',
  'budget-shape',
  'semantic-classification',
  'threshold-truth-table',
  'branch-priority',
  'commit-ordering',
  'workspace-mode-mismatch',
  'overreach-obligation',
] as const

export const SEMANTIC_RULE_CLASSES = [
  ...BLOCKING_SEMANTIC_RULE_CLASSES,
  ...ADVISORY_SEMANTIC_RULE_CLASSES,
] as const
export type SemanticRuleClass = typeof SEMANTIC_RULE_CLASSES[number]

const BLOCKING_RULE_CLASS_SET: ReadonlySet<string> = new Set(BLOCKING_SEMANTIC_RULE_CLASSES)

export function isBlockingSemanticRuleClass(ruleClass: string): ruleClass is typeof BLOCKING_SEMANTIC_RULE_CLASSES[number] {
  return BLOCKING_RULE_CLASS_SET.has(ruleClass)
}

/**
 * Control-flow rejections must come with a witness.
 *
 * These three classes are the ones that ask the reviewer to derive a truth
 * table from prose, and they are where false positives concentrate. A real
 * unreachable terminal, a real exceeded bound and a real stale read all have a
 * concrete witness: an assignment of State plus the sequence of Transitions it
 * enables. "This looks under-specified" does not. Requiring the witness costs
 * a genuine finding nothing and costs a guess everything.
 */
export const WITNESS_REQUIRED_RULE_CLASSES = [
  'unbounded-or-unreachable-control',
  'missing-source-bound',
  'state-routing-divergence',
] as const

export type ControlFlowWitnessOutcome =
  | 'terminal_unreachable' | 'bound_exceeded' | 'route_uncovered' | 'stale_state_read'
export const CONTROL_FLOW_WITNESS_OUTCOMES: readonly ControlFlowWitnessOutcome[] =
  ['terminal_unreachable', 'bound_exceeded', 'route_uncovered', 'stale_state_read']

export interface ControlFlowWitness {
  /** Keys must be real `graph.state` fields. */
  state: Record<string, JsonValue>
  /** Transition ids, in trigger order, each real and each chained end-to-start. */
  path: string[]
  outcome: ControlFlowWitnessOutcome
}

export function requiresControlFlowWitness(ruleClass: string): boolean {
  return (WITNESS_REQUIRED_RULE_CLASSES as readonly string[]).includes(ruleClass)
}

/**
 * Mechanical witness check. Deliberately structural only: the host verifies
 * that the cited State fields and Transition ids exist and that the path is
 * actually connected, never that the scenario is semantically compelling.
 * Fabricating a structurally valid path is more work than filing the finding as
 * advisory, and the attempt is visible in the trace.
 */
export function validateControlFlowWitness(witness: ControlFlowWitness, graph: LoopGraphSpec): string[] {
  const errors: string[] = []
  if (!witness || typeof witness !== 'object' || Array.isArray(witness)) return ['witness must be an object']
  if (!CONTROL_FLOW_WITNESS_OUTCOMES.includes(witness.outcome)) {
    errors.push(`witness.outcome must be one of ${CONTROL_FLOW_WITNESS_OUTCOMES.join(', ')}`)
  }
  if (!witness.state || typeof witness.state !== 'object' || Array.isArray(witness.state)) {
    errors.push('witness.state must be an object of State field assignments')
  } else {
    for (const field of Object.keys(witness.state)) {
      if (!(field in (graph.state ?? {}))) errors.push(`witness.state references unknown State field '${field}'`)
    }
  }
  if (!Array.isArray(witness.path) || !witness.path.length) {
    errors.push('witness.path must be a non-empty array of Transition ids')
    return errors
  }
  const transitions = new Map((graph.transitions ?? []).filter(item => typeof item?.id === 'string').map(item => [item.id, item]))
  let previousTargets: Set<string> | undefined
  for (const [index, id] of witness.path.entries()) {
    const transition = transitions.get(id)
    if (!transition) { errors.push(`witness.path[${index}] references unknown Transition '${id}'`); previousTargets = undefined; continue }
    if (previousTargets && !previousTargets.has(transition.from)) {
      errors.push(`witness.path[${index}] ('${id}') starts at '${transition.from}', which the previous Transition does not reach`)
    }
    previousTargets = new Set((Array.isArray(transition.to) ? transition.to : [transition.to])
      .map(target => typeof target === 'string' ? target : target.node))
  }
  return errors
}

export interface SemanticFinding {
  ruleClass: SemanticRuleClass
  statement: string
  sourceRefs: string[]
  designRefs: string[]
  graphRefs: string[]
  /** Required for `WITNESS_REQUIRED_RULE_CLASSES`; a finding whose witness is
   * missing or structurally invalid is demoted to advisory by the host. */
  witness?: ControlFlowWitness
}

export type ConstraintVerdictValue = 'satisfied' | 'violated' | 'out_of_scope'

/**
 * One row per hard constraint in the round's review scope.
 *
 * `out_of_scope` is an intentionally open door: it does not block, because
 * closing it would push the pipeline back toward "cannot produce a graph",
 * which is the binding constraint today. It is instead made expensive to use
 * carelessly — `justification` is mandatory, and every use on a graph- or
 * reviewer-locus constraint is traced and surfaced as an advisory. Whether it
 * becomes a real escape hatch is a question for the trace, not for a guess.
 */
export interface ConstraintVerdictRow {
  constraintId: string
  verdict: ConstraintVerdictValue
  /** Required when `violated`. */
  ruleClass?: SemanticRuleClass
  /** Required when `out_of_scope`. */
  justification?: string
  graphRefs: string[]
}

export interface LayeredSemanticReview {
  schemaVersion: typeof SEMANTIC_REVIEW_SCHEMA
  /** Computed by the host from the findings' rule classes; a model-supplied
   * value is discarded during parsing. */
  accepted: boolean
  /** Must cover every hard constraint in this round's review scope. A missing
   * row voids the whole verdict — the enumeration contract is worth nothing if
   * rows may be skipped. */
  verdicts: ConstraintVerdictRow[]
  layers: Record<SemanticReviewLayer, {
    status: 'pass' | 'fail' | 'not_applicable'
    evidence: Array<{ sourceRefs: string[]; designRefs: string[]; graphRefs: string[]; statement: string }>
    findings: SemanticFinding[]
  }>
  /** Flattened blocking findings — the set that actually rejected the graph. */
  issues: string[]
  /** Flattened advisory findings — recorded and fed back, never blocking. */
  advisories: string[]
}

/** Every finding across all layers, in layer order. */
export function semanticFindings(review: LayeredSemanticReview): SemanticFinding[] {
  return SEMANTIC_REVIEW_LAYERS.flatMap(layer => review.layers[layer]?.findings ?? [])
}

/**
 * Cross-round verdict ledger — the host's answer to a moving target.
 *
 * The reviewer is stateless and re-derives its verdict from scratch every
 * round, so a graph could bounce indefinitely: round 1 reports C3, the compiler
 * fixes C3, round 2 reports C9 (which round 1 never mentioned and which was
 * always broken), and the semantic repair budget — three rounds — is gone. The
 * ledger makes the reviewer's answers stick: a constraint that passed is not
 * re-adjudicated while the evidence it was judged against is unchanged.
 *
 * There is deliberately NO full re-review before acceptance. That was
 * considered and rejected: it puts its cost on the single most valuable round,
 * and today's binding failure is "no graph at all" rather than "a wrong graph".
 * The residual risk — a carried verdict that a later edit silently invalidated
 * — is instead made observable: the fingerprint reaches beyond the constraint's
 * own pointers (see `hashPointerRegions`), and every carry is traced so the
 * question can later be settled with data instead of intuition.
 */
export interface ConstraintVerdict {
  constraintId: string
  verdict: 'pass' | 'fail'
  /** Fingerprint of the graph regions this conclusion rested on. */
  evidenceHash: string
  ruleClass?: SemanticRuleClass
  decidedAtCompilerAttempt: number
  /** The `pass` came from `out_of_scope`, not from a positive verification.
   * Carrying one of these forward is the single blind spot this design
   * knowingly creates, so it is labelled rather than blended in. */
  outOfScope?: boolean
}

/**
 * Fingerprint the evidence a verdict rested on.
 *
 * Beyond the constraint's own `graphRefs` this folds in three regions that are
 * known to change a conclusion from a distance: `/limits`, `/concurrency`, and
 * the Lane contract of every node the constraint points at. Editing any of them
 * invalidates every verdict at once — which is exactly the intent, since
 * without a final full re-review those are the edits most likely to break a
 * constraint whose own pointers never moved.
 *
 * Any ambiguity resolves toward re-review: a pointer that no longer resolves
 * hashes differently from one that does, so a vanished mapping re-opens the
 * constraint rather than silently preserving its verdict.
 */
export function hashPointerRegions(graph: LoopGraphSpec, refs: readonly string[]): string {
  const regions: unknown[] = []
  for (const pointer of [...refs].sort()) regions.push([pointer, resolveJsonPointer(graph, pointer)])
  regions.push(['/limits', (graph as { limits?: unknown }).limits ?? null])
  regions.push(['/concurrency', (graph as { concurrency?: unknown }).concurrency ?? null])
  for (const laneId of [...lanesTouchedBy(graph, refs)].sort()) {
    regions.push([`/lanes/${laneId}`, graph.lanes?.[laneId] ?? null])
  }
  return createHash('sha256').update(canonicalJson(regions)).digest('hex')
}

function lanesTouchedBy(graph: LoopGraphSpec, refs: readonly string[]): Set<string> {
  const lanes = new Set<string>()
  for (const pointer of refs) {
    const nodeMatch = /^\/nodes\/([^/]+)/.exec(pointer)
    if (nodeMatch) {
      const node = graph.nodes?.[decodePointerSegment(nodeMatch[1]!)] as { lane?: unknown } | undefined
      if (typeof node?.lane === 'string') lanes.add(node.lane)
      continue
    }
    const laneMatch = /^\/lanes\/([^/]+)/.exec(pointer)
    if (laneMatch) lanes.add(decodePointerSegment(laneMatch[1]!))
  }
  return lanes
}

/** Constraints whose evidence moved since their verdict, and therefore need a
 * fresh adjudication this round. */
export function staleVerdicts(
  ledger: readonly ConstraintVerdict[],
  traceability: GraphTraceabilityMap,
  graph: LoopGraphSpec,
): Set<string> {
  const refsById = new Map((traceability?.mappings ?? []).map(item => [item.constraintId, safeStrings(item.graphRefs)]))
  const stale = new Set<string>()
  for (const verdict of ledger) {
    const refs = refsById.get(verdict.constraintId)
    // No mapping at all is not "unchanged" — the constraint lost its anchor.
    if (!refs) { stale.add(verdict.constraintId); continue }
    if (hashPointerRegions(graph, refs) !== verdict.evidenceHash) stale.add(verdict.constraintId)
  }
  return stale
}

/** Deterministic serialization: object key order must not perturb a hash. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~')
}

function resolveJsonPointer(root: unknown, pointer: string): unknown {
  if (pointer === '') return root
  if (!pointer.startsWith('/')) return undefined
  let value: unknown = root
  for (const raw of pointer.slice(1).split('/')) {
    const part = decodePointerSegment(raw)
    if (!value || typeof value !== 'object') return undefined
    if (Array.isArray(value) && !/^\d+$/.test(part)) return undefined
    if (!(part in (value as Record<string, unknown>))) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

export function formatSemanticFinding(finding: SemanticFinding): string {
  const refs = [...finding.sourceRefs, ...finding.designRefs, ...finding.graphRefs]
  return refs.length ? `[${finding.ruleClass}] ${finding.statement} (${refs.join(', ')})` : `[${finding.ruleClass}] ${finding.statement}`
}

export function validateConstraintLedger(value: LoopConstraintLedger): string[] {
  const errors: string[] = []
  if (value.schemaVersion !== LOOP_CONSTRAINTS_SCHEMA) errors.push(`constraints.schemaVersion must be '${LOOP_CONSTRAINTS_SCHEMA}'`)
  if (!text(value.goal)) errors.push('constraints.goal must be non-empty')
  if (!Array.isArray(value.constraints) || !value.constraints.length) errors.push('constraints.constraints must be a non-empty array')
  const ids = new Set<string>()
  const kinds: LoopConstraintKind[] = ['goal', 'success_criteria', 'deterministic_rule', 'workspace_protocol', 'terminal_obligation', 'ownership', 'capability', 'timer', 'event', 'failure_boundary', 'recovery', 'budget', 'other']
  for (const [index, constraint] of (Array.isArray(value.constraints) ? value.constraints : []).entries()) {
    const at = `constraints.constraints[${index}]`
    if (!id(constraint.id)) errors.push(`${at}.id is invalid`)
    else if (ids.has(constraint.id)) errors.push(`${at}.id '${constraint.id}' is duplicated`)
    else ids.add(constraint.id)
    if (!text(constraint.statement)) errors.push(`${at}.statement must be non-empty`)
    if (!kinds.includes(constraint.kind)) errors.push(`${at}.kind is invalid`)
    if (!['hard', 'soft'].includes(constraint.strength)) errors.push(`${at}.strength is invalid`)
    const sources = Array.isArray(constraint.sources) ? constraint.sources : []
    if (!sources.length) errors.push(`${at}.sources must identify at least one original source`)
    for (const [sourceIndex, source] of sources.entries()) {
      if (!text(source.path) || !text(source.locator)) errors.push(`${at}.sources[${sourceIndex}] needs path and locator`)
    }
    if (constraint.acceptance !== undefined && !stringList(constraint.acceptance)) errors.push(`${at}.acceptance must be a string array`)
    if (constraint.origin !== undefined && !LOOP_CONSTRAINT_ORIGINS.includes(constraint.origin)) {
      errors.push(`${at}.origin must be one of ${LOOP_CONSTRAINT_ORIGINS.join(', ')}`)
    }
  }
  if (value.unresolved !== undefined && !Array.isArray(value.unresolved)) errors.push('constraints.unresolved must be an array')
  return errors
}

/**
 * The human's confirmed entries are immutable; everything else is the model's.
 *
 * Intake exists so the single highest-leverage decision in the pipeline — a
 * constraint's `kind`, which mechanically derives its enforcement locus — gets
 * human review instead of a one-shot guess. That value evaporates entirely if
 * a later stage may quietly restate the entry, so the check is byte-exact and
 * lives in the host rather than in the Architect's system prompt.
 *
 * Appending is deliberately allowed (see `LoopConstraintOrigin`); only the
 * approved subset is frozen.
 */
export function validateIntakeLedgerPreservation(
  candidate: LoopConstraintLedger,
  intake: { constraints: LoopConstraintLedger; approvedConstraintIds: readonly string[] },
): string[] {
  const errors: string[] = []
  const approved = new Set(intake.approvedConstraintIds ?? [])
  const byId = new Map((candidate.constraints ?? []).filter(item => item?.id).map(item => [item.id, item]))
  for (const original of intake.constraints?.constraints ?? []) {
    if (!original?.id || !approved.has(original.id)) continue
    const current = byId.get(original.id)
    if (!current) {
      errors.push(`constraint '${original.id}' was confirmed during Intake and must not be removed`)
      continue
    }
    for (const field of ['statement', 'kind', 'strength'] as const) {
      if (current[field] !== original[field]) {
        errors.push(`constraint '${original.id}'.${field} was confirmed during Intake as ${JSON.stringify(original[field])} and must not be changed to ${JSON.stringify(current[field])}`)
      }
    }
    if (current.origin !== 'intake') errors.push(`constraint '${original.id}'.origin must stay 'intake'`)
  }
  return errors
}

export function validateLoopBlueprint(value: LoopBlueprint, ledger: LoopConstraintLedger): string[] {
  const errors: string[] = []
  if (value.schemaVersion !== LOOP_BLUEPRINT_SCHEMA) errors.push(`design.schemaVersion must be '${LOOP_BLUEPRINT_SCHEMA}'`)
  if (!text(value.goal)) errors.push('design.goal must be non-empty')
  if (!text(value.intent)) errors.push('design.intent must be non-empty')
  if (text(value.goal) && text(ledger.goal) && value.goal !== ledger.goal) errors.push('design.goal must exactly match constraints.goal')
  for (const field of ['successCriteria', 'workspace', 'lanes', 'control', 'assumptions', 'capabilityGaps'] as const) {
    if (!stringList(value[field])) errors.push(`design.${field} must be a string array`)
  }
  return errors
}
export function validateLayeredLoopDesign(value: LayeredLoopDesign, ledger: LoopConstraintLedger): string[] {
  return validateLoopBlueprint(value, ledger)
}

export function validateGraphTraceability(mapping: GraphTraceabilityMap, ledger: LoopConstraintLedger, graph: LoopGraphSpec): string[] {
  const errors: string[] = []
  if (mapping.schemaVersion !== GRAPH_TRACEABILITY_SCHEMA) errors.push(`traceability.schemaVersion must be '${GRAPH_TRACEABILITY_SCHEMA}'`)
  const known = new Set(ledger.constraints.map(item => item.id))
  const hard = new Set(ledger.constraints.filter(item => item.strength === 'hard').map(item => item.id))
  const loci = enforcementLocusIndex(ledger)
  const seen = new Set<string>()
  const mappings = Array.isArray(mapping.mappings) ? mapping.mappings : []
  if (!Array.isArray(mapping.mappings)) errors.push('traceability.mappings must be an array')
  for (const [index, item] of mappings.entries()) {
    const at = `traceability.mappings[${index}]`
    if (!known.has(item.constraintId)) errors.push(`${at} references unknown constraint '${item.constraintId}'`)
    if (seen.has(item.constraintId)) errors.push(`${at} duplicates constraint '${item.constraintId}'`)
    seen.add(item.constraintId)
    if (!text(item.rationale)) errors.push(`${at}.rationale must be non-empty`)
    const refs = safeStrings(item.graphRefs)
    if (!refs.length) errors.push(`${at}.graphRefs must be non-empty`)
    for (const pointer of refs) if (!jsonPointerExists(graph, pointer)) errors.push(`${at}.graphRefs '${pointer}' does not exist in the Graph`)
    // Annotations never execute, so they cannot carry a hard constraint of any
    // locus. Prose inside a node (prompt/systemInstructions) is different: it is
    // exactly where an `agent`-locus constraint is supposed to live, and exactly
    // where a `graph`-locus one must not hide.
    if (hard.has(item.constraintId) && refs.length && refs.every(isAnnotationPointer)) {
      errors.push(`${at} maps hard constraint '${item.constraintId}' only to non-executable annotations`)
    }
    if (hard.has(item.constraintId) && loci.get(item.constraintId) === 'graph' && refs.length && refs.every(isProsePointer)) {
      errors.push(`${at} maps graph-enforced hard constraint '${item.constraintId}' only to node prose (${refs.join(', ')}); routing, permission and bound constraints need a Transition, Lane workspace rule, State update or limit`)
    }
  }
  for (const constraintId of hard) if (!seen.has(constraintId)) errors.push(`hard constraint '${constraintId}' has no Graph traceability`)
  return errors
}

function isAnnotationPointer(pointer: string): boolean {
  return pointer === '/annotations' || pointer.startsWith('/annotations/')
}

/** Node prose: legitimate for an `agent`-locus constraint, insufficient for a
 * `graph`-locus one. */
function isProsePointer(pointer: string): boolean {
  return isAnnotationPointer(pointer) || /^\/nodes\/[^/]+\/(prompt|systemInstructions|description)$/.test(pointer)
}

export function buildGraphImplementationManifest(graph: LoopGraphSpec): GraphImplementationManifest {
  const incoming = new Map<string, Set<string>>()
  for (const transition of graph.transitions) for (const targetSpec of (Array.isArray(transition.to) ? transition.to : [transition.to])) {
    const target = typeof targetSpec === 'string' ? targetSpec : targetSpec.node
    const keys = incoming.get(target) ?? new Set<string>()
    Object.keys(typeof targetSpec === 'string' ? {} : targetSpec.inputs ?? {}).forEach(key => keys.add(key))
    incoming.set(target, keys)
  }
  return {
    schemaVersion: GRAPH_MANIFEST_SCHEMA,
    graph: { id: graph.id, version: graph.version, goal: graph.goal },
    state: Object.fromEntries(Object.entries(graph.state).map(([name, spec]) => [name, { type: spec.type, initial: spec.initial }])),
    lanes: Object.fromEntries(Object.entries(graph.lanes).map(([laneId, lane]) => [laneId, {
      context: lane.context,
      maxConcurrency: lane.maxConcurrency ?? 1,
      workspace: lane.workspace,
      scm: lane.scm ?? null,
    }])),
    nodes: Object.fromEntries(Object.entries(graph.nodes).map(([nodeId, node]) => [nodeId, manifestNode(nodeId, node, incoming)])),
    transitions: graph.transitions.map(transition => ({
      id: transition.id, from: transition.from, on: transition.on ?? 'success', when: transition.when ?? null,
      default: transition.default ?? false, priority: transition.priority ?? null, updates: transition.updates ?? [], to: transition.to,
    })),
    entrypoints: graph.entrypoints,
    limits: { limits: graph.limits, concurrency: graph.concurrency ?? null },
  }
}

export function renderLoopBlueprintMarkdown(ledger: LoopConstraintLedger, design: LoopBlueprint): string {
  return [
    '# Loop Blueprint', '', `Goal: ${design.goal}`, '', '## Intent and constraints', '', design.intent, '',
    table(['ID', 'Kind', 'Strength', 'Statement', 'Source'], ledger.constraints.map(item => [item.id, item.kind, item.strength, item.statement, item.sources.map(source => `${source.path}:${source.locator}`).join(', ')])), '',
    '## Success criteria', '', ...bullets(design.successCriteria), '',
    '## Workspace', '', ...bullets(design.workspace), '',
    '## Lanes', '', ...bullets(design.lanes), '',
    '## Control', '', ...bullets(design.control), '',
    '## Assumptions', '', ...bullets(design.assumptions), '',
    '## Capability gaps', '', ...bullets(design.capabilityGaps), '',
  ].join('\n')
}
export function renderLayeredDesignMarkdown(ledger: LoopConstraintLedger, design: LayeredLoopDesign): string {
  return renderLoopBlueprintMarkdown(ledger, design)
}

export function renderSemanticReviewMarkdown(review: LayeredSemanticReview): string {
  const lines = ['# Loop Semantic Review', '', `Accepted: ${review.accepted ? 'yes' : 'no'}`, '']
  if (review.verdicts?.length) {
    lines.push('## Per-constraint verdicts', '',
      table(['Constraint', 'Verdict', 'Rule class', 'Graph refs', 'Justification'],
        review.verdicts.map(row => [row.constraintId, row.verdict, row.ruleClass ?? '—', row.graphRefs.join(', ') || '—', row.justification ?? '—'])),
      '')
  }
  for (const layer of SEMANTIC_REVIEW_LAYERS) {
    const result = review.layers[layer]
    lines.push(`## ${layer}`, '', `Status: ${result.status}`, '')
    for (const evidence of result.evidence) lines.push(`- ${evidence.statement}  `, `  Sources: ${evidence.sourceRefs.join(', ') || '—'}  `, `  Blueprint: ${evidence.designRefs.join(', ') || '—'}  `, `  Graph: ${evidence.graphRefs.join(', ') || '—'}`)
    for (const finding of result.findings) {
      const label = isBlockingSemanticRuleClass(finding.ruleClass) ? 'Blocking' : 'Advisory'
      lines.push(`- ${label} [${finding.ruleClass}]: ${finding.statement}  `,
        `  Sources: ${finding.sourceRefs.join(', ') || '—'}  `,
        `  Blueprint: ${finding.designRefs.join(', ') || '—'}  `,
        `  Graph: ${finding.graphRefs.join(', ') || '—'}`)
      if (finding.witness) {
        lines.push(`  Witness: ${finding.witness.outcome} via ${finding.witness.path.join(' → ')} with state ${JSON.stringify(finding.witness.state)}`)
      }
    }
    lines.push('')
  }
  if (review.issues.length) lines.push('## Blocking issues', '', ...review.issues.map(issue => `- ${issue}`), '')
  if (review.advisories.length) lines.push('## Advisories (recorded, non-blocking)', '', ...review.advisories.map(item => `- ${item}`), '')
  return lines.join('\n')
}

function manifestNode(nodeId: string, node: NodeSpec, incoming: Map<string, Set<string>>): unknown {
  const base = { id: nodeId, type: node.type, description: node.description ?? null }
  if (node.type !== 'agent') return { ...base, spec: node }
  return {
    ...base,
    lane: node.lane,
    prompt: node.prompt,
    systemInstructions: node.systemInstructions ?? null,
    transitionInputKeys: [...(incoming.get(nodeId) ?? [])].sort(),
    inputs: node.inputs ?? {}, outputSchema: node.outputSchema ?? null,
    tools: node.tools ?? [], skills: node.skills ?? [], timerPolicy: node.timerPolicy ?? null,
    budgets: { segment: node.budget ?? null, lifetime: node.lifetimeBudget ?? null },
  }
}

function jsonPointerExists(root: unknown, pointer: string): boolean {
  if (pointer === '') return true
  if (!pointer.startsWith('/')) return false
  let value: unknown = root
  for (const raw of pointer.slice(1).split('/')) {
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!value || typeof value !== 'object' || Array.isArray(value) && !/^\d+$/.test(part)) return false
    if (!(part in value)) return false
    value = (value as Record<string, unknown>)[part]
  }
  return true
}
function table(headers: string[], rows: Array<Array<unknown>>): string {
  return [`| ${headers.map(cell).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(cell).join(' | ')} |`)].join('\n')
}
function cell(value: unknown): string { return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ') }
function bullets(values: unknown): string[] { return Array.isArray(values) && values.length ? values.map(value => `- ${String(value)}`) : ['- None declared.'] }
function text(value: unknown): value is string { return typeof value === 'string' && Boolean(value.trim()) }
function id(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value) }
function stringList(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string') }
function safeStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] }

export type GraphDesignValueExpression = ValueExpression

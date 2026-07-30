import type { JsonValue, LoopGraphSpec, NodeSpec, ValueExpression } from '../spec/GraphTypes.js'

export const LOOP_CONSTRAINTS_SCHEMA = 'loop-constraints-2.0' as const
export const LOOP_BLUEPRINT_SCHEMA = 'loop-blueprint-2.0' as const
export const LOOP_DESIGN_SCHEMA = LOOP_BLUEPRINT_SCHEMA
export const GRAPH_TRACEABILITY_SCHEMA = 'graph-traceability-2.0' as const
export const GRAPH_MANIFEST_SCHEMA = 'graph-manifest-2.0' as const
export const SEMANTIC_REVIEW_SCHEMA = 'loop-semantic-review-2.1' as const
export const LOOP_PRECONDITIONS_SCHEMA = 'loop-preconditions-1.0' as const

export type LoopConstraintKind =
  | 'goal' | 'success_criteria' | 'deterministic_rule' | 'workspace_protocol'
  | 'terminal_obligation' | 'ownership' | 'capability' | 'timer' | 'event'
  | 'failure_boundary' | 'recovery' | 'budget' | 'other'

export interface LoopSourceRef { path: string; locator: string; excerpt?: string }
export interface LoopConstraint {
  id: string
  kind: LoopConstraintKind
  statement: string
  strength: 'hard' | 'soft'
  sources: LoopSourceRef[]
  acceptance?: string[]
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

export interface SemanticFinding {
  ruleClass: SemanticRuleClass
  statement: string
  sourceRefs: string[]
  designRefs: string[]
  graphRefs: string[]
}

export interface LayeredSemanticReview {
  schemaVersion: typeof SEMANTIC_REVIEW_SCHEMA
  /** Computed by the host from the findings' rule classes; a model-supplied
   * value is discarded during parsing. */
  accepted: boolean
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
  }
  if (value.unresolved !== undefined && !Array.isArray(value.unresolved)) errors.push('constraints.unresolved must be an array')
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

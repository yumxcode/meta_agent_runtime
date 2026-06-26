/**
 * LoopIR — the data IR for an AI-authored orchestration loop (C).
 *
 * This is the "loop the AI builds": NOT executable code, but a directed graph
 * (which may contain cycles → real loops) that a fixed interpreter (PlanRunner)
 * walks. Keeping it as inspectable data is the core safety property — the plan
 * can be schema-validated, cost/visit-bounded, persisted and replayed, and a
 * malformed plan is rejected before anything runs.
 *
 * A node is one unit of work run by a kernel session (an executor that does a
 * sub-task, or a role agent like verify/drift/reviewer). Each node returns a
 * unified OrchVerdict; outgoing edges route on that verdict's label, so a
 * generate→verify→fix cycle is expressed as three nodes and a back-edge.
 *
 * Per-node `hooks` attach intra-turn phase hooks (B) that are active only while
 * that node runs — this is where the two layers meet: the graph (C) decides the
 * macro structure, phase hooks (B) steer the micro execution inside a node.
 */
import type { Predicate } from './predicates.js'
import type { PhaseHookPoint } from '../../kernel/loop/PhaseHooks.js'
import { validatePredicate } from './predicates.js'

/** What a node is. */
export type NodeKind =
  /** A worker that advances the task (writes code, researches, etc.). */
  | 'executor'
  /** A reviewing role (verify / drift / reviewer / cost_guard / …). */
  | 'role'

/** Where a node's writes land. Mirrors SpawnSubAgentOptions.workspace_mode. */
export type NodeWorkspaceMode = 'shared_readonly' | 'isolated_write'

/** A phase-hook attachment declared on a node (B mounted inside C). */
export interface NodeHookSpec {
  /** Stable id (unique within the node). */
  id: string
  /** Which intra-turn transition to mount on. */
  point: PhaseHookPoint
  /** Trigger predicate; defaults to `always`. */
  when?: Predicate
  /** Role label resolved to a handler by the host's role catalogue. */
  role: string
}

/** A single node in the orchestration graph. */
export interface OrchNode {
  /** Unique node id. */
  id: string
  /** Node kind. */
  kind: NodeKind
  /** Role label for `role` nodes (e.g. 'verify'); ignored for executors. */
  role?: string
  /** Natural-language task / rubric handed to the spawned session. */
  taskDescription: string
  /** Optional system prompt override. */
  systemPrompt?: string
  /** Tools the session may use; empty/omitted = pure reasoning. */
  allowedTools?: string[]
  /** Force-stop after this many turns. */
  maxTurns?: number
  /** Force-stop after this cost. */
  maxBudgetUsd?: number
  /** Where writes land (executors that write MUST be isolated_write). */
  workspaceMode?: NodeWorkspaceMode
  /** Phase hooks active only while this node runs. */
  hooks?: NodeHookSpec[]
}

/** Condition under which an edge is taken after its `from` node returns. */
export type EdgeCondition =
  /** Always (the default / fallthrough edge). */
  | { on: 'always' }
  /** When the node's verdict carried this label (e.g. 'pass', 'fail'). */
  | { on: 'verdictLabel'; label: string }
  /** When the node's verdict action matched. */
  | { on: 'verdictAction'; action: string }

/** A directed edge. Back-edges (to an earlier node) form loops. */
export interface OrchEdge {
  from: string
  to: string
  /** Defaults to `{ on: 'always' }` when omitted. */
  when?: EdgeCondition
}

/** Hard bounds the interpreter enforces regardless of plan content. */
export interface OrchBounds {
  /** Max times any single node may be (re)visited. Default applied by runner. */
  maxNodeVisits?: number
  /** Max total node executions across the whole run. */
  maxTotalSteps?: number
  /** Max cumulative cost before the run is stopped. */
  maxTotalCostUsd?: number
  /** Max wall-clock for the whole plan. */
  maxWallClockMs?: number
}

/** The full orchestration plan an AI Planner emits. */
export interface OrchPlan {
  /** Plan id for observability / persistence. */
  id?: string
  /** Entry node id. */
  entry: string
  /** All nodes. */
  nodes: OrchNode[]
  /** All edges. */
  edges: OrchEdge[]
  /** Hard bounds (the walls the AI works within). */
  bounds?: OrchBounds
}

/**
 * Validate a plan is well-formed BEFORE running it: unique node ids, entry
 * exists, every edge references existing nodes, predicates/conditions sound, and
 * no terminal node-less dead-ends that aren't intentional. Returns problems;
 * empty list = valid. A failing plan must be rejected (fail-open to the default
 * fixed loop), never executed.
 */
export function validatePlan(plan: OrchPlan): string[] {
  const errs: string[] = []
  if (!plan || typeof plan !== 'object') return ['plan must be an object']

  const ids = new Set<string>()
  for (const n of plan.nodes ?? []) {
    if (!n.id) {
      errs.push('every node needs an id')
      continue
    }
    if (ids.has(n.id)) errs.push(`duplicate node id: ${n.id}`)
    ids.add(n.id)
    if (!n.taskDescription) errs.push(`node[${n.id}].taskDescription is required`)
    if (n.kind === 'role' && !n.role) errs.push(`role node[${n.id}] needs a role label`)
    if (
      n.kind === 'executor' &&
      (n.allowedTools?.some(t => FS_WRITE_TOOLS.has(t)) ?? false) &&
      n.workspaceMode !== 'isolated_write'
    ) {
      errs.push(`executor node[${n.id}] writes files but is not workspaceMode=isolated_write`)
    }
    for (const h of n.hooks ?? []) {
      if (!h.id) errs.push(`node[${n.id}] hook needs an id`)
      if (!h.role) errs.push(`node[${n.id}].hook[${h.id ?? '?'}] needs a role`)
      if (h.when) errs.push(...validatePredicate(h.when, `node[${n.id}].hook[${h.id}].when`))
    }
  }

  if (!plan.entry) errs.push('plan.entry is required')
  else if (!ids.has(plan.entry)) errs.push(`plan.entry references unknown node: ${plan.entry}`)

  for (const e of plan.edges ?? []) {
    if (!ids.has(e.from)) errs.push(`edge.from references unknown node: ${e.from}`)
    if (!ids.has(e.to)) errs.push(`edge.to references unknown node: ${e.to}`)
    if (e.when && e.when.on === 'verdictLabel' && !e.when.label) {
      errs.push(`edge ${e.from}->${e.to} verdictLabel condition needs a label`)
    }
  }

  return errs
}

/** FS-mutating tool names — used to enforce the isolated-write rule for writers. */
const FS_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'notebook_edit'])

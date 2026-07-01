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
  /** A fan-out group: run `branches` concurrently, then join + merge. */
  | 'parallel'
  /** A frozen, content-addressed deterministic code artifact authored before run. */
  | 'code'

/** Where a node's writes land. Mirrors SpawnSubAgentOptions.workspace_mode. */
export type NodeWorkspaceMode = 'shared_readonly' | 'isolated_write'

/** Join policy for a parallel node — when is the group considered done. */
export type JoinPolicy = 'all' | 'any' | 'quorum'

/** One concurrent branch of a `parallel` node (its own sub-agent + git branch). */
export interface ParallelBranch {
  /** Unique id within the parallel node. */
  id: string
  /** Self-contained task for this branch's sub-agent. */
  taskDescription: string
  systemPrompt?: string
  allowedTools?: string[]
  maxTurns?: number
  maxBudgetUsd?: number
  /** Writers MUST be isolated_write; readers default to shared_readonly. */
  workspaceMode?: NodeWorkspaceMode
  /**
   * L1 write-scope: path globs (workspace-relative) this branch may write.
   * REQUIRED for writers — runtime enforcement confines the branch to it, and
   * the static disjointness check uses it to guarantee conflict-free merges.
   */
  writeScope?: string[]
}

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

/** Contract the Planner supplies before a generated code node is materialised. */
export interface CodeNodeSpec {
  /** What the generated code must do, independent of graph routing prose. */
  description: string
  /** State paths or logical inputs the code may read. */
  inputs?: string[]
  /** State paths or logical outputs the code may write. */
  outputs?: string[]
  /** Verdict labels the code may return for graph routing. */
  labels?: string[]
}

/** Per-code-node runtime limits. */
export interface CodeNodeBounds {
  timeoutMs?: number
  maxOutputBytes?: number
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
  // ── Code-node fields (kind === 'code') ──────────────────────────────────────
  /** Missing before authoring; filled after freeze with a content-addressed file. */
  codeRef?: string
  /** SHA-256 of the source at codeRef. Required once materialised. */
  sourceHash?: string
  /** Planner-authored contract used by the code_author when codeRef is absent. */
  codeSpec?: CodeNodeSpec
  /** JSON-serialisable input passed to main(input, api). */
  input?: Record<string, unknown>
  /** Host API capabilities the generated code may use. */
  capabilities?: string[]
  /** Runtime bounds for this deterministic code invocation. */
  codeBounds?: CodeNodeBounds
  // ── Parallel-node fields (kind === 'parallel') ──────────────────────────────
  /** Concurrent branches to fan out. */
  branches?: ParallelBranch[]
  /** When the group is done. Default 'all'. */
  join?: JoinPolicy
  /** Required success count when join === 'quorum'. */
  quorum?: number
  /**
   * Role used to resolve merge conflicts between overlapping write-scopes
   * (L3(c) LLM 3-way merge). Default 'integrator'. Only consulted when branch
   * write-scopes can overlap; disjoint scopes never need it.
   */
  integrator?: string
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

export interface ValidatePlanOptions {
  /**
   * Planner output may contain code nodes with only codeSpec; the controller
   * materialises them into codeRef/sourceHash before PlanRunner executes.
   */
  allowUnmaterializedCode?: boolean
}

/**
 * Validate a plan is well-formed BEFORE running it: unique node ids, entry
 * exists, every edge references existing nodes, predicates/conditions sound, and
 * no terminal node-less dead-ends that aren't intentional. Returns problems;
 * empty list = valid. A failing plan must be rejected (fail-open to the default
 * fixed loop), never executed.
 */
export function validatePlan(plan: OrchPlan, opts: ValidatePlanOptions = {}): string[] {
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
    if (n.kind === 'code') errs.push(...validateCodeNode(n, opts))
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
    if (n.kind === 'parallel') errs.push(...validateParallelNode(n))
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

  // Graceful-termination check — only meaningful once the structure is sound
  // (edges reference real nodes), so it runs last and only on a clean plan.
  if (errs.length === 0) errs.push(...detectUnterminableCycles(plan))

  return errs
}

function validateCodeNode(n: OrchNode, opts: ValidatePlanOptions): string[] {
  const errs: string[] = []
  const hasArtifact = !!n.codeRef || !!n.sourceHash
  if (hasArtifact) {
    if (!n.codeRef) errs.push(`code node[${n.id}] has sourceHash but no codeRef`)
    if (!n.sourceHash) errs.push(`code node[${n.id}] has codeRef but no sourceHash`)
  } else if (opts.allowUnmaterializedCode) {
    if (!n.codeSpec?.description) {
      errs.push(`code node[${n.id}] needs codeSpec.description before materialization`)
    }
  } else {
    errs.push(`code node[${n.id}] must be materialized with codeRef and sourceHash before execution`)
  }
  if (n.allowedTools?.length) errs.push(`code node[${n.id}] must not declare allowedTools`)
  if (n.workspaceMode) errs.push(`code node[${n.id}] must not declare workspaceMode`)
  if (n.capabilities && !Array.isArray(n.capabilities)) {
    errs.push(`code node[${n.id}].capabilities must be an array`)
  }
  for (const cap of n.capabilities ?? []) {
    if (typeof cap !== 'string') errs.push(`code node[${n.id}].capabilities entries must be strings`)
  }
  const b = n.codeBounds
  if (b) {
    if (b.timeoutMs !== undefined && (!Number.isFinite(b.timeoutMs) || b.timeoutMs <= 0)) {
      errs.push(`code node[${n.id}].codeBounds.timeoutMs must be positive`)
    }
    if (b.maxOutputBytes !== undefined && (!Number.isFinite(b.maxOutputBytes) || b.maxOutputBytes <= 0)) {
      errs.push(`code node[${n.id}].codeBounds.maxOutputBytes must be positive`)
    }
  }
  return errs
}

/**
 * Graceful-termination check: every cycle must have a way to leave it under SOME
 * verdict, otherwise the loop can only ever stop by hitting a hard bound
 * (bounds_exceeded), never `completed`. We REJECT such plans so the Planner is
 * forced to add an exit (and the LLM gets a precise reason to re-plan).
 *
 * Soundness (does NOT reject correct terminating graphs): a node can leave its
 * strongly-connected cycle under some verdict iff —
 *   (a) a REACHABLE out-edge (not shadowed by an earlier unconditional edge)
 *       targets a node OUTSIDE the cycle, OR
 *   (b) the node has NO unconditional (`always`) out-edge, so some verdict
 *       matches nothing and the run terminates at that node.
 * The canonical generate→verify→fix loop passes via (b): verify's only edge is
 * the conditional `fail`→gen back-edge, so a `pass` verdict terminates.
 *
 * An `always` edge shadows everything declared after it (PlanRunner picks the
 * first matching edge), so only edges up to and including the first `always` are
 * "reachable" — that is exactly what (a) inspects.
 */
export function detectUnterminableCycles(plan: OrchPlan): string[] {
  const errs: string[] = []
  const nodeIds = new Set((plan.nodes ?? []).map(n => n.id))
  const isAlways = (e: OrchEdge): boolean => !e.when || e.when.on === 'always'

  // Adjacency in declaration order, restricted to edges between real nodes.
  const adj = new Map<string, { to: string; always: boolean }[]>()
  for (const id of nodeIds) adj.set(id, [])
  for (const e of plan.edges ?? []) {
    if (nodeIds.has(e.from) && nodeIds.has(e.to)) adj.get(e.from)!.push({ to: e.to, always: isAlways(e) })
  }

  // Tarjan's strongly-connected components.
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  let idx = 0
  const sccs: string[][] = []
  const strongconnect = (v: string): void => {
    index.set(v, idx)
    low.set(v, idx)
    idx++
    stack.push(v)
    onStack.add(v)
    for (const { to: w } of adj.get(v)!) {
      if (!index.has(w)) {
        strongconnect(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!))
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = []
      let w: string
      do {
        w = stack.pop()!
        onStack.delete(w)
        comp.push(w)
      } while (w !== v)
      sccs.push(comp)
    }
  }
  for (const id of nodeIds) if (!index.has(id)) strongconnect(id)

  for (const comp of sccs) {
    const inScc = new Set(comp)
    const cyclic = comp.length > 1 || adj.get(comp[0]!)!.some(e => e.to === comp[0])
    if (!cyclic) continue

    const escapable = comp.some(n => {
      const edges = adj.get(n)!
      const firstAlways = edges.findIndex(e => e.always)
      const reachable = firstAlways === -1 ? edges : edges.slice(0, firstAlways + 1)
      // (a) a reachable edge leaves the cycle, OR (b) no always edge → can terminate.
      return reachable.some(e => !inScc.has(e.to)) || firstAlways === -1
    })

    if (!escapable) {
      errs.push(
        `cycle [${comp.join(' → ')}] has no graceful exit: every node is forced back into the loop, ` +
        `so it can only stop by hitting a hard bound. Add a CONDITIONAL out-edge that leaves the cycle ` +
        `(e.g. a verify node whose 'pass' routes to a node outside the loop), or remove an unconditional ` +
        `('always') edge so some verdict can terminate the run.`,
      )
    }
  }
  return errs
}

/** FS-mutating tool names — used to enforce the isolated-write rule for writers. */
const FS_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'notebook_edit'])

/** A branch is a "writer" if it may mutate files (isolated_write or a write tool). */
function isWriterBranch(b: ParallelBranch): boolean {
  return b.workspaceMode === 'isolated_write' || (b.allowedTools?.some(t => FS_WRITE_TOOLS.has(t)) ?? false)
}

/**
 * Validate a parallel node: branch ids unique + self-contained, writers declare
 * a write-scope (L1), quorum sane, and — the heart of L1 — any two WRITER
 * branches whose declared write-scopes can OVERLAP require an integrator role to
 * be declared (otherwise their merge could conflict with nothing to resolve it).
 * Disjoint scopes need no integrator and merge clean by construction.
 */
function validateParallelNode(n: OrchNode): string[] {
  const errs: string[] = []
  const branches = n.branches ?? []
  if (branches.length === 0) {
    errs.push(`parallel node[${n.id}] needs at least one branch`)
    return errs
  }
  const seen = new Set<string>()
  const writers: ParallelBranch[] = []
  for (const b of branches) {
    if (!b.id) errs.push(`parallel node[${n.id}] has a branch without an id`)
    else if (seen.has(b.id)) errs.push(`parallel node[${n.id}] duplicate branch id: ${b.id}`)
    else seen.add(b.id)
    if (!b.taskDescription) errs.push(`parallel node[${n.id}].branch[${b.id}] needs a taskDescription`)
    if (isWriterBranch(b)) {
      if (b.workspaceMode !== 'isolated_write') {
        errs.push(`parallel node[${n.id}].branch[${b.id}] writes files but is not workspaceMode=isolated_write`)
      }
      if (!b.writeScope || b.writeScope.length === 0) {
        errs.push(`parallel node[${n.id}].branch[${b.id}] is a writer and must declare a writeScope (L1)`)
      }
      writers.push(b)
    }
  }

  // L1 static disjointness: overlapping writer scopes are allowed ONLY with an
  // integrator declared to resolve potential merge conflicts.
  for (let i = 0; i < writers.length; i++) {
    for (let j = i + 1; j < writers.length; j++) {
      if (
        !n.integrator &&
        writeScopesOverlap(writers[i]!.writeScope ?? [], writers[j]!.writeScope ?? [])
      ) {
        errs.push(
          `parallel node[${n.id}] writer branches '${writers[i]!.id}' and '${writers[j]!.id}' have ` +
          `overlapping write-scopes — make them disjoint, or declare an 'integrator' role to resolve merges.`,
        )
      }
    }
  }

  if (n.join === 'quorum') {
    if (n.quorum === undefined || n.quorum < 1 || n.quorum > branches.length) {
      errs.push(`parallel node[${n.id}] join='quorum' needs quorum in 1..${branches.length}`)
    }
  }
  return errs
}

/** Conservative glob overlap: true unless the two scope sets are clearly disjoint. */
export function writeScopesOverlap(a: string[], b: string[]): boolean {
  for (const ga of a) for (const gb of b) if (globsOverlap(ga, gb)) return true
  return false
}

/**
 * Conservative single-glob overlap. We err on the side of "may overlap" (safe:
 * forces an integrator) rather than risk a false "disjoint". Two globs overlap
 * when, after stripping a trailing `/**` or `/*`, one prefix path contains the
 * other (or they're equal). Different top-level segments → disjoint.
 */
function globsOverlap(a: string, b: string): boolean {
  const norm = (g: string): string =>
    g.replace(/\/\*\*?$/, '').replace(/\/+$/, '').replace(/^\.\//, '').trim()
  const pa = norm(a)
  const pb = norm(b)
  if (pa === '' || pb === '') return true // root scope → overlaps everything
  if (pa === pb) return true
  const segA = pa.split('/')
  const segB = pb.split('/')
  const n = Math.min(segA.length, segB.length)
  for (let i = 0; i < n; i++) {
    const x = segA[i]!
    const y = segB[i]!
    if (x === '*' || y === '*' || x === '**' || y === '**') continue // wildcard segment → may match
    if (x !== y) return false // diverged on a concrete segment → disjoint
  }
  return true // one path is a prefix of the other → nested → overlap
}

// ── L2: merge planning (changed-file intersection precheck) ─────────────────────

/** A branch's actual changed files (from finalize) used to plan the merge. */
export interface BranchChange {
  id: string
  changedFiles: string[]
}

/** What to do per branch at the join: clean merge, or hand to the integrator. */
export interface MergePlan {
  /** Deterministic merge order (branch declaration order). */
  order: string[]
  /** Branches whose changed files don't overlap anything merged before them. */
  cleanMerges: string[]
  /** Branches that overlap earlier ones → need the integrator role (L3c). */
  conflicts: { branch: string; overlapsWith: string[]; files: string[] }[]
}

/**
 * L2 precheck: from each branch's ACTUAL changed files, decide — without trying
 * a textual merge — which branches merge clean and which overlap an
 * already-merged branch and therefore need integration. Deterministic: merges in
 * declaration order, accumulating the merged-file set.
 */
export function planMerge(branches: BranchChange[]): MergePlan {
  const order: string[] = []
  const cleanMerges: string[] = []
  const conflicts: MergePlan['conflicts'] = []
  // file -> first branch that touched it (for reporting who you conflict with)
  const owner = new Map<string, string>()

  for (const b of branches) {
    order.push(b.id)
    const files = b.changedFiles ?? []
    const overlapFiles: string[] = []
    const overlapsWith = new Set<string>()
    for (const f of files) {
      const prev = owner.get(f)
      if (prev !== undefined && prev !== b.id) {
        overlapFiles.push(f)
        overlapsWith.add(prev)
      }
    }
    if (overlapFiles.length === 0) cleanMerges.push(b.id)
    else conflicts.push({ branch: b.id, overlapsWith: [...overlapsWith], files: overlapFiles })
    // record ownership (first writer keeps ownership for reporting)
    for (const f of files) if (!owner.has(f)) owner.set(f, b.id)
  }

  return { order, cleanMerges, conflicts }
}

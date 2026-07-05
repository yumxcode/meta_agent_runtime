/**
 * PlanRunner — the fixed interpreter that executes an AI-authored OrchPlan (C).
 *
 * The AI never runs code; it emits an OrchPlan (data). This class is the only
 * thing that "runs the loop": it walks the graph from `entry`, executes each
 * node via an injected NodeRunner, reads the node's unified verdict, selects the
 * next edge by matching the verdict, and repeats — back-edges produce real loops
 * (generate→verify→fix until pass). All of this happens inside HARD bounds the
 * AI cannot exceed (visits, steps, cost, wall-clock), and any malformed plan or
 * runner error fails open to a clean stop rather than wedging.
 *
 * The NodeRunner is an interface so the engine is testable with a stub and the
 * live wiring (spawn a kernel sub-agent via ISubAgentDispatcher) is a drop-in.
 */
import type { OrchVerdict } from './Verdict.js'
import { validatePlan, type OrchNode, type OrchPlan, type OrchEdge } from './LoopIR.js'
import { Blackboard } from './Blackboard.js'
import { notifyAutoOrchObserver, type AutoOrchObserver } from './Observer.js'

/** Per-run context handed to the node runner and used for bound accounting. */
export interface PlanRunContext {
  /** Abort signal from the parent run. */
  signal: AbortSignal
  /** Visits per node id so far (read-only view for the runner). */
  visits: ReadonlyMap<string, number>
  /** Total node executions so far. */
  totalSteps: number
  /** Cumulative cost so far. */
  costUsd: number
  /**
   * Run-scoped shared channel. PlanRunner always supplies one; it is optional on
   * the type so lightweight test stubs and non-blackboard runners stay valid.
   */
  blackboard?: Blackboard
}

/** Runs a single node and returns its unified verdict. */
export interface NodeRunner {
  /**
   * Execute `node`. Implementations may report incremental cost via the returned
   * verdict's `data.costUsd` (a number); the runner adds it to the budget.
   */
  run(node: OrchNode, ctx: PlanRunContext): Promise<OrchVerdict>
}

export type PlanRunStatus =
  | 'completed' // reached a terminal node / explicit done
  | 'paused' // stopped intentionally while waiting for an external resume event
  | 'aborted' // parent run aborted
  | 'bounds_exceeded' // a hard bound stopped the run
  | 'invalid' // plan failed validation (never executed)
  | 'review_unavailable' // run terminated on a SKIPPED gate (reviewer unavailable / unparsable) — fail-closed
  | 'failed' // unexpected internal error

export interface PlanStepRecord {
  nodeId: string
  action: OrchVerdict['action']
  label?: string
  note?: string
}

export interface PlanRunResult {
  status: PlanRunStatus
  /** Ordered node ids actually executed. */
  visitedPath: string[]
  /** One record per executed node. */
  steps: PlanStepRecord[]
  /** Total cost accumulated from node verdicts. */
  costUsd: number
  /** Human-readable explanation (esp. for invalid / bounds_exceeded). */
  note?: string
  /** Opaque handle for a paused run; scheduler/resume code owns the shape. */
  resumeHandle?: Record<string, unknown>
}

/** Default hard bounds, applied when the plan omits them. */
export const DEFAULT_BOUNDS = {
  maxNodeVisits: 8,
  maxTotalSteps: 64,
  maxTotalCostUsd: 10,
  maxWallClockMs: 2 * 60 * 60 * 1000,
} as const

export class PlanRunner {
  private readonly blackboard: Blackboard

  constructor(
    private readonly plan: OrchPlan,
    private readonly runner: NodeRunner,
    private readonly opts?: { blackboard?: Blackboard; observer?: AutoOrchObserver },
  ) {
    this.blackboard = opts?.blackboard ?? new Blackboard()
  }

  /** The run-scoped shared channel (observability / post-run inspection). */
  getBlackboard(): Blackboard {
    return this.blackboard
  }

  /** Validate without running. */
  validate(): { ok: boolean; errors: string[] } {
    const errors = validatePlan(this.plan)
    return { ok: errors.length === 0, errors }
  }

  /**
   * Execute the plan. Never throws: every failure path resolves to a
   * PlanRunResult so the host can fall back to the default fixed loop.
   */
  async run(signal: AbortSignal): Promise<PlanRunResult> {
    const visitedPath: string[] = []
    const steps: PlanStepRecord[] = []
    const visits = new Map<string, number>()
    let totalSteps = 0
    let costUsd = 0

    const validation = this.validate()
    if (!validation.ok) {
      await this.emit({
        type: 'run_completed',
        status: 'invalid',
        visitedPath: [],
        costUsd: 0,
        note: validation.errors.join('; '),
      })
      return {
        status: 'invalid',
        visitedPath,
        steps,
        costUsd,
        note: validation.errors.join('; '),
      }
    }

    const bounds = { ...DEFAULT_BOUNDS, ...(this.plan.bounds ?? {}) }
    const startedAt = Date.now()
    const nodeById = new Map(this.plan.nodes.map(n => [n.id, n]))
    await this.emit({
      type: 'plan_started',
      planId: this.plan.id,
      entry: this.plan.entry,
      nodeCount: this.plan.nodes.length,
      edgeCount: this.plan.edges.length,
      bounds: this.plan.bounds,
    })

    let currentId: string | undefined = this.plan.entry
    const finalize = async (
      status: PlanRunStatus,
      note?: string,
      resumeHandle?: Record<string, unknown>,
    ): Promise<PlanRunResult> => {
      await this.emit({ type: 'run_completed', status, visitedPath: [...visitedPath], costUsd, note })
      return { status, visitedPath, steps, costUsd, note, resumeHandle }
    }

    try {
      while (currentId) {
        if (signal.aborted) {
          return finalize('aborted', 'parent run aborted')
        }
        if (Date.now() - startedAt > bounds.maxWallClockMs) {
          return finalize('bounds_exceeded', `wall-clock > ${bounds.maxWallClockMs}ms`)
        }
        if (totalSteps >= bounds.maxTotalSteps) {
          return finalize('bounds_exceeded', `total steps >= ${bounds.maxTotalSteps}`)
        }

        const node = nodeById.get(currentId)!
        const priorVisits = visits.get(currentId) ?? 0
        if (priorVisits >= bounds.maxNodeVisits) {
          return finalize('bounds_exceeded', `node ${currentId} visited >= ${bounds.maxNodeVisits} times`)
        }
        visits.set(currentId, priorVisits + 1)
        totalSteps++
        visitedPath.push(currentId)
        await this.emit({
          type: 'node_started',
          nodeId: currentId,
          nodeKind: node.kind,
          visit: priorVisits + 1,
          step: totalSteps,
        })

        let verdict: OrchVerdict
        try {
          verdict = await this.runner.run(node, { signal, visits, totalSteps, costUsd, blackboard: this.blackboard })
        } catch (err) {
          return finalize('failed', `node ${currentId} runner threw: ${(err as Error).message}`)
        }

        const stepCost = numeric(verdict.data?.['costUsd'])
        if (stepCost) costUsd += stepCost
        steps.push({ nodeId: currentId, action: verdict.action, label: verdict.label, note: verdict.note })
        await this.emit({
          type: 'node_finished',
          nodeId: currentId,
          action: verdict.action,
          label: verdict.label,
          note: verdict.note,
          costUsd: stepCost,
        })

        if (verdict.label === 'paused') {
          await this.emit({
            type: 'run_paused',
            nodeId: currentId,
            note: verdict.note ?? 'node paused while waiting for an external event',
            resumeHandle: objectRecord(verdict.data?.['resumeHandle']),
          })
          return finalize(
            'paused',
            verdict.note ?? 'node paused while waiting for an external event',
            objectRecord(verdict.data?.['resumeHandle']),
          )
        }
        if (costUsd > bounds.maxTotalCostUsd) {
          return finalize('bounds_exceeded', `cost ${costUsd.toFixed(4)} > ${bounds.maxTotalCostUsd}`)
        }
        if (verdict.action === 'abort') {
          return finalize(
            isFailedAbort(verdict) ? 'failed' : 'completed',
            verdict.note ?? 'node requested abort',
          )
        }

        // Fail-closed on a SKIPPED REVIEW gate (verify / generic reviewer): when
        // such a gate was unavailable or returned an unparsable verdict it never
        // actually reviewed, so it must NOT be routed forward — not even down an
        // explicit `pass` edge to a deploy/finalize node. Checked BEFORE
        // selectNext so edge topology can't launder a skip into a pass. Advisory
        // DRIFT skips (gateKind === 'drift') are exempt — drift is fail-open by
        // design and is allowed to continue.
        if (verdict.skipped && verdict.data?.['gateKind'] !== 'drift') {
          return finalize('review_unavailable', verdict.note ?? 'review gate was skipped (reviewer unavailable)')
        }

        // Topology-derived addressing (target-addressed blackboard): a verdict
        // carrying corrective messages (e.g. a verify 'fail') is routed to the
        // node its edge points to, and the correctives are posted ADDRESSED to
        // that node — so feedback for B reaches B, never some unrelated node.
        const fromId = currentId
        const nextId = this.selectNext(fromId, verdict)
        if (nextId && verdict.messages && verdict.messages.length > 0) {
          this.blackboard.postCorrective({ from: fromId, to: nextId, messages: verdict.messages })
        }
        await this.emit({
          type: 'edge_selected',
          from: fromId,
          to: nextId,
          label: verdict.label,
          action: verdict.action,
        })
        if (!nextId && isTerminalError(verdict)) {
          return finalize('failed', verdict.note ?? `terminal error node reached: ${fromId}`)
        }
        currentId = nextId
      }

      return finalize('completed')
    } catch (err) {
      return finalize('failed', (err as Error).message)
    }
  }

  private async emit(event: Parameters<typeof notifyAutoOrchObserver>[1]): Promise<void> {
    await notifyAutoOrchObserver(this.opts?.observer, event)
  }

  /**
   * Select the next node id given the just-finished node's verdict. Picks the
   * FIRST matching out-edge in declaration order; an `always` edge is the
   * fallthrough. Returns undefined (→ terminal, run completes) when no edge
   * matches.
   */
  private selectNext(fromId: string, verdict: OrchVerdict): string | undefined {
    const outEdges = this.plan.edges.filter(e => e.from === fromId)
    for (const e of outEdges) {
      if (edgeMatches(e, verdict)) return e.to
    }
    return undefined
  }
}

function edgeMatches(edge: OrchEdge, verdict: OrchVerdict): boolean {
  const cond = edge.when ?? { on: 'always' }
  switch (cond.on) {
    case 'always':
      return true
    case 'verdictLabel':
      return verdict.label === cond.label
    case 'verdictAction':
      return verdict.action === cond.action
    default:
      return false
  }
}

function numeric(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function objectRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' ? v as Record<string, unknown> : undefined
}

function isTerminalError(verdict: OrchVerdict): boolean {
  return verdict.label === 'error'
}

function isFailedAbort(verdict: OrchVerdict): boolean {
  return verdict.data?.['failed'] === true || verdict.label === 'error' || verdict.label === 'failed'
}

/**
 * KernelNodeRunner — the live execution half of (C).
 *
 * Implements `NodeRunner` by spawning a real kernel sub-agent per graph node via
 * `ISubAgentDispatcher` (the same dispatcher the drift/verify gates use):
 *
 *   • executor node → a working sub-agent (the node's tools / isolation). Its
 *     terminal outcome becomes a branch verdict ('ok' | 'error') so the graph
 *     can route on success/failure.
 *   • role node     → resolved through the RoleCatalog: 'verify'/'drift' delegate
 *     to the real gates, any other name (or an unknown one) falls back to the
 *     generic read-only reviewer. The role returns a unified verdict directly.
 *
 * Role handling lives in RoleRegistry/reviewer now (one source of truth shared
 * with the kernel gates), so this file only owns executor spawning + dispatch.
 */
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import type { NodeRunner, PlanRunContext } from './PlanRunner.js'
import type { OrchNode } from './LoopIR.js'
import type { OrchVerdict } from './Verdict.js'
import { RoleCatalog, defaultRoleCatalog } from './RoleRegistry.js'
import { spawnAndWait, type SpawnWaitOptions } from './reviewer.js'

// Re-exported for back-compat (and because they belong to the role surface).
export { parseRoleVerdict } from './reviewer.js'

export interface KernelNodeRunnerOptions {
  /** Max wall-clock to wait for a single node's sub-agent. Default 24 min. */
  maxWaitMsPerNode?: number
  /** Poll cadence while waiting. Default 500 ms. */
  pollMs?: number
  /** Role catalogue used to resolve `role` nodes. Default = built-ins. */
  roleCatalog?: RoleCatalog
  /** Workspace root, forwarded to role handlers (verify/drift need it). */
  projectDir?: string
  /** Live goal accessor, forwarded to role handlers. */
  getGoal?: () => string | null
}

export class KernelNodeRunner implements NodeRunner {
  private readonly maxWaitMs: number
  private readonly pollMs: number
  private readonly roleCatalog: RoleCatalog
  private readonly projectDir: string
  private readonly getGoal: () => string | null

  constructor(
    private readonly dispatcher: ISubAgentDispatcher,
    opts?: KernelNodeRunnerOptions,
  ) {
    this.maxWaitMs = opts?.maxWaitMsPerNode ?? 24 * 60 * 1000
    this.pollMs = opts?.pollMs ?? 500
    this.roleCatalog = opts?.roleCatalog ?? defaultRoleCatalog()
    this.projectDir = opts?.projectDir ?? process.cwd()
    this.getGoal = opts?.getGoal ?? (() => null)
  }

  async run(node: OrchNode, ctx: PlanRunContext): Promise<OrchVerdict> {
    try {
      return node.kind === 'role'
        ? await this.runRole(node, ctx)
        : await this.runExecutor(node, ctx)
    } catch (err) {
      // Defensive: surface as a routable error verdict rather than throwing, so a
      // single flaky node doesn't abort the whole plan via PlanRunner's catch.
      return { action: 'branch', label: 'error', note: (err as Error).message }
    }
  }

  private async runExecutor(node: OrchNode, ctx: PlanRunContext): Promise<OrchVerdict> {
    // Blackboard: consume any pending reviewer feedback and prepend it so this
    // re-run actually fixes the cited gaps (closing the generate→verify→fix loop).
    const preface = ctx.blackboard?.takeCorrectivePreface() ?? ''
    const taskDescription = preface ? `${preface}\n${node.taskDescription}` : node.taskDescription
    const rec = await spawnAndWait(
      this.dispatcher,
      {
        taskDescription,
        systemPrompt: node.systemPrompt,
        allowedTools: node.allowedTools ?? [],
        maxTurns: node.maxTurns ?? 12,
        maxBudgetUsd: node.maxBudgetUsd ?? 0.5,
        requireHumanApproval: false,
        useEventDriven: false,
        pollIntervalMs: this.pollMs,
        checkpointEveryNTurns: 0,
        // Writers MUST be isolated (validatePlan enforces this); default readonly.
        workspaceMode: node.workspaceMode ?? 'shared_readonly',
      },
      ctx.signal,
      this.spawnOpts(),
    )
    const cost = rec?.result?.costUsd ?? 0
    if (rec?.status === 'completed' && rec.result?.success) {
      return { action: 'branch', label: 'ok', note: truncate(rec.result.summary), data: { costUsd: cost } }
    }
    return {
      action: 'branch',
      label: 'error',
      note: rec?.result?.error ?? `executor ${node.id} did not complete (${rec?.status ?? 'no record'})`,
      data: { costUsd: cost },
    }
  }

  private async runRole(node: OrchNode, ctx: PlanRunContext): Promise<OrchVerdict> {
    const role = node.role ?? 'reviewer'
    const handler = this.roleCatalog.buildHandler(role, {
      dispatcher: this.dispatcher,
      projectDir: this.projectDir,
      getGoal: this.getGoal,
    })
    const verdict = await handler({ criteria: node.taskDescription, signal: ctx.signal })
    // Blackboard: a failing reviewer's concrete gaps are posted so the NEXT
    // executor (reached via a back-edge) reads and fixes them.
    if (verdict.action === 'branch' && verdict.label === 'fail' && verdict.messages?.length) {
      ctx.blackboard?.postCorrective(role, verdict.messages)
    }
    return verdict
  }

  private spawnOpts(): SpawnWaitOptions {
    return { pollMs: this.pollMs, maxWaitMs: this.maxWaitMs }
  }
}

function truncate(s: string, n = 500): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

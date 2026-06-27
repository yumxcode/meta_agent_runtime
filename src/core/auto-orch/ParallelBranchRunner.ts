/**
 * ParallelBranchRunner — the execution of a `parallel` node (fan-out → join →
 * merge), kept as PURE orchestration over a `BranchOps` IO interface so it is
 * fully unit-testable with a stub (the real git/sub-agent work lives in
 * KernelBranchOps).
 *
 * Flow:
 *   1. run all branches CONCURRENTLY (Promise.all) — actual concurrency is bounded
 *      downstream by the sub-agent bridge's maxConcurrent;
 *   2. apply the JOIN policy (all / any / quorum) to decide if the group passed;
 *   3. for successful WRITER branches, plan the merge from their actual changed
 *      files (L2 planMerge): clean-merge the disjoint ones in order, and route the
 *      overlapping ones to the integrator role (L3c) to resolve + merge;
 *   4. publish each branch's output to the blackboard (fan-in), and fold
 *      everything into ONE OrchVerdict the graph can route on.
 *
 * Failure is always routable, never thrown: a join miss or a merge failure
 * becomes a `branch('fail')` verdict carrying correctives, which PlanRunner then
 * addresses to the next node.
 */
import { planMerge, type OrchNode, type ParallelBranch } from './LoopIR.js'
import type { OrchVerdict } from './Verdict.js'
import type { PlanRunContext } from './PlanRunner.js'

/** Result of running one branch's sub-agent. */
export interface BranchRunResult {
  id: string
  success: boolean
  /** Files the branch actually changed (from finalize) — input to L2. */
  changedFiles: string[]
  summary?: string
  error?: string
  costUsd: number
  /** Whether this branch may have written (drives whether it participates in merge). */
  isWriter: boolean
}

/** Outcome of a merge attempt. */
export interface MergeOutcome {
  merged: boolean
  error?: string
}

/** IO surface for a parallel node — run branches, merge, resolve conflicts. */
export interface BranchOps {
  /** Run one branch (its own isolated git branch if it writes) to terminal. */
  runBranch(branch: ParallelBranch, signal: AbortSignal): Promise<BranchRunResult>
  /** Merge a branch whose changes don't overlap anything merged before it. */
  mergeClean(branchId: string, signal: AbortSignal): Promise<MergeOutcome>
  /** Resolve a conflicting branch via the integrator role, then merge. */
  resolveAndMerge(
    args: { branchId: string; overlapsWith: string[]; files: string[]; integrator: string },
    signal: AbortSignal,
  ): Promise<MergeOutcome>
}

/** Default integrator role name when a parallel node doesn't name one. */
export const DEFAULT_INTEGRATOR_ROLE = 'integrator'

/** Run a `parallel` node end to end and return one unified verdict. */
export async function runParallelNode(
  ops: BranchOps,
  node: OrchNode,
  ctx: PlanRunContext,
): Promise<OrchVerdict> {
  const branches = node.branches ?? []
  if (branches.length === 0) {
    return { action: 'branch', label: 'error', note: `parallel node ${node.id} has no branches` }
  }

  // 1. fan out concurrently.
  const results = await Promise.all(branches.map(b => ops.runBranch(b, ctx.signal)))
  const costUsd = results.reduce((s, r) => s + (r.costUsd || 0), 0)

  // publish each branch's output for fan-in (non-consuming; downstream readFor).
  for (const r of results) {
    if (r.summary) ctx.blackboard?.post({ from: `${node.id}:${r.id}`, kind: 'output', messages: [r.summary] })
  }

  // 2. join policy.
  const successes = results.filter(r => r.success)
  const need = joinThreshold(node, branches.length)
  if (successes.length < need) {
    const failed = results.filter(r => !r.success)
    return {
      action: 'branch',
      label: 'fail',
      messages: failed.map(r => `分支 ${r.id} 未完成：${r.error ?? 'unknown'}`),
      note: `parallel join not met: ${successes.length}/${need} required`,
      data: { costUsd },
    }
  }

  // 3. merge successful writers (readers don't merge).
  const writers = successes.filter(r => r.isWriter)
  if (writers.length > 0) {
    const integrator = node.integrator || DEFAULT_INTEGRATOR_ROLE
    const plan = planMerge(writers.map(w => ({ id: w.id, changedFiles: w.changedFiles })))
    const conflictById = new Map(plan.conflicts.map(c => [c.branch, c]))
    const mergeFailures: string[] = []

    for (const id of plan.order) {
      if (ctx.signal.aborted) break
      const conflict = conflictById.get(id)
      const outcome = conflict
        ? await ops.resolveAndMerge(
            { branchId: id, overlapsWith: conflict.overlapsWith, files: conflict.files, integrator },
            ctx.signal,
          )
        : await ops.mergeClean(id, ctx.signal)
      if (!outcome.merged) {
        mergeFailures.push(
          `分支 ${id} 合并失败${conflict ? `（与 ${conflict.overlapsWith.join(',')} 在 ${conflict.files.join(',')} 冲突）` : ''}：${outcome.error ?? 'unknown'}`,
        )
      }
    }

    if (mergeFailures.length > 0) {
      return { action: 'branch', label: 'fail', messages: mergeFailures, note: 'parallel merge failed', data: { costUsd } }
    }
  }

  // 4. success.
  return {
    action: 'branch',
    label: 'ok',
    note: `parallel ${node.id}: ${successes.length}/${branches.length} branches ok${writers.length ? `, merged ${writers.length} writer(s)` : ''}`,
    data: { costUsd },
  }
}

/** How many branch successes satisfy the join policy. */
function joinThreshold(node: OrchNode, total: number): number {
  switch (node.join) {
    case 'any':
      return 1
    case 'quorum':
      return Math.min(Math.max(node.quorum ?? total, 1), total)
    case 'all':
    default:
      return total
  }
}

/** Convenience: is a branch a writer (used by ops adapters + the runner)? */
export function branchIsWriter(b: ParallelBranch): boolean {
  const FS_WRITE = new Set(['write_file', 'edit_file', 'notebook_edit'])
  return b.workspaceMode === 'isolated_write' || (b.allowedTools?.some(t => FS_WRITE.has(t)) ?? false)
}

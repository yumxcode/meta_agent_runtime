/**
 * KernelBranchOps — the REAL BranchOps adapter: runs each branch as an isolated
 * git-branch sub-agent (via the dispatcher + AutoWorktreeCoordinator) and merges
 * results back. The pure orchestration (join/plan/aggregate) lives in
 * ParallelBranchRunner; this file is the IO boundary.
 *
 * Safety: AutoWorktreeCoordinator.merge() is transactional with rollback — on a
 * git conflict it THROWS and restores the main tree, so a failed merge can never
 * corrupt the workspace. Disjoint writers (the L1-enforced common case) merge
 * clean. Overlapping writers are handed to the integrator role, which reconciles
 * the cited files; if it can't, we return merged:false and the run surfaces a
 * fail verdict (correctives) rather than risking a bad merge.
 *
 * NOTE: runBranch + mergeClean map directly onto the coordinator API and are the
 * solid common path. resolveAndMerge spawns the integrator and is the
 * integration boundary (its exact landing depends on the bridge autonomy jail);
 * it fails safe.
 */
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import type { SubAgentTaskId } from '../../subagent/types.js'
import type { AutoWorktreeCoordinator } from '../auto/AutoWorktreeCoordinator.js'
import type { ParallelBranch } from './LoopIR.js'
import { spawnAndWait } from './reviewer.js'
import { branchIsWriter, type BranchOps, type BranchRunResult, type MergeOutcome } from './ParallelBranchRunner.js'

export interface KernelBranchOpsDeps {
  dispatcher: ISubAgentDispatcher
  /** Worktree coordinator for isolated branches + merges. Absent → no real merge. */
  worktrees?: AutoWorktreeCoordinator | null
  pollMs?: number
  maxWaitMs?: number
}

/** Rubric for the integrator role (L3c): reconcile overlapping changes. */
export const INTEGRATOR_RUBRIC = `\
你是一个"集成合并 Agent"。两个并行分支改动了同一批文件，产生了冲突。
你的任务：阅读这些文件**当前（已合入前一个分支）的内容**与**另一分支的版本**，把两边的意图**合理融合**后写回这些文件——既不要丢失任一方的有效改动，也不要留下冲突标记。
只改这些冲突文件，不要扩大改动范围。完成后用一句话说明你是怎么融合的。`

export class KernelBranchOps implements BranchOps {
  private readonly taskByBranch = new Map<string, SubAgentTaskId>()
  private readonly worktreePathByBranch = new Map<string, string | undefined>()
  private readonly pollMs: number
  private readonly maxWaitMs: number

  constructor(private readonly deps: KernelBranchOpsDeps) {
    this.pollMs = deps.pollMs ?? 500
    this.maxWaitMs = deps.maxWaitMs ?? 24 * 60 * 1000
  }

  async runBranch(branch: ParallelBranch, signal: AbortSignal): Promise<BranchRunResult> {
    const isWriter = branchIsWriter(branch)
    const rec = await spawnAndWait(
      this.deps.dispatcher,
      {
        taskDescription: this.scopedTask(branch),
        systemPrompt: branch.systemPrompt,
        allowedTools: branch.allowedTools ?? [],
        maxTurns: branch.maxTurns ?? 12,
        maxBudgetUsd: branch.maxBudgetUsd ?? 0.5,
        requireHumanApproval: false,
        useEventDriven: false,
        pollIntervalMs: this.pollMs,
        checkpointEveryNTurns: 0,
        workspaceMode: branch.workspaceMode ?? 'shared_readonly',
      },
      signal,
      { pollMs: this.pollMs, maxWaitMs: this.maxWaitMs },
    )
    const cost = rec?.result?.costUsd ?? 0
    if (rec?.status !== 'completed' || !rec.result?.success) {
      return { id: branch.id, success: false, changedFiles: [], error: rec?.result?.error ?? `branch ${branch.id} did not complete`, costUsd: cost, isWriter }
    }
    this.taskByBranch.set(branch.id, rec.taskId)

    let changedFiles: string[] = []
    const wt = this.deps.worktrees
    if (isWriter && wt?.enabled) {
      try {
        const fin = await wt.finalize(rec.taskId)
        changedFiles = fin.changedFiles
        this.worktreePathByBranch.set(branch.id, wt.recordFor(rec.taskId)?.worktreePath)
      } catch (err) {
        return { id: branch.id, success: false, changedFiles: [], error: `finalize failed: ${msg(err)}`, costUsd: cost, isWriter }
      }
    }
    return { id: branch.id, success: true, changedFiles, summary: rec.result.summary, costUsd: cost, isWriter }
  }

  async mergeClean(branchId: string, _signal: AbortSignal): Promise<MergeOutcome> {
    const taskId = this.taskByBranch.get(branchId)
    const wt = this.deps.worktrees
    if (!taskId || !wt?.enabled) return { merged: true } // reader / non-git → nothing to merge
    try {
      const r = await wt.merge(taskId)
      return { merged: r?.merged ?? false }
    } catch (err) {
      // transactional rollback already restored the main tree.
      return { merged: false, error: msg(err) }
    }
  }

  async resolveAndMerge(
    args: { branchId: string; overlapsWith: string[]; files: string[]; integrator: string },
    signal: AbortSignal,
  ): Promise<MergeOutcome> {
    const taskId = this.taskByBranch.get(args.branchId)
    const wt = this.deps.worktrees
    if (!taskId || !wt?.enabled) return { merged: false, error: 'no worktree to integrate' }

    const branchPath = this.worktreePathByBranch.get(args.branchId)
    const task = [
      `集成合并：分支 '${args.branchId}' 与已合入的 [${args.overlapsWith.join(', ')}] 在以下文件冲突：`,
      args.files.map(f => `  - ${f}`).join('\n'),
      branchPath ? `\n分支 '${args.branchId}' 的版本在该工作树：${branchPath}` : '',
      '请将两边改动融合后写回主工作区的这些文件。',
    ].join('\n')

    const ir = await spawnAndWait(
      this.deps.dispatcher,
      {
        taskDescription: task,
        systemPrompt: INTEGRATOR_RUBRIC,
        allowedTools: ['read_file', 'grep', 'glob', 'edit_file', 'write_file', 'bash'],
        maxTurns: 12,
        maxBudgetUsd: 0.5,
        requireHumanApproval: false,
        useEventDriven: false,
        pollIntervalMs: this.pollMs,
        checkpointEveryNTurns: 0,
        // Sequential within the merge loop → the only writer at this moment.
        workspaceMode: 'shared_readonly',
      },
      signal,
      { pollMs: this.pollMs, maxWaitMs: this.maxWaitMs },
    )
    if (ir?.status !== 'completed' || !ir.result?.success) {
      return { merged: false, error: ir?.result?.error ?? `integrator '${args.integrator}' failed` }
    }
    // The integrator reconciled the files directly into the main tree; the
    // conflicting branch is now superseded — discard its worktree.
    try { await wt.discard(taskId) } catch { /* best-effort */ }
    return { merged: true }
  }

  /** Prefix the branch task with its write-scope so the agent self-limits (L1). */
  private scopedTask(branch: ParallelBranch): string {
    if (!branch.writeScope || branch.writeScope.length === 0) return branch.taskDescription
    return [
      `【写入范围限制】本分支只允许修改以下路径，不得改动范围之外的文件：`,
      branch.writeScope.map(p => `  - ${p}`).join('\n'),
      '',
      branch.taskDescription,
    ].join('\n')
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

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
import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import { DEFAULT_SUB_AGENT_MAX_DURATION_MS, type SubAgentTaskId } from '../../subagent/types.js'
import type { AutoWorktreeCoordinator } from '../auto/AutoWorktreeCoordinator.js'
import type { ParallelBranch } from './LoopIR.js'
import type { AutoOrchRunTreeOps } from './RunWorkspace.js'
import { spawnAndWait } from './reviewer.js'
import { branchIsWriter, type BranchOps, type BranchRunResult, type MergeOutcome } from './ParallelBranchRunner.js'

const DEFAULT_BRANCH_MAX_TURNS = 20
const DEFAULT_BRANCH_MAX_BUDGET_USD = 2
const DEFAULT_INTEGRATOR_MAX_TURNS = 30
const DEFAULT_INTEGRATOR_MAX_BUDGET_USD = 2
/** Mirrors KernelNodeRunner's executor fallback: a tool-less branch is hollow. */
const DEFAULT_WRITER_BRANCH_TOOLS = ['read_file', 'edit_file', 'write_file', 'grep', 'glob', 'bash']
const DEFAULT_READER_BRANCH_TOOLS = ['read_file', 'grep', 'glob']

export interface KernelBranchOpsDeps {
  dispatcher: ISubAgentDispatcher
  /** Worktree coordinator for isolated branches + merges. Absent → no real merge. */
  worktrees?: AutoWorktreeCoordinator | null
  /** Workspace root branches operate against (integration tree when run-scoped). */
  projectDir?: string
  /** Run integration tree — the integrator's reconciliation is committed through it. */
  runTree?: AutoOrchRunTreeOps
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
    this.maxWaitMs = deps.maxWaitMs ?? DEFAULT_SUB_AGENT_MAX_DURATION_MS + 60_000
  }

  async runBranch(branch: ParallelBranch, signal: AbortSignal): Promise<BranchRunResult> {
    const isWriter = branchIsWriter(branch)
    // Tool fallback (same rationale as KernelNodeRunner's executor default): an
    // empty allowedTools resolves to ZERO tools downstream, leaving the branch
    // able only to chat — it would "succeed" without doing anything.
    const fallbackTools = isWriter ? DEFAULT_WRITER_BRANCH_TOOLS : DEFAULT_READER_BRANCH_TOOLS
    const workspaceMode = branch.workspaceMode ?? 'shared_readonly'
    const rec = await spawnAndWait(
      this.deps.dispatcher,
      {
        taskDescription: this.scopedTask(branch),
        systemPrompt: branch.systemPrompt,
        allowedTools: branch.allowedTools && branch.allowedTools.length > 0
          ? branch.allowedTools
          : fallbackTools,
        maxTurns: branch.maxTurns ?? DEFAULT_BRANCH_MAX_TURNS,
        maxBudgetUsd: branch.maxBudgetUsd ?? DEFAULT_BRANCH_MAX_BUDGET_USD,
        requireHumanApproval: false,
        useEventDriven: false,
        pollIntervalMs: this.pollMs,
        checkpointEveryNTurns: 0,
        workspaceMode,
        // Readers must see the RUN's tree; isolated writers get their own
        // worktree projectDir from the bridge (fork of the run branch).
        ...(workspaceMode !== 'isolated_write' && this.deps.projectDir
          ? { projectDir: this.deps.projectDir }
          : {}),
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
        const outOfScope = filesOutsideWriteScope(changedFiles, branch.writeScope ?? [])
        if (outOfScope.length > 0) {
          try { await wt.discard(rec.taskId) } catch { /* best-effort */ }
          return {
            id: branch.id,
            success: false,
            changedFiles: [],
            error:
              `branch ${branch.id} modified files outside declared writeScope: ` +
              outOfScope.join(', '),
            costUsd: cost,
            isWriter,
          }
        }
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
    const integrationRoot = this.deps.runTree?.root ?? this.deps.projectDir
    if (!integrationRoot) {
      return { merged: false, error: 'no integration root to reconcile conflicting branches in' }
    }

    const branchPath = this.worktreePathByBranch.get(args.branchId)
    const task = [
      `集成合并：分支 '${args.branchId}' 与已合入的 [${args.overlapsWith.join(', ')}] 在以下文件冲突：`,
      args.files.map(f => `  - ${f}`).join('\n'),
      branchPath ? `\n分支 '${args.branchId}' 的版本在该工作树：${branchPath}` : '',
      '请将两边改动融合后写回当前工作区的这些文件。',
    ].join('\n')

    // Snapshot the conflict files BEFORE the integrator runs so we can verify it
    // actually reconciled something — "completed" alone is not a merge.
    const before = await snapshotFileHashes(integrationRoot, args.files)

    const ir = await spawnAndWait(
      this.deps.dispatcher,
      {
        taskDescription: task,
        systemPrompt: INTEGRATOR_RUBRIC,
        allowedTools: ['read_file', 'grep', 'glob', 'edit_file', 'write_file', 'bash'],
        maxTurns: DEFAULT_INTEGRATOR_MAX_TURNS,
        maxBudgetUsd: DEFAULT_INTEGRATOR_MAX_BUDGET_USD,
        requireHumanApproval: false,
        useEventDriven: false,
        pollIntervalMs: this.pollMs,
        checkpointEveryNTurns: 0,
        // The integrator MUST be able to write the reconciled files. The merge
        // loop is sequential, so it is the only writer at this moment. (It was
        // previously spawned shared_readonly, which strips write tools and
        // mounts a read-only sandbox — it could never actually merge.)
        workspaceMode: 'shared_write',
        projectDir: integrationRoot,
      },
      signal,
      { pollMs: this.pollMs, maxWaitMs: this.maxWaitMs },
    )
    if (ir?.status !== 'completed' || !ir.result?.success) {
      // Keep the conflicting branch worktree: its changes are the only copy of
      // that branch's work. The join fails routable-y; cleanup happens at the
      // run boundary, never silently here.
      return { merged: false, error: ir?.result?.error ?? `integrator '${args.integrator}' failed` }
    }

    const verified = await verifyIntegration(integrationRoot, args.files, before)
    if (!verified.ok) {
      return { merged: false, error: `integrator '${args.integrator}' did not produce a usable merge: ${verified.reason}` }
    }

    // Persist the reconciliation onto the run branch so subsequent task merges
    // land on a clean integration tree (and the result survives into the final
    // run-branch → main merge).
    if (this.deps.runTree) {
      try {
        await this.deps.runTree.commitAll(`auto_orch: integrate branch ${args.branchId}`)
      } catch (err) {
        return { merged: false, error: `could not commit integration result: ${msg(err)}` }
      }
    }

    // Only NOW is the conflicting branch superseded — discard its worktree.
    try { await wt.discard(taskId) } catch { /* best-effort */ }
    return { merged: true }
  }

  /** Prefix the branch task with its write-scope so the agent self-limits (L1). */
  private scopedTask(branch: ParallelBranch): string {
    if (!branch.writeScope || branch.writeScope.length === 0) return branch.taskDescription
    return [
      `【写入范围限制】本分支只允许修改以下路径，不得改动范围之外的文件：`,
      branch.writeScope.map(p => `  - ${p}`).join('\n'),
      `【禁止】写 .meta-agent/ 下任何路径——该目录在合并时被排除，写入会被静默丢弃；跨节点状态一律写工作区根目录 state/ 下。`,
      '',
      branch.taskDescription,
    ].join('\n')
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── Integration verification (H1) ────────────────────────────────────────────────

/** sha256 per file; null = file missing/unreadable. */
export async function snapshotFileHashes(
  root: string,
  files: readonly string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  for (const file of files) {
    try {
      const data = await readFile(join(root, file))
      out.set(file, createHash('sha256').update(data).digest('hex'))
    } catch {
      out.set(file, null)
    }
  }
  return out
}

/**
 * Did the integrator actually reconcile? Requires (a) at least one conflict
 * file to have changed (or been created) relative to the pre-run snapshot and
 * (b) no git conflict markers left in any conflict file. A run that changed
 * nothing "completed" without merging and must NOT count as merged.
 */
export async function verifyIntegration(
  root: string,
  files: readonly string[],
  before: ReadonlyMap<string, string | null>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const after = await snapshotFileHashes(root, files)
  let anyChanged = false
  for (const file of files) {
    const now = after.get(file)
    if (now === null || now === undefined) continue
    try {
      const text = await readFile(join(root, file), 'utf-8')
      if (/^(<{7}|={7}|>{7})( |$)/m.test(text)) {
        return { ok: false, reason: `conflict markers remain in ${file}` }
      }
    } catch { /* binary/unreadable → marker check skipped */ }
    if (now !== before.get(file)) anyChanged = true
  }
  if (!anyChanged) return { ok: false, reason: 'no conflict file was modified' }
  return { ok: true }
}

/** Files not covered by the branch's declared write-scope. Empty scope covers nothing. */
export function filesOutsideWriteScope(files: readonly string[], scope: readonly string[]): string[] {
  const matchers = scope.map(globToRegExp)
  return files.filter(file => {
    const paths = expandGitStatusPath(file).map(normalizePathForScope)
    return paths.some(path => !matchers.some(re => re.test(path)))
  })
}

function expandGitStatusPath(file: string): string[] {
  const trimmed = file.trim()
  if (!trimmed.includes(' -> ')) return [trimmed]
  return trimmed.split(' -> ').map(s => s.trim()).filter(Boolean)
}

function normalizePathForScope(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

function globToRegExp(glob: string): RegExp {
  const g = normalizePathForScope(glob.trim()).replace(/\/+$/, '')
  if (!g || g === '**' || g === '*') return /^.*$/
  let out = '^'
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]!
    if (ch === '*') {
      if (g[i + 1] === '*') {
        out += '.*'
        i++
      } else {
        out += '[^/]*'
      }
    } else {
      out += ch.replace(/[\\^$+?.()|[\]{}]/g, '\\$&')
    }
  }
  return new RegExp(out + '$')
}

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
import { DEFAULT_SUB_AGENT_MAX_DURATION_MS } from '../../subagent/types.js'
import type { NodeRunner, PlanRunContext } from './PlanRunner.js'
import type { OrchNode } from './LoopIR.js'
import type { OrchVerdict } from './Verdict.js'
import { RoleCatalog, defaultRoleCatalog } from './RoleRegistry.js'
import { spawnAndWait, type SpawnWaitOptions } from './reviewer.js'
import { runParallelNode, type BranchOps } from './ParallelBranchRunner.js'
import { KernelBranchOps } from './KernelBranchOps.js'
import type { AutoWorktreeCoordinator } from '../auto/AutoWorktreeCoordinator.js'
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { copyFile, mkdir } from 'fs/promises'
import { dirname, relative, resolve } from 'path'
import { promisify } from 'util'
import { isAutoOrchPauseOutput } from './AutoOrchPauseTool.js'
import { writeAutoOrchSubAgentSession } from './AutoOrchSubAgentSessionStore.js'
import { CodeNodeRunner } from './CodeNodeRunner.js'
import type { AutoOrchRunTreeOps } from './RunWorkspace.js'

// Re-exported for back-compat (and because they belong to the role surface).
export { parseRoleVerdict } from './reviewer.js'

// Defense-in-depth: an executor node with NO allowedTools resolves to ZERO
// tools downstream (SubAgentRunner treats [] as "no tools"), so the sub-agent
// could only chat — unable to read/edit/test. Rather than let such a node run
// hollow, fall back to a standard read+write+shell toolset. Planner-emitted
// nodes always carry their own allowedTools; this only catches omissions.
const DEFAULT_EXECUTOR_TOOLS = ['read_file', 'edit_file', 'write_file', 'grep', 'glob', 'bash']
const DEFAULT_EXECUTOR_MAX_TURNS = 30
const DEFAULT_EXECUTOR_MAX_BUDGET_USD = 2
const execFileAsync = promisify(execFile)
const AUTO_ORCH_PAUSE_HINT = `\
如果你启动或发现了需要等待外部结果的长任务（例如训练任务、远程评测、批处理实验），不要阻塞等待。
请调用 auto_orch_pause_external，提供 externalRunId、建议的 nextCheckAfterMs 和恢复时需要遵循的 resumeInstruction。`
const EXECUTOR_RESULT_CONTRACT = `\
你是 auto_orch 图中的 executor 节点。完成时必须调用 return_result，并在 data 中写入：
{"label":"ok"|"error","note":"一句话说明"}
只有当节点任务真实完成且下游可继续时才返回 ok；缺少必要输入、状态文件不合法、或无法继续时返回 error。
路径硬性约定：所有跨节点共享的状态/产出写到工作区根目录 state/ 下（如 state/progress.json）。
**禁止**写 .meta-agent/ 下任何路径——该目录是运行时内部元数据，合并时会被排除，写入的文件会被静默丢弃、下游节点读不到；工具层也会直接拒绝这类写入。
即使节点任务描述里出现了 .meta-agent/ 路径，也应将其理解为对应的 state/ 路径。`

export interface KernelNodeRunnerOptions {
  /** Max wall-clock to wait for a single node's sub-agent. Default 24 min. */
  maxWaitMsPerNode?: number
  /** Poll cadence while waiting. Default 500 ms. */
  pollMs?: number
  /** Role catalogue used to resolve `role` nodes. Default = built-ins. */
  roleCatalog?: RoleCatalog
  /**
   * Workspace root every node operates against. When a run workspace is active
   * this is the INTEGRATION tree (see RunWorkspace) — roles review it, code
   * nodes write state/ in it, executor merges land on the run branch.
   */
  projectDir?: string
  /** Live goal accessor, forwarded to role handlers. */
  getGoal?: () => string | null
  /** IO ops for `parallel` nodes. Default = KernelBranchOps over the dispatcher. */
  branchOps?: BranchOps
  /** Worktree coordinator for isolated writers (run-scoped when runTree is set). */
  worktrees?: AutoWorktreeCoordinator | null
  /** Optional global override for executor sub-agent turn limits. */
  executorMaxTurns?: number
  /**
   * Root holding frozen code-node artifacts (.meta-agent/auto_orch/code_nodes).
   * Always the MAIN workspace; differs from projectDir under a run workspace.
   */
  codeArtifactRoot?: string
  /** Active run integration tree; enables eager state commits onto the run branch. */
  runTree?: AutoOrchRunTreeOps
}

export class KernelNodeRunner implements NodeRunner {
  private readonly maxWaitMs: number
  private readonly pollMs: number
  private readonly roleCatalog: RoleCatalog
  private readonly projectDir: string
  private readonly getGoal: () => string | null
  private readonly branchOps: BranchOps
  private readonly orchestrationTaskId: string
  private readonly codeRunner: CodeNodeRunner
  private readonly worktrees: AutoWorktreeCoordinator | null
  private readonly executorMaxTurns?: number
  private readonly runTree?: AutoOrchRunTreeOps

  constructor(
    private readonly dispatcher: ISubAgentDispatcher,
    opts?: KernelNodeRunnerOptions,
  ) {
    this.maxWaitMs = opts?.maxWaitMsPerNode ?? DEFAULT_SUB_AGENT_MAX_DURATION_MS + 60_000
    this.pollMs = opts?.pollMs ?? 500
    this.roleCatalog = opts?.roleCatalog ?? defaultRoleCatalog()
    this.projectDir = opts?.projectDir ?? process.cwd()
    this.getGoal = opts?.getGoal ?? (() => null)
    this.orchestrationTaskId = `auto-orch-${randomUUID()}`
    this.runTree = opts?.runTree
    this.codeRunner = new CodeNodeRunner({
      projectDir: this.projectDir,
      codeRoot: opts?.codeArtifactRoot ?? this.projectDir,
    })
    this.worktrees = opts?.worktrees ?? null
    this.executorMaxTurns = opts?.executorMaxTurns
    this.branchOps = opts?.branchOps ?? new KernelBranchOps({
      dispatcher,
      worktrees: this.worktrees,
      projectDir: this.projectDir,
      runTree: this.runTree,
      pollMs: this.pollMs,
      maxWaitMs: this.maxWaitMs,
    })
  }

  async run(node: OrchNode, ctx: PlanRunContext): Promise<OrchVerdict> {
    try {
      if (node.kind === 'parallel') return await runParallelNode(this.branchOps, node, ctx)
      if (node.kind === 'code') {
        const verdict = await this.codeRunner.run(node, ctx.signal)
        // Eagerly commit the code node's state/ writes onto the run branch so
        // the integration tree is clean when the next task branch merges.
        if (this.runTree) {
          await this.runTree.commitAll(`auto_orch: code node ${node.id}`).catch(() => false)
        }
        return verdict
      }
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
    // Blackboard: consume reviewer feedback ADDRESSED TO THIS NODE and prepend it
    // so this re-run fixes the cited gaps (closing the generate→verify→fix loop).
    // Addressing (vs a global queue) keeps node B's feedback from leaking to C.
    const reviewerPreface = ctx.blackboard?.takeCorrectivePrefaceFor(node.id) ?? ''

    // Merge-diagnosis corrective loop: a node whose sub-agent "succeeded" but
    // whose canonical outputs never landed (merge-excluded writes, missing
    // declared outputs) gets ONE in-place retry carrying the exact diagnosis —
    // the cheapest self-correction loop short of routing the graph's error
    // edge. Bounded so a structurally-broken node still surfaces as 'error'.
    let mergeCorrective = ''
    let accumulatedCost = 0
    for (let attempt = 0; attempt <= MAX_MERGE_CORRECTIVE_RETRIES; attempt++) {
      const verdict = await this.runExecutorAttempt(node, ctx, [reviewerPreface, mergeCorrective])
      accumulatedCost += costOf(verdict)
      const diagnosis = (verdict.data as Record<string, unknown> | undefined)?.['mergeDiagnosis']
      if (typeof diagnosis !== 'string' || attempt >= MAX_MERGE_CORRECTIVE_RETRIES) {
        return withCost(verdict, accumulatedCost)
      }
      mergeCorrective = buildMergeCorrectivePreface(diagnosis)
    }
    // Unreachable, but keeps the compiler honest.
    return { action: 'branch', label: 'error', note: `executor ${node.id} corrective loop exhausted` }
  }

  private async runExecutorAttempt(
    node: OrchNode,
    ctx: PlanRunContext,
    prefaces: string[],
  ): Promise<OrchVerdict> {
    const taskDescription = [
      ...prefaces.filter(Boolean),
      node.taskDescription,
      AUTO_ORCH_PAUSE_HINT,
    ].filter(Boolean).join('\n\n')
    const rec = await spawnAndWait(
      this.dispatcher,
      {
        taskDescription,
        systemPrompt: [node.systemPrompt, EXECUTOR_RESULT_CONTRACT].filter(Boolean).join('\n\n'),
        allowedTools: node.allowedTools && node.allowedTools.length > 0 ? node.allowedTools : DEFAULT_EXECUTOR_TOOLS,
        maxTurns: this.executorMaxTurns ?? node.maxTurns ?? DEFAULT_EXECUTOR_MAX_TURNS,
        maxBudgetUsd: node.maxBudgetUsd ?? DEFAULT_EXECUTOR_MAX_BUDGET_USD,
        requireHumanApproval: false,
        useEventDriven: false,
        pollIntervalMs: this.pollMs,
        checkpointEveryNTurns: 0,
        // Writers MUST be isolated (validatePlan enforces this); default readonly.
        workspaceMode: node.workspaceMode ?? 'shared_readonly',
        // Under a run workspace, readers must see the INTEGRATION tree (the
        // autonomy jail would otherwise fill the main root, which the run never
        // writes). Isolated writers get their worktree projectDir from the
        // bridge — forked from the run branch — so they are left alone.
        ...(this.runTree && node.workspaceMode !== 'isolated_write'
          ? { projectDir: this.projectDir }
          : {}),
        autoOrch: {
          resumable: true,
          orchestrationTaskId: this.orchestrationTaskId,
          nodeId: node.id,
        },
      },
      ctx.signal,
      this.spawnOpts(),
    )
    const cost = rec?.result?.costUsd ?? 0
    if (rec?.status === 'completed' && rec.result?.success && isAutoOrchPauseOutput(rec.result.output)) {
      const pause = rec.result.output.auto_orch_pause
      const agentSessionId = rec.config.autoOrch?.agentSessionId
      const resumeHandle = {
        orchestrationTaskId: this.orchestrationTaskId,
        nodeId: node.id,
        subTaskId: rec.taskId,
        ...(agentSessionId ? { agentSessionId } : {}),
        ...(pause.externalRunId ? { externalRunId: pause.externalRunId } : {}),
        ...(pause.nextCheckAfterMs !== undefined ? { nextCheckAfterMs: pause.nextCheckAfterMs } : {}),
        ...(pause.resumeInstruction ? { resumeInstruction: pause.resumeInstruction } : {}),
      }
      if (agentSessionId) {
        await writeAutoOrchSubAgentSession({
          schemaVersion: '1.0',
          orchestrationTaskId: this.orchestrationTaskId,
          nodeId: node.id,
          subTaskId: rec.taskId,
          agentSessionId,
          status: 'paused_waiting_external',
          pauseReason: pause.reason,
          externalRunId: pause.externalRunId,
          resumeInstruction: pause.resumeInstruction,
          lastHistoryMessageCount: undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }).catch(() => undefined)
      }
      return {
        action: 'branch',
        label: 'paused',
        note: pause.resumeInstruction ?? `paused: ${pause.reason}`,
        data: { costUsd: cost, resumeHandle, autoOrchPause: pause },
      }
    }
    if (rec?.status === 'completed' && rec.result?.success) {
      const parsed = parseExecutorVerdict(rec.result.output, rec.result.summary)
      if (parsed?.label === 'error') {
        return { action: 'branch', label: 'error', note: parsed.note ?? truncate(rec.result.summary), data: { costUsd: cost } }
      }
      const merge = await this.mergeSequentialExecutor(node, rec.taskId)
      if (!merge.ok) {
        return {
          action: 'branch',
          label: 'error',
          note: merge.note,
          data: { costUsd: cost, ...(merge.diagnosis ? { mergeDiagnosis: merge.diagnosis } : {}) },
        }
      }
      // Declared-outputs contract: the merge landed, but did the artifacts the
      // planner declared actually reach the integration tree? A node that
      // "succeeded" without producing them gets a diagnosable error instead of
      // silently poisoning every downstream node.
      const missing = this.missingDeclaredOutputs(node)
      if (missing.length > 0) {
        const diagnosis =
          `node '${node.id}' returned ok and merged, but its declared outputs are missing from the ` +
          `canonical workspace: ${missing.join(', ')}. Writes outside the worktree, under merge-excluded ` +
          `paths (.meta-agent/**), or never performed at all end up here. Write EXACTLY the declared ` +
          `workspace-relative paths (canonical state belongs under state/ at the workspace root).`
        return {
          action: 'branch',
          label: 'error',
          note: `declared outputs missing after merge: ${missing.join(', ')}`,
          data: { costUsd: cost, mergeDiagnosis: diagnosis },
        }
      }
      return { action: 'branch', label: 'ok', note: parsed?.note ?? truncate(rec.result.summary), data: { costUsd: cost } }
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
    // Posting correctives is the orchestrator's job (PlanRunner), since only it
    // knows the topology to address them to the right successor node. Here we
    // just return the verdict; its `messages` become addressed feedback there.
    return handler({ criteria: node.taskDescription, signal: ctx.signal })
  }

  private spawnOpts(): SpawnWaitOptions {
    return { pollMs: this.pollMs, maxWaitMs: this.maxWaitMs }
  }

  private async mergeSequentialExecutor(
    node: OrchNode,
    taskId: string,
  ): Promise<{ ok: true } | { ok: false; note: string; diagnosis?: string }> {
    if (node.workspaceMode !== 'isolated_write' || !this.worktrees?.enabled) return { ok: true }
    try {
      const record = this.worktrees.recordFor(taskId)
      const finalized = await this.worktrees.finalize(taskId)
      // Guard: finalize excludes .meta-agent/** — if the node's writes ended up
      // there, they are about to be silently discarded. Fail LOUDLY with the
      // file list so the corrective retry (or a human reading the run log) can
      // see exactly what evaporated and why.
      if (record) {
        const discarded = await metaAgentWritesIn(record.worktreePath)
        if (discarded.length > 0) {
          const diagnosis =
            `node '${node.id}' wrote ${discarded.length} file(s) under .meta-agent/ which are ` +
            `EXCLUDED from finalize/merge and will never reach the canonical workspace: ` +
            `${discarded.slice(0, 8).join(', ')}${discarded.length > 8 ? ', …' : ''}. ` +
            `Write canonical cross-node state under state/ at the workspace root instead ` +
            `(e.g. state/progress.json), then re-do the work at those paths.`
          return { ok: false, note: `writes under merge-excluded .meta-agent/ for ${node.id}`, diagnosis }
        }
      }
      const changedFiles = finalized.changedFiles.length || !record
        ? finalized.changedFiles
        : await committedChangedFiles(record.worktreePath, record.forkPoint)
      if (record && stateOnlyChanges(changedFiles)) {
        await syncStateFiles(record.worktreePath, this.projectDir, changedFiles)
        await this.worktrees.discard(taskId)
        return { ok: true }
      }
      const result = await this.worktrees.merge(taskId, {
        message: `meta-agent: auto_orch merge ${node.id}`,
      })
      if (result?.merged === false) {
        return { ok: false, note: `isolated worktree merge failed for ${node.id}` }
      }
      return { ok: true }
    } catch (err) {
      return {
        ok: false,
        note: `isolated worktree merge failed for ${node.id}: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  /** Declared outputs (layer-4 contract) that do NOT exist in the integration tree. */
  private missingDeclaredOutputs(node: OrchNode): string[] {
    const declared = node.outputs ?? []
    if (declared.length === 0) return []
    const missing: string[] = []
    for (const rel of declared) {
      try {
        if (!existsSync(safeJoin(this.projectDir, rel))) missing.push(rel)
      } catch {
        missing.push(rel) // path escapes workspace → treat as missing/invalid
      }
    }
    return missing
  }
}

/** How many in-place corrective retries a failed merge/output contract earns. */
const MAX_MERGE_CORRECTIVE_RETRIES = 1

function buildMergeCorrectivePreface(diagnosis: string): string {
  return [
    '【上一次执行的产出未落地，本次为纠正性重试】',
    diagnosis,
    '硬性要求：所有跨节点状态写到工作区根目录 state/ 下；不要写 .meta-agent/ 下任何路径（会在合并时被丢弃）。',
  ].join('\n')
}

function costOf(v: OrchVerdict): number {
  const c = (v.data as Record<string, unknown> | undefined)?.['costUsd']
  return typeof c === 'number' && Number.isFinite(c) ? c : 0
}

/** Return the verdict with data.costUsd replaced by the loop's accumulated cost. */
function withCost(v: OrchVerdict, costUsd: number): OrchVerdict {
  return { ...v, data: { ...(v.data as Record<string, unknown> | undefined), costUsd } }
}

/** Untracked/dirty files under .meta-agent/ inside a worktree (merge-excluded). */
async function metaAgentWritesIn(worktreePath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      // --ignored: repos commonly gitignore .meta-agent/ — those writes are
      // just as discarded, so they must show up in this guard too.
      ['status', '--porcelain', '-uall', '--ignored', '--', '.meta-agent'],
      { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 },
    )
    return stdout.split('\n').map(s => s.slice(3).trim()).filter(Boolean)
  } catch {
    return [] // best-effort guard — never block the merge path on git hiccups
  }
}

function stateOnlyChanges(files: readonly string[]): boolean {
  return files.length > 0 && files.every(file => normalizeChangedFile(file).startsWith('state/'))
}

async function committedChangedFiles(worktreePath: string, forkPoint: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['diff', '--name-only', `${forkPoint}..HEAD`, '--'], {
    cwd: worktreePath,
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout.split('\n').map(s => s.trim()).filter(Boolean)
}

async function syncStateFiles(fromRoot: string, toRoot: string, files: readonly string[]): Promise<void> {
  for (const raw of files) {
    const rel = normalizeChangedFile(raw)
    if (!rel.startsWith('state/')) continue
    const from = safeJoin(fromRoot, rel)
    const to = safeJoin(toRoot, rel)
    await mkdir(dirname(to), { recursive: true })
    await copyFile(from, to)
  }
}

function normalizeChangedFile(file: string): string {
  const trimmed = file.trim()
  const path = trimmed.includes(' -> ') ? trimmed.split(' -> ').pop()!.trim() : trimmed
  return path.replace(/\\/g, '/').replace(/^\/+/, '')
}

function safeJoin(root: string, relPath: string): string {
  const absRoot = resolve(root)
  const abs = resolve(absRoot, relPath)
  const rel = relative(absRoot, abs)
  if (rel.startsWith('..') || rel === '' || rel.startsWith('/')) {
    throw new Error(`path escapes workspace: ${relPath}`)
  }
  return abs
}

function truncate(s: string, n = 500): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

function parseExecutorVerdict(
  output: unknown,
  summary: string,
): { label: 'ok' | 'error'; note?: string } | null {
  const fromObject = parseExecutorVerdictObject(output)
  if (fromObject) return fromObject

  const fences = [...summary.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m => m[1] ?? '')
  const candidates = fences.length ? [...fences] : []
  const lastBrace = summary.lastIndexOf('{')
  if (lastBrace !== -1) candidates.push(summary.slice(lastBrace))
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i]!.trim())
      const verdict = parseExecutorVerdictObject(parsed)
      if (verdict) return verdict
    } catch {
      // next candidate
    }
  }

  if (/^\s*(返回\s*)?error(?:[。:：\s]|$)/i.test(summary)) {
    return { label: 'error', note: truncate(summary) }
  }
  if (/^\s*(返回\s*)?ok(?:[。:：\s]|$)/i.test(summary)) {
    return { label: 'ok', note: truncate(summary) }
  }
  return null
}

function parseExecutorVerdictObject(value: unknown): { label: 'ok' | 'error'; note?: string } | null {
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  const nested = parseExecutorVerdictObject(obj['verdict'])
  if (nested) return nested
  const raw = obj['label'] ?? obj['status']
  if (raw !== 'ok' && raw !== 'error') return null
  return {
    label: raw,
    note: typeof obj['note'] === 'string'
      ? obj['note']
      : typeof obj['summary'] === 'string'
        ? obj['summary']
        : undefined,
  }
}

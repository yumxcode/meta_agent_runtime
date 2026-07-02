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
import { isAutoOrchPauseOutput } from './AutoOrchPauseTool.js'
import { writeAutoOrchSubAgentSession } from './AutoOrchSubAgentSessionStore.js'
import { CodeNodeRunner } from './CodeNodeRunner.js'

// Re-exported for back-compat (and because they belong to the role surface).
export { parseRoleVerdict } from './reviewer.js'

// Defense-in-depth: an executor node with NO allowedTools resolves to ZERO
// tools downstream (SubAgentRunner treats [] as "no tools"), so the sub-agent
// could only chat — unable to read/edit/test. Rather than let such a node run
// hollow, fall back to a standard read+write+shell toolset. Planner-emitted
// nodes always carry their own allowedTools; this only catches omissions.
const DEFAULT_EXECUTOR_TOOLS = ['read_file', 'edit_file', 'write_file', 'grep', 'glob', 'bash']
const DEFAULT_EXECUTOR_MAX_TURNS = 30
const AUTO_ORCH_PAUSE_HINT = `\
如果你启动或发现了需要等待外部结果的长任务（例如训练任务、远程评测、批处理实验），不要阻塞等待。
请调用 auto_orch_pause_external，提供 externalRunId、建议的 nextCheckAfterMs 和恢复时需要遵循的 resumeInstruction。`
const EXECUTOR_RESULT_CONTRACT = `\
你是 auto_orch 图中的 executor 节点。完成时必须调用 return_result，并在 data 中写入：
{"label":"ok"|"error","note":"一句话说明"}
只有当节点任务真实完成且下游可继续时才返回 ok；缺少必要输入、状态文件不合法、或无法继续时返回 error。`

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
  /** IO ops for `parallel` nodes. Default = KernelBranchOps over the dispatcher. */
  branchOps?: BranchOps
  /** Worktree coordinator for parallel writers' isolated branches + merges. */
  worktrees?: AutoWorktreeCoordinator | null
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
    this.codeRunner = new CodeNodeRunner({ projectDir: this.projectDir })
    this.branchOps = opts?.branchOps ?? new KernelBranchOps({
      dispatcher,
      worktrees: opts?.worktrees ?? null,
      pollMs: this.pollMs,
      maxWaitMs: this.maxWaitMs,
    })
  }

  async run(node: OrchNode, ctx: PlanRunContext): Promise<OrchVerdict> {
    try {
      if (node.kind === 'parallel') return await runParallelNode(this.branchOps, node, ctx)
      if (node.kind === 'code') return await this.codeRunner.run(node, ctx.signal)
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
    const preface = ctx.blackboard?.takeCorrectivePrefaceFor(node.id) ?? ''
    const taskDescription = [
      preface || null,
      node.taskDescription,
      AUTO_ORCH_PAUSE_HINT,
    ].filter(Boolean).join('\n\n')
    const rec = await spawnAndWait(
      this.dispatcher,
      {
        taskDescription,
        systemPrompt: [node.systemPrompt, EXECUTOR_RESULT_CONTRACT].filter(Boolean).join('\n\n'),
        allowedTools: node.allowedTools && node.allowedTools.length > 0 ? node.allowedTools : DEFAULT_EXECUTOR_TOOLS,
        maxTurns: node.maxTurns ?? DEFAULT_EXECUTOR_MAX_TURNS,
        maxBudgetUsd: node.maxBudgetUsd ?? 0.5,
        requireHumanApproval: false,
        useEventDriven: false,
        pollIntervalMs: this.pollMs,
        checkpointEveryNTurns: 0,
        // Writers MUST be isolated (validatePlan enforces this); default readonly.
        workspaceMode: node.workspaceMode ?? 'shared_readonly',
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

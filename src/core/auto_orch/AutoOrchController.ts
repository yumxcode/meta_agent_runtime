/**
 * AutoOrchController — the end-to-end driver that turns a goal into an executed
 * orchestration loop.
 *
 *   goal ──▶ Planner (LLM authors OrchPlan) ──▶ PlanRunner walks the graph ──▶
 *           each node ──▶ KernelNodeRunner spawns a real sub-agent
 *
 * This is the single object the backend constructs for auto_orch and the router
 * kicks off on the first turn. It owns NO execution logic of its own beyond
 * sequencing the three pieces and rendering a short human-readable summary of
 * what the orchestration did — all the safety (validation, bounds, fail-open)
 * already lives in the Planner and PlanRunner.
 */
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import type { PhaseHookFn } from '../../kernel/loop/PhaseHooks.js'
import { makeAutoOrchPlanner, type AutoOrchPlannerDeps, type PlannerOutcome } from './PlannerAgent.js'
import { KernelNodeRunner, type KernelNodeRunnerOptions } from './KernelNodeRunner.js'
import { PlanRunner, type PlanRunResult } from './PlanRunner.js'
import { Blackboard } from './Blackboard.js'
import { HookRegistry } from './HookRegistry.js'
import { continueVerdict } from './Verdict.js'
import type { AutoOrchScheduler } from './AutoOrchScheduler.js'
import { materializeCodeNodes } from './CodeNodeAuthor.js'
import type { AutoOrchObserver } from './Observer.js'
import {
  appendAutoOrchPlanRun,
  saveApprovedAutoOrchPlan,
  saveMaterializedAutoOrchPlan,
  type AutoOrchStoredPlanRef,
} from './PlanStore.js'
import type {
  AutoWorktreeCleanupStrategy,
  AutoWorktreeCoordinator,
} from '../auto/AutoWorktreeCoordinator.js'
import {
  createAutoOrchRunWorkspace,
  sweepStaleAutoOrchRuns,
  type AutoOrchRunWorkspace,
} from './RunWorkspace.js'
import { listAutoOrchSchedules } from './AutoOrchScheduleStore.js'
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises'
import { dirname, join, relative, resolve } from 'path'

export interface AutoOrchControllerDeps extends AutoOrchPlannerDeps {
  /** Per-node sub-agent wait/poll tuning, forwarded to the KernelNodeRunner. */
  nodeRunnerOptions?: KernelNodeRunnerOptions
  /** Optional framework scheduler that resumes paused auto_orch sub-agents. */
  scheduler?: AutoOrchScheduler
  /** Optional observability sink for graph execution events. */
  observer?: AutoOrchObserver
  /** Best-effort cleanup for auto-series isolated-write worktrees after terminal runs. */
  worktreeCleanup?: {
    coordinator: AutoWorktreeCoordinator
    strategy: AutoWorktreeCleanupStrategy
  }
  /**
   * Rebinds the sub-agent bridge's worktree coordinator for the duration of a
   * run so isolated writers fork from / merge into the RUN branch instead of
   * main. Called with the run coordinator at run start and null (restore the
   * base coordinator) at run end.
   */
  worktreeBinding?: (coordinator: AutoWorktreeCoordinator | null) => void
}

export interface OrchestrationResult {
  /** How the executed plan was obtained. */
  planSource: PlannerOutcome['source']
  /** The plan-runner outcome (status, visited path, cost, …). */
  run: PlanRunResult
  /** Planner note (esp. when it fell back). */
  planNote?: string
  /** A short human-readable recap suitable for the session result text. */
  summary: string
}

const PROCESS_FILE_ROOTS = ['state']

export class AutoOrchController {
  private readonly plan: ReturnType<typeof makeAutoOrchPlanner>
  private readonly nodeRunner: KernelNodeRunner
  private readonly scheduler?: AutoOrchScheduler
  private readonly dispatcher: ISubAgentDispatcher
  private readonly projectDir: string
  private readonly observer?: AutoOrchObserver
  private readonly getGoal: () => string | null
  private readonly worktreeCleanup?: AutoOrchControllerDeps['worktreeCleanup']
  private readonly worktreeBinding?: AutoOrchControllerDeps['worktreeBinding']
  private readonly nodeRunnerOptions?: KernelNodeRunnerOptions

  constructor(deps: AutoOrchControllerDeps) {
    this.plan = makeAutoOrchPlanner(deps)
    this.scheduler = deps.scheduler
    this.dispatcher = deps.dispatcher
    this.projectDir = deps.projectDir
    this.observer = deps.observer
    this.getGoal = deps.getGoal
    this.worktreeCleanup = deps.worktreeCleanup
    this.worktreeBinding = deps.worktreeBinding
    this.nodeRunnerOptions = deps.nodeRunnerOptions
    // Fallback (non-git workspace) runner: nodes operate on the main tree, as
    // before. When a run workspace is created, run() builds a RUN-SCOPED runner
    // pointed at the integration tree instead.
    this.nodeRunner = new KernelNodeRunner(deps.dispatcher, {
      projectDir: deps.projectDir,
      getGoal: deps.getGoal,
      ...deps.nodeRunnerOptions,
    })
  }

  /**
   * Plan, then execute the plan graph. Never throws — a failed planner falls
   * back to a single-executor plan, and PlanRunner resolves every failure path
   * to a result so the caller (router) can always report something coherent.
   */
  async run(signal: AbortSignal): Promise<OrchestrationResult> {
    let planned: PlannerOutcome | undefined
    let finalRun: PlanRunResult | undefined
    let workspace: AutoOrchRunWorkspace | undefined
    const processSnapshot = await captureProcessFileSnapshot(this.projectDir).catch(() => undefined)
    try {
      planned = await this.plan(signal)
      let storedPlanRef: AutoOrchStoredPlanRef | undefined
      if (signal.aborted) {
        const run: PlanRunResult = {
          status: 'aborted',
          visitedPath: [],
          steps: [],
          costUsd: 0,
          note: 'parent run aborted before graph execution',
        }
        finalRun = run
        return {
          planSource: planned.source,
          run,
          planNote: planned.note,
          summary: renderSummary(planned, run, 0),
        }
      }
      if (planned.approvedByUser) {
        const goal = this.safeGoal()
        storedPlanRef = await saveApprovedAutoOrchPlan(this.projectDir, {
          goal,
          plan: planned.plan,
          source: planned.source,
          approvedByUser: true,
          note: planned.note,
        }).catch(() => undefined)
      }
      const materialized = await materializeCodeNodes(
        planned.plan,
        { dispatcher: this.dispatcher, projectDir: this.projectDir },
        signal,
      )
      if (materialized.errors.length) {
        const run: PlanRunResult = {
          status: 'invalid',
          visitedPath: [],
          steps: [],
          costUsd: 0,
          note: materialized.errors.join('; '),
        }
        finalRun = run
        return {
          planSource: planned.source,
          run,
          planNote: planned.note,
          summary: renderSummary(planned, run, 0),
        }
      }
      const materializedPlanRef = storedPlanRef ?? (materialized.materialized > 0 ? planned.seedPlanRef : undefined)
      if (materializedPlanRef) {
        await saveMaterializedAutoOrchPlan(this.projectDir, materializedPlanRef, materialized.plan).catch(() => undefined)
      }
      // Run workspace: fork an integration branch + private tree so MAIN is
      // never written while the graph runs. null → non-git workspace, fall back
      // to the legacy on-main path.
      workspace = await this.setupRunWorkspace()
      let nodeRunner = this.nodeRunner
      if (workspace) {
        // Isolated writers must fork from / merge into the RUN branch.
        this.worktreeBinding?.(workspace.coordinator)
        nodeRunner = new KernelNodeRunner(this.dispatcher, {
          getGoal: this.getGoal,
          ...this.nodeRunnerOptions,
          projectDir: workspace.root,
          codeArtifactRoot: this.projectDir,
          worktrees: workspace.coordinator,
          runTree: workspace,
        })
      }
      const blackboard = new Blackboard()
      const runner = new PlanRunner(materialized.plan, nodeRunner, { blackboard, observer: this.observer })
      let run = await runner.run(signal)
      // Run-level transaction: completed → ONE squash merge of the run branch
      // into main; any other terminal outcome → discard everything (main was
      // never written, so the workspace stays clean by construction). A failed
      // final merge downgrades the run to 'failed' — "success" always means
      // "merged into main", never a stranded branch reported as done.
      if (workspace) {
        if (run.status === 'completed') {
          const fin = await workspace.finishSuccess(
            `auto_orch ${workspace.runId}: ${compactLine(this.safeGoal(), 72)}`,
          )
          if (!fin.merged) {
            run = { ...run, status: 'failed', note: joinNotes(run.note, fin.note) }
          } else if (fin.note) {
            run = { ...run, note: joinNotes(run.note, fin.note) }
          }
        } else if (run.status !== 'paused') {
          await workspace.finishDiscard().catch(() => undefined)
        }
      }
      finalRun = run
      if (storedPlanRef) {
        await appendAutoOrchPlanRun(this.projectDir, storedPlanRef, run).catch(() => undefined)
      }
      if (run.status === 'paused' && this.scheduler) {
        await this.scheduler
          .schedulePausedRun(materialized.plan, run, workspace?.descriptor(), materializedPlanRef)
          .catch(() => undefined)
      } else if (this.scheduler) {
        await this.scheduler.cancelAll(`auto_orch run ended: ${run.status}`).catch(() => undefined)
      }
      return {
        planSource: planned.source,
        run,
        planNote: planned.note,
        summary: renderSummary(planned, run, blackboard.correctiveRounds()),
      }
    } catch (err) {
      const run: PlanRunResult = {
        status: signal.aborted ? 'aborted' : 'failed',
        visitedPath: [],
        steps: [],
        costUsd: 0,
        note: err instanceof Error ? err.message : String(err),
      }
      finalRun = run
      const fallbackPlan = {
        source: planned?.source ?? 'fallback',
        note: planned?.note,
      } satisfies Pick<PlannerOutcome, 'source' | 'note'>
      return {
        planSource: fallbackPlan.source,
        run,
        planNote: fallbackPlan.note,
        summary: renderSummary(fallbackPlan, run, 0),
      }
    } finally {
      // Restore the base coordinator no matter how the run ended.
      this.worktreeBinding?.(null)
      if (finalRun?.status !== 'paused') {
        // Defensive: on exception paths the workspace may not be finished yet.
        // finishDiscard() is a no-op when it already was — including the
        // deliberate branch-preserving failed-merge path.
        await workspace?.finishDiscard().catch(() => undefined)
        // Legacy on-main path only: with a run workspace, main's state/ is
        // untouched during the run (success syncs it explicitly).
        if (!workspace && finalRun && shouldRestoreProcessFiles(finalRun.status)) {
          await processSnapshot?.restore().catch(() => undefined)
        }
        await this.cleanupWorktrees()
      }
    }
  }

  /**
   * Sweep stale run workspaces from previous crashed/killed runs (protecting
   * runs owned by live paused schedules), then fork this run's integration
   * branch. undefined → non-git workspace, caller falls back to on-main.
   */
  private async setupRunWorkspace(): Promise<AutoOrchRunWorkspace | undefined> {
    try {
      const keep = new Set<string>()
      const schedules = await listAutoOrchSchedules().catch(() => [])
      for (const s of schedules) {
        if ((s.status === 'scheduled' || s.status === 'running') && s.runWorkspace?.runId) {
          keep.add(s.runWorkspace.runId)
        }
      }
      await sweepStaleAutoOrchRuns(this.projectDir, keep).catch(() => [])
      return (await createAutoOrchRunWorkspace(this.projectDir)) ?? undefined
    } catch {
      return undefined
    }
  }

  private safeGoal(): string {
    try {
      return this.getGoal()?.trim() || '继续推进当前目标。'
    } catch {
      return '继续推进当前目标。'
    }
  }

  private async cleanupWorktrees(): Promise<void> {
    if (!this.worktreeCleanup) return
    await this.worktreeCleanup.coordinator
      .cleanup(this.worktreeCleanup.strategy)
      .catch(() => undefined)
  }
}

/**
 * Build the auto_orch LAUNCH phase hook (B): a `pre_query` hook that, on the
 * FIRST turn only, runs the whole orchestration and aborts the shell executor,
 * surfacing the orchestration summary as the result text (via the abort note).
 *
 * This is how auto_orch boots end-to-end without a bespoke submit() path: the
 * mode's main session is a thin shell whose first query never happens — the
 * controller does the real work through sub-agents. Idempotent (runs once); a
 * resumed/second turn is a no-op `continue`.
 */
export function buildAutoOrchLaunchHooks(controller: AutoOrchController): PhaseHookFn {
  const registry = new HookRegistry()
  let launched = false
  registry.register({
    id: 'auto_orch-launch',
    point: 'pre_query',
    role: 'orchestrator',
    handler: async ({ event }) => {
      if (launched) return continueVerdict('orchestration already launched')
      launched = true
      const result = await controller.run(event.signal)
      // Abort the shell loop; the note becomes the session result text. A run
      // that did NOT complete (failed / invalid / bounds_exceeded /
      // review_unavailable / aborted) is flagged failed:true so the kernel maps
      // it to an error subtype instead of a deceptive success — the abort itself
      // is still how we stop the shell loop, but it carries the real outcome.
      const failed = result.run.status !== 'completed' && result.run.status !== 'paused'
      return { action: 'abort', note: result.summary, data: failed ? { failed: true } : undefined }
    },
  })
  return registry.toPhaseHookFn()
}

/** Build the controller from a dispatcher + goal accessor (router-facing helper). */
export function makeAutoOrchController(
  dispatcher: ISubAgentDispatcher,
  projectDir: string,
  getGoal: () => string | null,
  nodeRunnerOptions?: KernelNodeRunnerOptions,
): AutoOrchController {
  return new AutoOrchController({ dispatcher, projectDir, getGoal, nodeRunnerOptions })
}

function renderSummary(
  planned: Pick<PlannerOutcome, 'source' | 'note'>,
  run: PlanRunResult,
  correctiveRounds: number,
): string {
  const lines: string[] = []
  const sourceZh = planned.source === 'planner'
    ? '计划'
    : planned.source === 'saved'
      ? '已保存计划'
      : '回退（单执行器）'
  lines.push(
    `[auto_orch] 编排${sourceZh}执行${statusZh(run.status)}。`,
  )
  if (planned.source === 'fallback' && planned.note) lines.push(`规划回退原因：${planned.note}`)
  if (run.visitedPath.length) lines.push(`执行路径：${run.visitedPath.join(' → ')}`)
  if (correctiveRounds > 0) lines.push(`审查纠偏轮数：${correctiveRounds}`)
  lines.push(`累计成本：约 $${run.costUsd.toFixed(3)}`)
  if (run.note) lines.push(`说明：${run.note}`)
  return lines.join('\n')
}

function statusZh(status: PlanRunResult['status']): string {
  switch (status) {
    case 'completed':
      return '完成'
    case 'paused':
      return '已暂停，等待外部事件恢复'
    case 'aborted':
      return '被中断'
    case 'bounds_exceeded':
      return '触达硬上限后停止'
    case 'invalid':
      return '因计划非法未执行'
    case 'review_unavailable':
      return '因审查不可用而未通过（fail-closed）'
    case 'failed':
      return '因内部错误中止'
    default:
      return ''
  }
}

function shouldRestoreProcessFiles(status: PlanRunResult['status']): boolean {
  return status !== 'completed' && status !== 'paused'
}

function joinNotes(...notes: Array<string | undefined>): string | undefined {
  const parts = notes.filter((n): n is string => !!n && n.trim().length > 0)
  return parts.length ? parts.join('；') : undefined
}

function compactLine(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars)}…` : oneLine
}

interface ProcessRootSnapshot {
  relRoot: string
  existed: boolean
  dirs: string[]
  files: Array<{ relPath: string; data: Buffer }>
}

async function captureProcessFileSnapshot(projectDir: string): Promise<{ restore: () => Promise<void> }> {
  const root = resolve(projectDir)
  const snapshots: ProcessRootSnapshot[] = []
  for (const relRoot of PROCESS_FILE_ROOTS) {
    const absRoot = resolve(root, relRoot)
    const rel = relative(root, absRoot)
    if (rel.startsWith('..') || rel === '' || rel.startsWith('/')) continue
    snapshots.push(await snapshotRoot(absRoot, relRoot))
  }
  return {
    async restore(): Promise<void> {
      for (const snapshot of snapshots) {
        await restoreRoot(root, snapshot)
      }
    },
  }
}

async function snapshotRoot(absRoot: string, relRoot: string): Promise<ProcessRootSnapshot> {
  const snapshot: ProcessRootSnapshot = { relRoot, existed: true, dirs: [], files: [] }
  try {
    await walkSnapshot(absRoot, absRoot, snapshot)
  } catch {
    snapshot.existed = false
    snapshot.dirs = []
    snapshot.files = []
  }
  return snapshot
}

async function walkSnapshot(absRoot: string, current: string, snapshot: ProcessRootSnapshot): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    const abs = join(current, entry.name)
    const relPath = relative(absRoot, abs)
    if (entry.isDirectory()) {
      snapshot.dirs.push(relPath)
      await walkSnapshot(absRoot, abs, snapshot)
    } else if (entry.isFile()) {
      snapshot.files.push({ relPath, data: await readFile(abs) })
    }
  }
}

async function restoreRoot(projectDir: string, snapshot: ProcessRootSnapshot): Promise<void> {
  const absRoot = join(projectDir, snapshot.relRoot)
  await rm(absRoot, { recursive: true, force: true })
  if (!snapshot.existed) return
  await mkdir(absRoot, { recursive: true })
  for (const relDir of snapshot.dirs) {
    await mkdir(join(absRoot, relDir), { recursive: true })
  }
  for (const file of snapshot.files) {
    const abs = join(absRoot, file.relPath)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, file.data)
  }
}

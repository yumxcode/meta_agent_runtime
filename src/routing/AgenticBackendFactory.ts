/**
 * AgenticBackendFactory — assembles the AGENTIC / AUTO session backend.
 *
 * Extracted from SessionRouter so the Router's job stays "decide the mode and
 * proxy lifecycle", not "wire verify/drift gates, checkpoint coordinator,
 * sub-agent bridge, worktree isolation, and the auto experience store". All of
 * that backend construction lives here behind a single `createAgenticBackend()`
 * call.
 *
 * AGENTIC vs AUTO: identical loop + research/delegation wiring. AUTO additionally
 * supplies an `autonomy` profile, which turns on the verify gate, drift gate,
 * experience store, durable checkpoint coordinator, and the workspace jail. The
 * `overrides.autonomy` presence is the single switch for all of that here.
 *
 * SIMPLE_AUTO: a lightweight unattended flavour for simple, short tasks. It keeps
 * the workspace jail (it still carries an `autonomy` profile) but DROPS the
 * verify gate, drift gate, experience store, and durable checkpoint coordinator.
 * `wantsGates` (= isAuto && !isSimpleAuto) is the single switch that separates the
 * two: when false, those gate hooks are left undefined and the kernel loop no-ops
 * each one. The result is auto's autonomy/jail with none of the self-supervision.
 *
 * Lazy gate dispatcher: the verify/drift gates are constructed BEFORE the
 * SubAgentBridge (the bridge needs the session id, which needs the session). The
 * gates therefore talk to the bridge through a tiny facade that reads a local
 * `bridgeRef` set immediately after the bridge is created — so a gate invoked
 * many turns later always sees the live bridge.
 */
import { MetaAgentSession } from '../core/MetaAgentSession.js'
import type { MetaAgentConfig } from '../core/config.js'
import type { AutonomyProfile } from '../core/types.js'
import type { AgentMode } from '../core/dynamicPrompt.js'
import { readAutoCheckpoint } from '../core/auto/AutoCheckpointStore.js'
import { AutoCheckpointCoordinator } from '../core/auto/AutoCheckpointCoordinator.js'
import { FlashClient } from '../core/flash/FlashClient.js'
import {
  AutoOrchController,
  buildAutoOrchLaunchHooks,
  defaultRoleCatalog,
} from '../core/auto-orch/index.js'
import {
  createAutoExperienceStore,
  renderRecentExperiences,
  createAutoExperienceWriteTool,
} from '../core/auto/learn/AutoExperienceStore.js'
import { getTodosForSession } from '../tools/ui/todo_write/index.js'
import { getProgressNoteForSession } from '../tools/ui/progress_note/index.js'
import { getArtifactsForSession } from '../tools/ui/artifacts_register/index.js'
import { AutoWorktreeCoordinator } from '../core/auto/AutoWorktreeCoordinator.js'
import { SubAgentBridge } from '../subagent/SubAgentBridge.js'
import { makeAutoWorktreeTools } from '../subagent/tools/auto_worktree.js'
import { makeSubAgentTools } from '../subagent/tools/index.js'
import { createRunAgentTool } from '../tools/agent/run_agent/index.js'
import { createResearchDispatchTool } from '../tools/research/research_dispatch/index.js'
import { createWebFetchTool } from '../tools/network/web_fetch/index.js'

export interface AgenticBackendInput {
  /** Resolved config in MetaAgentSession shape (from Router._cfgAsConfig()). */
  baseConfig: MetaAgentConfig
  /** Workspace root the session operates in. */
  projectDir: string
  /** Resume an existing session id, when provided. */
  resumeSessionId?: string
  /** Whether the user explicitly resumed — gates auto-checkpoint restore. */
  explicitResume: boolean
  /** AGENTIC when undefined; AUTO when autonomy is present. */
  overrides?: { autonomy?: AutonomyProfile; promptMode?: AgentMode }
  /**
   * Live accessor for the session goal (AUTO). Read lazily by the gates and the
   * checkpoint snapshot, since the goal is captured on the first submit — after
   * this backend is built.
   */
  getGoal: () => string | null
}

export interface AgenticBackend {
  session: MetaAgentSession
  bridge: SubAgentBridge
  /** Non-null only in AUTO mode. The Router holds it for durable checkpointing. */
  checkpointCoordinator: AutoCheckpointCoordinator | null
  /** Non-null only in AUTO-ORCH mode. The end-to-end orchestration driver. */
  orchController: AutoOrchController | null
}

/**
 * Build a MetaAgentSession plus its sub-agent / research / (auto) safety wiring.
 * Pure factory: it mutates nothing on the caller — the caller stores the
 * returned `bridge` / `checkpointCoordinator` refs it needs.
 */
export async function createAgenticBackend(input: AgenticBackendInput): Promise<AgenticBackend> {
  const { baseConfig, projectDir, resumeSessionId, explicitResume, overrides, getGoal } = input
  const isAuto = overrides?.autonomy !== undefined
  // auto-orch shares auto's autonomy jail (isAuto stays true) and ADDS the
  // orchestration layer. Detected via the prompt mode the router passed.
  const isAutoOrch = overrides?.promptMode === 'auto-orch'
  // simple_auto shares auto's autonomy jail (isAuto stays true) but deliberately
  // DROPS the heavyweight self-supervision machinery: no durable checkpoints, no
  // drift gate, no completion-verify gate, and no auto experience store. It is
  // the lightweight unattended mode for simple, short tasks. `wantsGates` is the
  // single switch that turns all of that on for plain auto / auto-orch but off
  // for simple_auto.
  const isSimpleAuto = overrides?.promptMode === 'simple_auto'
  const wantsGates = isAuto && !isSimpleAuto

  const resumeCheckpoint = wantsGates && explicitResume ? readAutoCheckpoint(projectDir) : null

  // Lazy dispatcher facade — the bridge is created after the session below, so
  // the gates read this local ref at invocation time (deep in a later turn).
  let bridgeRef: SubAgentBridge | null = null
  const lazyDispatcher = {
    spawnSubAgent: (o: Parameters<SubAgentBridge['spawnSubAgent']>[0]) => bridgeRef!.spawnSubAgent(o),
    getStatus: (id: Parameters<SubAgentBridge['getStatus']>[0]) => bridgeRef!.getStatus(id),
    cancelTask: (id: Parameters<SubAgentBridge['cancelTask']>[0], r?: string) => bridgeRef!.cancelTask(id, r),
  }

  // Role catalogue: the single source of truth for review roles. drift/verify
  // are now obtained THROUGH it (it delegates to the same makers), so the kernel
  // gates and the auto-orch graph nodes share one role definition surface.
  const roleCatalog = defaultRoleCatalog()
  const roleCtx = { dispatcher: lazyDispatcher, projectDir, getGoal }
  const verifyGate = wantsGates ? roleCatalog.buildVerifyGate(roleCtx) : undefined

  // Auto Learn: one experience store powers both recall (main prompt) and the
  // drift agent's writes. Skipped for simple_auto (no drift gate to write).
  const autoExperienceStore = wantsGates ? createAutoExperienceStore(projectDir) : null
  const driftGate = wantsGates ? roleCatalog.buildDriftGate(roleCtx) : undefined
  const getExperienceRecallBlock = autoExperienceStore
    ? () => renderRecentExperiences(autoExperienceStore)
    : undefined

  // AUTO-ORCH: the end-to-end orchestration driver (Planner → PlanRunner →
  // KernelNodeRunner), plus the launch phase hook (B) that boots it on the first
  // pre_query and surfaces its summary as the result. Both read the same lazy
  // dispatcher facade. phaseHooks stays undefined for every other mode, so the
  // kernel makes zero extra calls (zero regression).
  // Git-worktree isolation coordinator — created early so auto-orch parallel
  // writers can merge through it; the bridge wiring/reconcile happens below.
  const worktrees = new AutoWorktreeCoordinator(projectDir)

  const orchController = isAutoOrch
    ? new AutoOrchController({
        dispatcher: lazyDispatcher,
        projectDir,
        getGoal,
        // Graph 'role' nodes resolve through the SAME catalogue the kernel gates
        // came from — verify/drift/reviewer are defined once. Parallel writers
        // merge via the shared worktree coordinator.
        nodeRunnerOptions: { roleCatalog, worktrees },
      })
    : null
  const phaseHooks = orchController ? buildAutoOrchLaunchHooks(orchController) : undefined

  // Edit-digest summarizer (auto only): one cheap flash side-call, fired by the
  // checkpoint coordinator at most once per N FS-only checkpoints, to recap a
  // long code-editing stretch when the agent never wrote a todo/progress update.
  const editDigestFlash = wantsGates ? new FlashClient(baseConfig) : null
  const summarizeEdits = editDigestFlash
    ? async (paths: string[]): Promise<string | null> =>
        editDigestFlash.query({
          system:
            '你是一个代码改动摘要器。根据最近被修改的文件路径列表，用一句话（≤60字）概括这段时间大致在做什么改动。' +
            '只输出这一句话，不要解释、不要列表。',
          user: `最近修改的文件（去重）:\n${paths.slice(0, 40).join('\n')}`,
          maxTokens: 120,
          // Fire-and-forget (never blocks the kernel), so a generous timeout just
          // raises the digest's success rate on a slow provider.
          timeoutMs: 30_000,
        })
    : undefined

  const checkpointCoordinator = wantsGates
    ? new AutoCheckpointCoordinator({
        projectDir,
        initialRevision: resumeCheckpoint?.revision ?? 0,
        initialToolBatchCount: resumeCheckpoint?.turnCount ?? 0,
        // Carry the monotonic run-health counters across resume so trajectory
        // signals (rejections / corrections / compactions) are not lost.
        initialRunHealth: resumeCheckpoint
          ? {
              verifyRejections: resumeCheckpoint.verifyRejections,
              driftCorrections: resumeCheckpoint.driftCorrections,
              compactions: resumeCheckpoint.compactions,
              lastVerifyRejectTurn: resumeCheckpoint.lastVerifyRejectTurn,
              lastDriftCorrectionTurn: resumeCheckpoint.lastDriftCorrectionTurn,
            }
          : undefined,
        summarizeEdits,
        getSnapshot: sessionId => {
          const allTodos = getTodosForSession(sessionId)
          return {
            goal: getGoal() ?? undefined,
            completedSteps: allTodos
              .filter(todo => todo.status === 'completed')
              .map(todo => todo.content),
            pendingTodos: allTodos
              .filter(todo => todo.status !== 'completed')
              .map(todo => todo.content),
            note: getProgressNoteForSession(sessionId),
            artifacts: getArtifactsForSession(sessionId) ?? [],
            activeSubAgentIds: [...new Set([
              ...(bridgeRef?.getSchedulerStats().activeTaskIds ?? []),
              ...(bridgeRef?.getWorktreeCoordinator()?.activeTasks() ?? []),
            ])],
          }
        },
      })
    : null

  const session = new MetaAgentSession({
    ...baseConfig,
    sessionId: resumeSessionId,
    promptMode: overrides?.promptMode,
    autonomy: overrides?.autonomy,
    verifyGate,
    driftGate,
    phaseHooks,
    getExperienceRecallBlock,
    onCheckpointBoundary: checkpointCoordinator
      ? event => checkpointCoordinator.flush(event)
      : undefined,
    initialToolBatchCount: resumeCheckpoint?.turnCount ?? 0,
    initialCheckpointRevision: resumeCheckpoint?.revision ?? 0,
  })

  // Auto mode: conservative scheduler defaults (lower concurrency + a non-null
  // total budget) as unattended safety/cost guards (env still overrides).
  const bridge = new SubAgentBridge(
    session.getSessionId(),
    isAuto ? { conservativeAutoDefaults: true } : undefined,
  )
  bridgeRef = bridge
  bridge.setToolRegistry(session.getToolRegistry())

  // Auto mode only: extend the workspace jail to every spawned sub-agent
  // (sandbox fail-closed + autonomy passthrough + projectDir bound to the jail
  // root). The jail is auto-specific safety; worktree isolation below is shared.
  if (isAuto) {
    bridge.setAutonomyJail({ workspaceRoot: projectDir, autonomy: overrides!.autonomy! })
  }

  // Git-worktree isolation for isolated_write sub-agents — armed for BOTH
  // agentic and auto so concurrent WRITE tasks each run on their own branch.
  // (Coordinator instance hoisted above so the orchestration controller shares it.)
  if (worktrees.enabled) {
    await worktrees.reconcile()
    bridge.setWorktreeCoordinator(worktrees)
    for (const tool of makeAutoWorktreeTools(bridge)) session.registerTool(tool)
  }

  // Sub-agents read full texts in their discarded-after-run context — override
  // the main agent's budgeted web_fetch with the full variant. In auto mode also
  // expose experience_write to SUB-AGENTS ONLY (the drift agent uses it).
  bridge.setSubAgentToolOverrides([
    await createWebFetchTool(),
    ...(autoExperienceStore
      ? [createAutoExperienceWriteTool(autoExperienceStore, session.getSessionId())]
      : []),
  ])

  session.registerTool(createResearchDispatchTool({
    dispatcher: bridge,
    projectDir,
    sessionId: session.getSessionId(),
  }))
  // Delegation tool surface (agentic + auto): run_agent (sync) + spawn_sub_agent
  // (async) + status/cancel/list controls.
  session.registerTool(await createRunAgentTool(bridge))
  for (const tool of makeSubAgentTools(bridge)) session.registerTool(tool)
  // Completion/failure notifications flow into the volatile prefix.
  session.setSubAgentBridge(bridge)

  return { session, bridge, checkpointCoordinator, orchController }
}

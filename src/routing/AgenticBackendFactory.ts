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
 * supplies an `autonomy` profile, which turns on the workspace jail. Plain AUTO
 * also wires the verify gate, drift gate, experience store, and durable
 * checkpoint coordinator.
 *
 * SIMPLE_AUTO / AUTO_ORCH: lightweight unattended flavours. They keep the
 * workspace jail (they still carry an `autonomy` profile) but DROP the implicit
 * verify gate, drift gate, experience store, and durable checkpoint coordinator.
 * AUTO_ORCH adds an explicit plan graph on top; verify/drift are expressed by
 * graph role nodes, not by hidden per-node or outer-loop gates.
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
import { AutoCostLedger } from '../core/auto/AutoCostLedger.js'
import { FlashClient } from '../core/flash/FlashClient.js'
import { defaultRoleCatalog } from '../core/roles/index.js'
import {
  createAutoExperienceStore,
  renderRecentExperiences,
  createAutoExperienceWriteTool,
} from '../core/auto/learn/AutoExperienceStore.js'
import { getTodosForSession } from '../tools/ui/todo_write/index.js'
import { getProgressNoteForSession } from '../tools/ui/progress_note/index.js'
import { getArtifactsForSession } from '../tools/ui/artifacts_register/index.js'
import {
  AutoWorktreeCoordinator,
  type AutoWorktreeCleanupStrategy,
} from '../core/auto/AutoWorktreeCoordinator.js'
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
  /** Shared main/sub-agent cost ledger for unattended modes with a finite cap. */
  costLedger: AutoCostLedger | null
}

/**
 * Build a MetaAgentSession plus its sub-agent / research / (auto) safety wiring.
 * Pure factory: it mutates nothing on the caller — the caller stores the
 * returned `bridge` / `checkpointCoordinator` refs it needs.
 */
export async function createAgenticBackend(input: AgenticBackendInput): Promise<AgenticBackend> {
  const { baseConfig, projectDir, resumeSessionId, explicitResume, overrides, getGoal } = input
  const hasAutonomyJail = overrides?.autonomy !== undefined
  // Only plain auto wires the heavyweight self-supervision machinery. simple_auto
  // deliberately runs on the lightweight execution base: no durable checkpoints,
  // no drift gate, no completion-verify gate, and no auto experience store. The
  // kernel loop no-ops those mechanisms whenever the hooks are absent.
  const wantsGates = hasAutonomyJail && overrides?.promptMode === 'auto'
  const worktreeCleanupStrategy =
    baseConfig.autoWorktreeCleanup ?? defaultWorktreeCleanupStrategy(overrides?.promptMode)

  const resumeCheckpoint = wantsGates && explicitResume && resumeSessionId
    ? readAutoCheckpoint(projectDir, resumeSessionId)
    : null
  const autoBudgetUsd = baseConfig.maxBudgetUsd
  const costLedger = hasAutonomyJail && typeof autoBudgetUsd === 'number' && Number.isFinite(autoBudgetUsd)
    ? new AutoCostLedger(autoBudgetUsd)
    : null

  // Lazy dispatcher facade — the bridge is created after the session below, so
  // the gates read this local ref at invocation time (deep in a later turn).
  let bridgeRef: SubAgentBridge | null = null
  const lazyDispatcher = {
    spawnSubAgent: (o: Parameters<SubAgentBridge['spawnSubAgent']>[0]) => bridgeRef!.spawnSubAgent(o),
    getStatus: (id: Parameters<SubAgentBridge['getStatus']>[0]) => bridgeRef!.getStatus(id),
    cancelTask: (id: Parameters<SubAgentBridge['cancelTask']>[0], r?: string) => bridgeRef!.cancelTask(id, r),
  }

  // Role catalogue: the single source of truth for review roles. drift/verify
  // are obtained through it so every auto caller uses one role definition.
  const roleCatalog = defaultRoleCatalog()
  let sessionIdForRoles = resumeSessionId
  const roleCtx = { dispatcher: lazyDispatcher, projectDir, getGoal, getSessionId: () => sessionIdForRoles }
  const verifyGate = wantsGates ? roleCatalog.buildVerifyGate(roleCtx) : undefined

  // Auto Learn: one experience store powers both recall (main prompt) and the
  // drift agent's writes. Skipped for lightweight autonomous modes (no implicit
  // drift gate to write).
  const autoExperienceStore = wantsGates ? createAutoExperienceStore(projectDir) : null
  const driftGate = wantsGates ? roleCatalog.buildDriftGate(roleCtx) : undefined
  const getExperienceRecallBlock = autoExperienceStore
    ? () => renderRecentExperiences(autoExperienceStore)
    : undefined

  // Git-worktree isolation coordinator for isolated_write sub-agents (agentic +
  // auto): concurrent WRITE tasks each run on their own branch; the bridge
  // wiring/reconcile happens below.
  const worktrees = new AutoWorktreeCoordinator(projectDir)

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
    ...(costLedger ? {
      onMainCostUsd: (costUsd: number) => costLedger.recordMainCost(costUsd),
      getAdditionalBudgetUsd: () => costLedger.getAdditionalBudgetUsd(),
    } : {}),
    sessionId: resumeSessionId,
    promptMode: overrides?.promptMode,
    autonomy: overrides?.autonomy,
    verifyGate,
    driftGate,
    getExperienceRecallBlock,
    onCheckpointBoundary: checkpointCoordinator
      ? event => checkpointCoordinator.flush(event)
      : undefined,
    initialToolBatchCount: resumeCheckpoint?.turnCount ?? 0,
    initialCheckpointRevision: resumeCheckpoint?.revision ?? 0,
  })
  sessionIdForRoles = session.getSessionId()

  // Auto mode: conservative scheduler defaults (lower concurrency + a non-null
  // total budget) as unattended safety/cost guards (env still overrides).
  const bridge = new SubAgentBridge(
    session.getSessionId(),
    hasAutonomyJail
      ? { conservativeAutoDefaults: true, ...(costLedger ? { costLedger } : {}) }
      : undefined,
  )
  bridgeRef = bridge
  bridge.setToolRegistry(session.getToolRegistry())

  // Auto mode only: extend the workspace jail to every spawned sub-agent
  // (sandbox fail-closed + autonomy passthrough + projectDir bound to the jail
  // root). The jail is auto-specific safety; worktree isolation below is shared.
  if (hasAutonomyJail) {
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

  const disposeSession = session.dispose.bind(session)
  session.dispose = async () => {
    await disposeSession()
    if (worktrees.enabled && worktreeCleanupStrategy !== 'preserve') {
      await worktrees.cleanup(worktreeCleanupStrategy).catch(() => undefined)
    }
  }

  return { session, bridge, checkpointCoordinator, costLedger }
}

function defaultWorktreeCleanupStrategy(mode: AgentMode | undefined): AutoWorktreeCleanupStrategy {
  switch (mode) {
    case 'simple_auto':
      return 'safe'
    case 'auto':
    default:
      return 'preserve'
  }
}

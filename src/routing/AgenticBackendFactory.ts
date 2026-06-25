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
import { makeAutoVerifyGate } from '../core/auto/verify/VerifyJudge.js'
import { makeAutoDriftGate } from '../core/auto/learn/DriftAgent.js'
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
}

/**
 * Build a MetaAgentSession plus its sub-agent / research / (auto) safety wiring.
 * Pure factory: it mutates nothing on the caller — the caller stores the
 * returned `bridge` / `checkpointCoordinator` refs it needs.
 */
export async function createAgenticBackend(input: AgenticBackendInput): Promise<AgenticBackend> {
  const { baseConfig, projectDir, resumeSessionId, explicitResume, overrides, getGoal } = input
  const isAuto = overrides?.autonomy !== undefined

  const resumeCheckpoint = isAuto && explicitResume ? readAutoCheckpoint(projectDir) : null

  // Lazy dispatcher facade — the bridge is created after the session below, so
  // the gates read this local ref at invocation time (deep in a later turn).
  let bridgeRef: SubAgentBridge | null = null
  const lazyDispatcher = {
    spawnSubAgent: (o: Parameters<SubAgentBridge['spawnSubAgent']>[0]) => bridgeRef!.spawnSubAgent(o),
    getStatus: (id: Parameters<SubAgentBridge['getStatus']>[0]) => bridgeRef!.getStatus(id),
    cancelTask: (id: Parameters<SubAgentBridge['cancelTask']>[0], r?: string) => bridgeRef!.cancelTask(id, r),
  }

  const verifyGate = isAuto
    ? makeAutoVerifyGate({ dispatcher: lazyDispatcher, projectDir, getGoal })
    : undefined

  // Auto Learn: one experience store powers both recall (main prompt) and the
  // drift agent's writes.
  const autoExperienceStore = isAuto ? createAutoExperienceStore(projectDir) : null
  const driftGate = isAuto
    ? makeAutoDriftGate({ dispatcher: lazyDispatcher, projectDir, getGoal })
    : undefined
  const getExperienceRecallBlock = autoExperienceStore
    ? () => renderRecentExperiences(autoExperienceStore)
    : undefined

  const checkpointCoordinator = isAuto
    ? new AutoCheckpointCoordinator({
        projectDir,
        initialRevision: resumeCheckpoint?.revision ?? 0,
        initialToolBatchCount: resumeCheckpoint?.turnCount ?? 0,
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
  const worktrees = new AutoWorktreeCoordinator(projectDir)
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

  return { session, bridge, checkpointCoordinator }
}

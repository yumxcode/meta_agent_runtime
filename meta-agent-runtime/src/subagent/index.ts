/**
 * Sub-Agent Task System — public API
 *
 * Sub-agents are isolated MetaAgentSession instances spawned by the main agent
 * to handle long-running or specialised sub-tasks.
 *
 * Quick start:
 *
 *   import { SubAgentBridge, makeSubAgentTools } from './subagent/index.js'
 *
 *   // Create one bridge per main-agent session
 *   const bridge = new SubAgentBridge(mainSession.getSessionId())
 *
 *   // Register sub-agent tools with the main session
 *   const tools = makeSubAgentTools(bridge)
 *   tools.forEach(t => mainSession.registerTool(t))
 *
 *   // Clean up when the main session ends
 *   mainSession.on('end', () => bridge.destroy())
 *
 * The main agent can then call:
 *   spawn_sub_agent       — delegate a sub-task
 *   get_sub_agent_status  — query final status
 *   get_sub_agent_intermediate — query checkpoint
 *   cancel_sub_agent      — abort a running sub-agent
 *   list_sub_agents       — list all tasks this session
 *
 * See meta-agent-architecture.md §9 for full design documentation.
 */

// ── Core types ─────────────────────────────────────────────────────────────
export type {
  SubAgentTaskId,
  SubAgentStatus,
  SubAgentConfig,
  SubAgentResult,
  SubAgentProgressState,
  SubAgentRecord,
  CampaignEventMap,
  SubAgentCompletedEvent,
  SubAgentFailedEvent,
  SubAgentCheckpointEvent,
  PhaseTransitionedEvent,
} from './types.js'
export {
  makeSubAgentTaskId,
  DEFAULT_SUB_AGENT_CONFIG,
  TERMINAL_STATUSES,
} from './types.js'

// ── Event bus ──────────────────────────────────────────────────────────────
export { CampaignEventBus } from './CampaignEventBus.js'

// ── Storage ────────────────────────────────────────────────────────────────
export {
  readTask,
  writeTask,
  cleanupTask,
  listTasksForSession,
} from './SubAgentTaskStore.js'

// ── Runner ─────────────────────────────────────────────────────────────────
export { SubAgentRunner } from './SubAgentRunner.js'

// ── Bridge ─────────────────────────────────────────────────────────────────
export {
  SubAgentBridge,
  buildSubAgentNotificationSection,
  type SpawnSubAgentOptions,
} from './SubAgentBridge.js'

// ── Tools ──────────────────────────────────────────────────────────────────
export {
  makeSubAgentTools,
  makeSpawnSubAgentTool,
  makeGetSubAgentStatusTool,
  makeGetSubAgentIntermediateTool,
  makeCancelSubAgentTool,
  makeListSubAgentsTool,
} from './tools/index.js'

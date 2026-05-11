/**
 * Coordination layer — public barrel.
 *
 * Exports everything needed by consumers of the coordination system:
 *   - Campaign state machine (CampaignStateStore)
 *   - Non-blocking background watcher (CampaignMonitor)
 *   - Session context injection (MetaAgentContextStore)
 *   - Deterministic capsule builder (CapsuleBuilder)
 *   - Multi-objective Pareto analyser (ParetoAnalyzer)
 *   - DOE sampling strategies (DOESampler)
 *   - Multi-fidelity escalation logic (FidelityLadder)
 *   - Parallel evaluation dispatcher (WorkerCoordinator)
 *   - All coordination types
 */

// ── Types ─────────────────────────────────────────────────────────────────────
export type {
  DesignVariable,
  Objective,
  Constraint,
  DesignSpace,
  DesignPoint,
  FidelityLevel,
  EvaluationResult,
  ParetoFront,
  WorkerTask,
  CampaignPhase,
  PersistedCampaignState,
  CampaignContextCapsule,
  MetaAgentSessionContext,
  CampaignSummary,
} from './types.js'

export {
  VALID_TRANSITIONS,
  PHASE_LABELS,
  MACHINE_PHASES,
  USER_CHECKPOINT_PHASES,
} from './types.js'

// ── Core classes ──────────────────────────────────────────────────────────────
export { CampaignStateStore } from './CampaignStateStore.js'
export { CampaignMonitor } from './CampaignMonitor.js'
export type { NotifyFn, WatchOptions } from './CampaignMonitor.js'

// ── Context injection ─────────────────────────────────────────────────────────
export {
  MetaAgentContextStore,
  SESSION_DIR,
  ACTIVE_CONTEXT_FILE,
} from './MetaAgentContextStore.js'

// ── Deterministic algorithms ──────────────────────────────────────────────────
export { buildCapsule } from './CapsuleBuilder.js'
export { ParetoAnalyzer } from './ParetoAnalyzer.js'

// ── Phase 4: DOE sampling + fidelity ladder + parallel evaluation ─────────────
export { DOESampler, makeDesignPoint } from './DOESampler.js'
export { FidelityLadder, DEFAULT_FIDELITY_LADDER } from './FidelityLadder.js'
export type { FidelityLadderConfig } from './FidelityLadder.js'
export { WorkerCoordinator } from './WorkerCoordinator.js'
export type { EvaluationHandler, WorkerCoordinatorOptions } from './WorkerCoordinator.js'

/**
 * Campaign — unified public barrel.
 *
 * This module is the single entry point for ALL campaign-related functionality:
 *
 *   ① Campaign Plugin Framework  (registry, generic store, plugin interface)
 *      src/campaign/types.ts  — PhaseDefinition, ICampaignStore, CampaignPlugin
 *      src/campaign/registry.ts — CampaignPluginRegistry singleton
 *      src/campaign/store.ts  — GenericCampaignStore (non-DOE campaigns)
 *
 *   ② DOE Coordination Layer  (re-exported from src/coordination/)
 *      CampaignStateStore, CampaignMonitor, MetaAgentContextStore,
 *      CapsuleBuilder, ParetoAnalyzer, DOESampler, FidelityLadder,
 *      WorkerCoordinator — see coordination/index.ts for full list.
 *
 * Consumers should import exclusively from this barrel.
 * src/coordination/ is an internal implementation detail; prefer this path.
 */
export type { PhaseDefinition, ICampaignStore, GenericPersistedState, CampaignPlugin, AnyPlugin, } from './types.js';
export { GENERIC_SCHEMA_VERSION } from './types.js';
export { campaignRegistry } from './registry.js';
export { GenericCampaignStore, listGenericCampaigns, } from './store.js';
export type { GenericCampaignSummary } from './store.js';
export type { DesignVariable, Objective, Constraint, DesignSpace, DesignPoint, FidelityLevel, EvaluationResult, ParetoFront, WorkerTask, CampaignPhase, PersistedCampaignState, CampaignContextCapsule, MetaAgentSessionContext, CampaignSummary, } from '../coordination/index.js';
export { VALID_TRANSITIONS, PHASE_LABELS, MACHINE_PHASES, USER_CHECKPOINT_PHASES, } from '../coordination/index.js';
export { CampaignStateStore } from '../coordination/index.js';
export { CampaignMonitor } from '../coordination/index.js';
export type { NotifyFn, WatchOptions } from '../coordination/index.js';
export { MetaAgentContextStore, SESSION_DIR, ACTIVE_CONTEXT_FILE, } from '../coordination/index.js';
export { buildCapsule } from '../coordination/index.js';
export { ParetoAnalyzer } from '../coordination/index.js';
export { DOESampler, makeDesignPoint } from '../coordination/index.js';
export { FidelityLadder, DEFAULT_FIDELITY_LADDER } from '../coordination/index.js';
export type { FidelityLadderConfig } from '../coordination/index.js';
export { WorkerCoordinator } from '../coordination/index.js';
export type { EvaluationHandler, WorkerCoordinatorOptions } from '../coordination/index.js';
//# sourceMappingURL=index.d.ts.map
/**
 * Phase 3 coordination types.
 *
 * Covers the full lifecycle of a Design-of-Experiments campaign:
 *   Campaign (long-lived, disk-persisted) ≠ Conversation (short-lived, ephemeral)
 *
 * Key invariant: CampaignPhase is the only authoritative state. All context
 * injection (MetaAgentContextStore) and capsule generation (CapsuleBuilder)
 * are derived from it — never stored redundantly.
 */
/** Enforced by CampaignStateStore.transitionPhase() */
export const VALID_TRANSITIONS = {
    IDLE: ['SAMPLING', 'FAILED'],
    SAMPLING: ['EVALUATING_L0', 'FAILED'],
    EVALUATING_L0: ['PARETO_READY_L0', 'FAILED'],
    PARETO_READY_L0: ['ESCALATING_L1', 'REPORTING', 'DONE', 'FAILED'],
    ESCALATING_L1: ['PARETO_READY_L1', 'FAILED'],
    PARETO_READY_L1: ['ESCALATING_L2', 'REPORTING', 'DONE', 'FAILED'],
    ESCALATING_L2: ['PARETO_READY_L2', 'FAILED'],
    PARETO_READY_L2: ['REPORTING', 'DONE', 'FAILED'],
    REPORTING: ['DONE', 'FAILED'],
    DONE: [],
    FAILED: ['SAMPLING'],
};
/** Human-readable phase labels used in capsule / status lines */
export const PHASE_LABELS = {
    IDLE: 'Idle',
    SAMPLING: 'Sampling design points',
    EVALUATING_L0: 'Running L0 evaluation (background)',
    PARETO_READY_L0: 'L0 complete — Pareto front ready',
    ESCALATING_L1: 'Running L1 escalation (background)',
    PARETO_READY_L1: 'L1 complete — Pareto front updated',
    ESCALATING_L2: 'Running L2 escalation (background)',
    PARETO_READY_L2: 'L2 complete — Pareto front updated',
    REPORTING: 'Generating report',
    DONE: 'Campaign complete',
    FAILED: 'Campaign failed',
};
/** Phases that require no user action (machine runs automatically) */
export const MACHINE_PHASES = new Set([
    'SAMPLING', 'EVALUATING_L0', 'ESCALATING_L1', 'ESCALATING_L2', 'REPORTING',
]);
/** Phases where the system waits for user input before continuing */
export const USER_CHECKPOINT_PHASES = new Set([
    'PARETO_READY_L0', 'PARETO_READY_L1', 'PARETO_READY_L2',
]);
//# sourceMappingURL=types.js.map
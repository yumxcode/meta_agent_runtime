/**
 * auto-orch — public API for the AI-authored orchestration loop (C) and the
 * main-loop phase-hook middleware (B).
 *
 * Layering recap:
 *   • B (HookRegistry + predicates) generalises the two hard-coded gate slots
 *     into an open registry of role agents mounted on intra-turn phase hooks.
 *     It implements the kernel's PhaseHookFn contract.
 *   • C (LoopIR + PlanRunner) lets an AI Planner emit a data graph (with cycles)
 *     that a fixed interpreter walks under hard bounds — "the AI builds the loop"
 *     without ever executing code.
 *   • Verdict is the single type both layers consume; predicates is the closed
 *     trigger DSL that keeps composition auditable.
 */

// ── Unified verdict ────────────────────────────────────────────────────────────
export type {
  VerdictAction,
  OrchVerdict,
  DriftVerdictLike,
  VerifyVerdictLike,
} from './Verdict.js'
export {
  continueVerdict,
  skippedVerdict,
  fromDrift,
  fromVerify,
} from './Verdict.js'

// ── Trigger DSL ────────────────────────────────────────────────────────────────
export type { Predicate, LoopStateView } from './predicates.js'
export { evalPredicate, validatePredicate } from './predicates.js'

// ── B: phase-hook registry ─────────────────────────────────────────────────────
export type {
  PhaseHookContext,
  PhaseHookHandler,
  RegisteredPhaseHook,
} from './HookRegistry.js'
export { HookRegistry, validatePhaseHook } from './HookRegistry.js'

// ── C: loop IR + interpreter ───────────────────────────────────────────────────
export type {
  NodeKind,
  NodeWorkspaceMode,
  NodeHookSpec,
  OrchNode,
  EdgeCondition,
  OrchEdge,
  OrchBounds,
  OrchPlan,
} from './LoopIR.js'
export { validatePlan } from './LoopIR.js'
export type {
  PlanRunContext,
  NodeRunner,
  PlanRunStatus,
  PlanStepRecord,
  PlanRunResult,
} from './PlanRunner.js'
export { PlanRunner, DEFAULT_BOUNDS } from './PlanRunner.js'

// ── C: planner (graph authoring) ───────────────────────────────────────────────
export type { AutoOrchPlannerDeps, PlannerOutcome } from './PlannerAgent.js'
export {
  makeAutoOrchPlanner,
  parseOrchPlan,
  singleExecutorPlan,
} from './PlannerAgent.js'

// ── C: live node execution ─────────────────────────────────────────────────────
export type { KernelNodeRunnerOptions } from './KernelNodeRunner.js'
export { KernelNodeRunner, parseRoleVerdict } from './KernelNodeRunner.js'

// ── C: end-to-end controller ───────────────────────────────────────────────────
export type { AutoOrchControllerDeps, OrchestrationResult } from './AutoOrchController.js'
export {
  AutoOrchController,
  makeAutoOrchController,
  buildAutoOrchLaunchHooks,
} from './AutoOrchController.js'

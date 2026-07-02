/**
 * auto_orch — public API for the AI-authored orchestration loop (C) and the
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
  CodeNodeSpec,
  CodeNodeBounds,
  ValidatePlanOptions,
  OrchNode,
  EdgeCondition,
  OrchEdge,
  OrchBounds,
  OrchPlan,
  JoinPolicy,
  ParallelBranch,
  BranchChange,
  MergePlan,
} from './LoopIR.js'
export {
  validatePlan,
  detectUnterminableCycles,
  planMerge,
  writeScopesOverlap,
} from './LoopIR.js'
export type {
  PlanRunContext,
  NodeRunner,
  PlanRunStatus,
  PlanStepRecord,
  PlanRunResult,
} from './PlanRunner.js'
export { PlanRunner, DEFAULT_BOUNDS } from './PlanRunner.js'

// ── C: generated deterministic code nodes ─────────────────────────────────────
export type { CodeNodeArtifact } from './CodeNodeStore.js'
export {
  hashCodeSource,
  codeRefForHash,
  resolveCodeRef,
  writeCodeNodeArtifact,
  readCodeNodeSource,
} from './CodeNodeStore.js'
export type {
  AutoOrchStoredPlanRef,
  AutoOrchPlanManifest,
  AutoOrchLoadedPlan,
} from './PlanStore.js'
export {
  saveApprovedAutoOrchPlan,
  saveMaterializedAutoOrchPlan,
  appendAutoOrchPlanRun,
  loadAutoOrchPlan,
} from './PlanStore.js'
export type { CodeNodeMaterializeDeps, CodeNodeMaterializeResult } from './CodeNodeAuthor.js'
export { materializeCodeNodes, reviewCodeNodeSource } from './CodeNodeAuthor.js'
export type { CodeNodeRunnerOptions } from './CodeNodeRunner.js'
export { CodeNodeRunner } from './CodeNodeRunner.js'

// ── C: planner (graph authoring) ───────────────────────────────────────────────
export type { AutoOrchPlannerDeps, AutoOrchPlannerReviewConfig, PlannerOutcome } from './PlannerAgent.js'
export {
  makeAutoOrchPlanner,
  parseOrchPlan,
  renderPlanForReview,
  singleExecutorPlan,
} from './PlannerAgent.js'

// ── C: live node execution ─────────────────────────────────────────────────────
export type { KernelNodeRunnerOptions } from './KernelNodeRunner.js'
export { KernelNodeRunner, parseRoleVerdict } from './KernelNodeRunner.js'

// ── C: parallel node execution ──────────────────────────────────────────────────
export type {
  BranchRunResult,
  MergeOutcome,
  BranchOps,
} from './ParallelBranchRunner.js'
export { runParallelNode, branchIsWriter, DEFAULT_INTEGRATOR_ROLE } from './ParallelBranchRunner.js'
export type { KernelBranchOpsDeps } from './KernelBranchOps.js'
export { KernelBranchOps, INTEGRATOR_RUBRIC } from './KernelBranchOps.js'

// ── Role catalogue (unifies drift/verify with auto_orch roles) ──────────────────
export type {
  RoleContext,
  RoleHandler,
  RoleHandlerInput,
  RoleDefinition,
} from './RoleRegistry.js'
export { RoleCatalog, defaultRoleCatalog } from './RoleRegistry.js'
export { runReviewer, roleSystemPrompt } from './reviewer.js'

// ── C: shared channel (blackboard) ─────────────────────────────────────────────
export type { BlackboardEntry } from './Blackboard.js'
export { Blackboard } from './Blackboard.js'

// ── C: graph execution observability ──────────────────────────────────────────
export type { AutoOrchEvent, AutoOrchObserver } from './Observer.js'
export { notifyAutoOrchObserver } from './Observer.js'

// ── C: end-to-end controller ───────────────────────────────────────────────────
export type { AutoOrchControllerDeps, OrchestrationResult } from './AutoOrchController.js'
export {
  AutoOrchController,
  makeAutoOrchController,
  buildAutoOrchLaunchHooks,
} from './AutoOrchController.js'

// ── C: auto_orch-only resumable sub-agent sessions ────────────────────────────
export type {
  AutoOrchPausePayload,
  AutoOrchPauseOutput,
} from './AutoOrchPauseTool.js'
export {
  AUTO_ORCH_PAUSE_OUTPUT_KIND,
  isAutoOrchPauseOutput,
  makeAutoOrchPauseExternalTool,
} from './AutoOrchPauseTool.js'
export type {
  AutoOrchSubAgentSessionStatus,
  AutoOrchSubAgentSessionRecord,
} from './AutoOrchSubAgentSessionStore.js'
export {
  autoOrchSubAgentRecordId,
  writeAutoOrchSubAgentSession,
  readAutoOrchSubAgentSession,
  findAutoOrchSubAgentSessionByExternalRunId,
} from './AutoOrchSubAgentSessionStore.js'
export type {
  ResumeAutoOrchSubAgentInput,
  ResumeAutoOrchSubAgentResult,
} from './AutoOrchSubAgentResume.js'
export { resumeAutoOrchSubAgentSession } from './AutoOrchSubAgentResume.js'
export type {
  AutoOrchScheduleStatus,
  AutoOrchScheduledResume,
} from './AutoOrchScheduleStore.js'
export {
  makeAutoOrchScheduleId,
  writeAutoOrchSchedule,
  readAutoOrchSchedule,
  listAutoOrchSchedules,
  listDueAutoOrchSchedules,
  cancelAutoOrchSchedule,
  cancelAutoOrchSchedulesForAgentSession,
  cancelAutoOrchSchedulesForOrchestration,
} from './AutoOrchScheduleStore.js'
export type {
  AutoOrchObservation,
  AutoOrchObservationCollector,
  AutoOrchSchedulerOptions,
} from './AutoOrchScheduler.js'
export { AutoOrchScheduler } from './AutoOrchScheduler.js'

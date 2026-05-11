/**
 * @meta-agent/runtime — public API
 */

export { MetaAgentSession } from './core/MetaAgentSession.js'
export { KernelBridge } from './cc-kernel/KernelBridge.js'
export type { MetaAgentConfig, ResolvedConfig } from './core/config.js'
export type {
  MetaAgentEvent,
  MetaAgentTextEvent,
  MetaAgentToolUseEvent,
  MetaAgentToolResultEvent,
  MetaAgentResultEvent,
  MetaAgentStreamEvent,
  MetaAgentRetryEvent,
  MetaAgentTool,
  ToolCallContext,
  ToolResult,
  TokenUsage,
  EngineeringDomain,
  ConversationMessage,
} from './core/types.js'
export { EMPTY_USAGE, accumulateUsage } from './core/types.js'

// ── Async job system ──────────────────────────────────────────────────────────
export type {
  JobId, JobStatus, EngineeringJob, JobResult, JobProgress,
  JobContext, ProgressReporter, JobHandler, JobFilter,
  DimensionalRecord, JobArtifact, JobMetrics, JobCostEstimate,
} from './jobs/index.js'
export {
  makeJobId, TERMINAL_STATUSES, ACTIVE_STATUSES,
  JobStore, LocalExecutor, JobManager,
} from './jobs/index.js'
export type { Executor, ExecutorCallbacks, SubmitOptions } from './jobs/index.js'

// ── V&V (Validation & Verification) ──────────────────────────────────────────
export type {
  VVPhase, VVSeverity, VVSuggestedAction, VVResult, VVContext, VVHook,
} from './validation/index.js'
export {
  defaultAction, requiresAbort, requiresPause, failures, maxSeverity,
  VVHookChain,
  OOMChecker, BUILT_IN_OOM_DB,
  PhysicsConstraintChecker,
  DimensionChecker,
  createDefaultVVChain,
} from './validation/index.js'
export type { OOMRange, OOMReferenceDB } from './validation/index.js'

// ── Provenance tracking ───────────────────────────────────────────────────────
export type {
  ProvenanceId, ProvenanceRecord, ProvenanceInput, ProvenanceFilter,
} from './provenance/index.js'
export { makeProvenanceId, ProvenanceTracker } from './provenance/index.js'

// ── Units / dimensional system ────────────────────────────────────────────────
export type {
  BaseDimension, DimensionVector, PhysicalQuantity,
  DimensionError, DimensionSpec, ConversionResult,
} from './units/index.js'
export {
  BASE_DIMENSIONS,
  DIMENSIONLESS, DIMENSIONS,
  formatDimension, dimensionsMatch, multiplyDimensions, invertDimension, identifyDimension,
  UnitRegistry, defaultRegistry,
  DimensionalConsistencyChecker, defaultChecker,
} from './units/index.js'
export type { UnitDef } from './units/index.js'

// ── Session routing ───────────────────────────────────────────────────────────
// SessionRouter is the recommended entry point — it auto-selects between
// DIRECT (single-turn Q&A), AGENTIC (tool-use loop), and CAMPAIGN (full DOE
// coordination) based on prompt signals and environment.
export { SessionRouter, ModeDetector, MODE_WEIGHT } from './routing/index.js'
export type {
  SessionMode, SessionModeHint, DetectionConfidence,
  ModeSignal, ModeDetectionResult, RouterOptions,
} from './routing/index.js'

// ── Runtime integration (Phase 1 wiring) ──────────────────────────────────────
export { createRuntimeContext, instrumentTool } from './runtime/index.js'
export type { RuntimeContext, RuntimeContextOptions, InstrumentOptions } from './runtime/index.js'

// ── Phase 3 + 4 coordination ──────────────────────────────────────────────────
export type {
  DesignVariable, Objective, Constraint, DesignSpace,
  DesignPoint, EvaluationResult, ParetoFront,
  WorkerTask, CampaignPhase, PersistedCampaignState,
  CampaignContextCapsule, MetaAgentSessionContext, CampaignSummary,
} from './coordination/index.js'
export {
  VALID_TRANSITIONS, PHASE_LABELS, MACHINE_PHASES, USER_CHECKPOINT_PHASES,
  CampaignStateStore,
  CampaignMonitor,
  MetaAgentContextStore, SESSION_DIR, ACTIVE_CONTEXT_FILE,
  buildCapsule,
  ParetoAnalyzer,
  // Phase 4: DOE sampling + fidelity ladder + parallel evaluation
  DOESampler,
  makeDesignPoint,
  FidelityLadder,
  DEFAULT_FIDELITY_LADDER,
  WorkerCoordinator,
} from './coordination/index.js'
export type {
  NotifyFn,
  WatchOptions,
  // Phase 4 types
  FidelityLadderConfig,
  EvaluationHandler,
  WorkerCoordinatorOptions,
} from './coordination/index.js'

// ── Built-in tools ────────────────────────────────────────────────────────────
// Each tool lives in src/tools/<name>/ with a prompt.md description file.
export {
  createEchoTool,
  loadToolPrompt,
  // Provenance query tools (路径②)
  createProvenanceTools,
  createGetProvenanceTool,
  createListRecentTool,
  createFindDuplicateTool,
  createGetLineageTool,
  // Engineering tool registry
  EngineeringToolRegistry,
  defaultToolRegistry,
  FIDELITY_LABELS,
} from './tools/index.js'
export type { FidelityLevel, RegistryEntry } from './tools/index.js'

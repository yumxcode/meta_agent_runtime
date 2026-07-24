/**
 * @meta-agent/runtime — public API
 */

export { MetaAgentSession } from './core/MetaAgentSession.js'
export { CampaignSession } from './modes/CampaignSession.js'
/** @deprecated Use CampaignSession instead */
export { CampaignSession as KernelBridge } from './modes/CampaignSession.js'
export type { MetaAgentConfig, ResolvedConfig } from './core/config.js'
// Re-export ThinkingConfig so callers can write `thinkingConfig: { type: 'disabled' }`
// without reaching into the kernel subpath.
export type { ThinkingConfig } from './kernel/index.js'
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
// SessionRouter is the recommended entry point. Mode selection is explicit:
// omitting a mode uses AGENTIC; specialist modes must be selected by the caller.
export { SessionRouter, MODE_WEIGHT } from './routing/index.js'
export type {
  SessionMode, RouterOptions,
} from './routing/index.js'

// ── Runtime integration (Phase 1 wiring) ──────────────────────────────────────
export { createRuntimeContext, instrumentTool } from './runtime/index.js'
export type { RuntimeContext, RuntimeContextOptions, InstrumentOptions } from './runtime/index.js'

// ── Campaign plugin framework + DOE coordination ──────────────────────────────
// Single entry point — imports both the Campaign Plugin Framework and the
// legacy DOE coordination layer via src/campaign/index.ts.
export type {
  PhaseDefinition, ICampaignStore, GenericPersistedState,
  CampaignPlugin, AnyPlugin,
  GenericCampaignSummary,
} from './campaign/index.js'
export { GENERIC_SCHEMA_VERSION, campaignRegistry, GenericCampaignStore, listGenericCampaigns } from './campaign/index.js'

export type {
  DesignVariable, Objective, Constraint, DesignSpace,
  DesignPoint, EvaluationResult, ParetoFront,
  WorkerTask, CampaignPhase, PersistedCampaignState,
  CampaignContextCapsule, MetaAgentSessionContext, CampaignSummary,
} from './campaign/index.js'
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
} from './campaign/index.js'
export type {
  NotifyFn,
  WatchOptions,
  // Phase 4 types
  FidelityLadderConfig,
  EvaluationHandler,
  WorkerCoordinatorOptions,
} from './campaign/index.js'

// ── Sub-agent system ──────────────────────────────────────────────────────────
export type { SubAgentProgressState } from './subagent/types.js'
export type { ISubAgentDispatcher } from './subagent/ISubAgentDispatcher.js'

// ── Circuit-breaker run-state snapshot ───────────────────────────────────────
export type {
  RunStateSnapshot,
  RunStateStopReason,
} from './core/compact/runStateSnapshot.js'
export {
  saveRunStateSnapshot,
  loadRunStateSnapshot,
  cleanupRunStateSnapshot,
  getRunStateSnapshotPath,
} from './core/compact/runStateSnapshot.js'

// ── Task Contract (goal anchor for long-running tasks) ───────────────────────
export type {
  UserDecision,
  AcceptanceCriterion,
  TaskContract,
} from './core/contract/types.js'
export {
  makeContractId,
  createTaskContract,
} from './core/contract/types.js'
export { TaskContractStore } from './core/contract/TaskContractStore.js'

// ── Robotics knowledge layers ────────────────────────────────────────────────
export {
  experienceRetrievalScore,
  isExperienceId,
} from './robotics/ExperienceStore.js'
export { PhysicalAnchorStore, isPhysicalAnchorId } from './robotics/PhysicalAnchorStore.js'
export {
  PrincipleStore,
  principleRetrievalScore,
  isPrincipleId,
} from './robotics/PrincipleStore.js'
export { PrinciplePendingStore, validatePrincipleInput } from './robotics/PrinciplePendingStore.js'
export {
  PRINCIPLE_PROMOTION_SCORE_THRESHOLD,
  shouldTriggerPrinciplePromotion,
  proposePrincipleFromExperience,
} from './robotics/PrinciplePromotion.js'
export type {
  KnowledgeConfidenceTier,
  KnowledgeScope,
  PrincipleAbstractionLevel,
  PrincipleEntry,
  PrincipleSearchQuery,
  PhysicalAnchorEntry,
} from './robotics/types.js'

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

// ── Standard tools (file system, shell, network, MCP, UI, system, agent) ────
export {
  createFsTools,
  createReadFileTool, createWriteFileTool, createAppendFileTool, createEditFileTool,
  createGlobTool, createGrepTool, createNotebookEditTool,
  createShellTools, createBashTool, createPowerShellTool,
  createNetworkTools, createWebFetchTool, createWebSearchTool,
  createMcpTools, registerMcpClient, unregisterMcpClient, getRegisteredMcpServers,
  createMcpCallTool, createListMcpResourcesTool, createReadMcpResourceTool,
  createUiTools, createAutoUiTools, createAskUserTool, createTodoWriteTool, getTodosForSession, deleteTodosForSession, createSendMessageTool, createProgressNoteTool, getProgressNoteForSession, deleteProgressNoteForSession, createArtifactsRegisterTool, getArtifactsForSession, deleteArtifactsForSession,
  createSystemTools, createSleepTool,
  createCronCreateTool, createCronDeleteTool, createCronListTool,
  createEnterPlanModeTool, createExitPlanModeTool,
  createSkillTool, createConfigTool,
  listCronJobs, deleteCronJob, createCronJob, deleteJobsForSession,
  createAgentTools, createRunAgentTool,
  createStandardTools,
} from './tools/index.js'
export type {
  McpClient, NetworkToolsOptions, WebSearchToolOptions, TodoItem,
  StandardToolsOptions, SystemToolsOptions, CronJob,
} from './tools/index.js'

// ── Workflow system ───────────────────────────────────────────────────────────
export { WorkflowLoader } from './workflow/WorkflowLoader.js'
export { WorkflowParser } from './workflow/WorkflowParser.js'
export { WorkflowStateStore } from './workflow/WorkflowStateStore.js'
export { buildW1Section } from './workflow/dynamicSection.js'
export {
  createWorkflowStatusTool,
  createWorkflowCompleteGateTool,
  createWorkflowAdvanceTool,
  createWorkflowListPhasesTool,
  createWorkflowTools,
} from './workflow/tools/index.js'
export type {
  GateItem, WorkflowPhase, WorkflowDefinition, WorkflowState,
} from './workflow/types.js'

// ── Robotics mode ─────────────────────────────────────────────────────────────
export { RoboticsSession } from './robotics/RoboticsSession.js'
export type { RoboticsSessionOptions } from './robotics/RoboticsSession.js'
export { ExperienceStore } from './robotics/ExperienceStore.js'
export { HardwareProfile } from './robotics/HardwareProfile.js'
export { GitWorkspaceManager } from './infra/git/GitWorkspaceManager.js'
export type { GitWorktreeRecord, GitSyncResult } from './infra/git/GitWorkspaceManager.js'
export { RoboticsProjectStore } from './robotics/persistence/RoboticsProjectStore.js'
export {
  createRoboticsTools,
  createExperienceSearchTool,
  createExperienceWriteTool,
  createExperienceLoadTool,
  createPrincipleSearchTool,
  createPrinciplePromoteTool,
  createPrincipleLoadTool,
  createHardwareProfileReadTool,
  createHardwareProfileWriteTool,
  createExperimentDispatchTool,
  createPaperSearchTool,
  createProgressNoteTool as createRoboticsProgressNoteTool,
  createGitSyncToSubAgentTool,
  createGitMergeSubAgentTool,
  createGitDiffSubAgentTool,
  createGitDiscardSubAgentTool,
} from './robotics/tools/index.js'
export type { RoboticsToolsOptions } from './robotics/tools/index.js'
export {
  buildR1Section,
  buildR2Section,
  buildR3Section,
  buildR4Section,
  buildR5Section,
  renderR4Snapshot,
  renderR5Snapshot,
} from './robotics/dynamicSections.js'
export { makeExperienceId } from './robotics/types.js'
export type {
  RoboticsDomain,
  RoboticsAgentRole,
  ExperienceEntry,
  ExperienceOutcome,
  ExperienceSearchQuery,
  ExperimentSpec,
  ExperimentSummary,
  HardwareProfileData,
  RoboticsGitState,
  ActiveSubAgentRecord,
  RoboticsProjectState,
} from './robotics/types.js'

// ── Research (isolated literature research with disk-persisted deliverables) ──
export { createResearchDispatchTool, RESEARCH_MAX_DURATION_MS } from './tools/research/research_dispatch/index.js'
export { ResearchStore, buildResearchArtifactAnchors, researchRootDir } from './research/ResearchStore.js'
export type { ResearchIndexEntry, SaveResearchResultOptions } from './research/ResearchStore.js'

// ── Durable Graph Loop runtime ───────────────────────────────────────────────
export {
  GraphKernel,
  GraphStore,
  freezeLoopGraph,
  validateLoopGraph,
  createDefaultGraphRuntimeCatalog,
  loadGraphCapabilityPacks,
  distillLoopGraph,
  MetaAgentGraphAgentExecutor,
  GRAPH_AGENT_PROFILE,
  GRAPH_AGENT_SYSTEM_PROMPT,
  runEffectProviderConformance,
  assertEffectProviderConformance,
  buildLoopReliabilityProfile,
  diagnoseLoop,
  createGraphEvidenceScenarios,
  runGraphSoak,
  deliverGraphEvent,
  createGraphEventDelivery,
  createHmacWebhookIngress,
  createGitHubWebhookIngress,
  createGitHubRestActionsClient,
  createGitHubActionsCapabilityPack,
  createGitHubActionsResolveRunProvider,
  createGitHubActionsWatchRunProvider,
  GITHUB_ACTIONS_RESOLVE_RUN_EFFECT,
  GITHUB_ACTIONS_WATCH_RUN_EFFECT,
  runLoopCli,
  runLoopScheduler,
  type LoopGraphSpec,
  type FrozenLoopGraphSpec,
  type GraphRuntimeCatalog,
  type GraphCapabilityPackV1,
  type GraphInstanceRecord,
  type GraphTickResult,
  type GraphAgentExecutor,
  type GraphAgentExecutionRequest,
  type GraphAgentExecutionResult,
  type EffectProviderConformanceFixture,
  type EffectProviderConformanceReport,
  type LoopReliabilityProfile,
  type LoopReliabilityProfileOptions,
  type LoopDiagnosticCard,
  type GraphEvidenceScenario,
  type GraphSoakDriver,
  type GraphSoakOptions,
  type GraphSoakReport,
  type GraphExternalEventInput,
  type GraphExternalEventDeliveryResult,
  type GraphEventDeliveryOptions,
  type GraphEventDeliveryOutcome,
  type GraphEventDeliverer,
  type GraphEventWakeScheduler,
  type WebhookIngressRequest,
  type WebhookIngressResponse,
  type GitHubActionsClient,
  type GitHubRestActionsClientOptions,
  type GitHubWorkflowRun,
  type GitHubWorkflowRunQuery,
  type GitHubWorkflowRunSelection,
  type GitHubActionsCapabilityPackOptions,
  type AgentProfileSpec,
  type LaneWorkspaceContract,
  type WorkspaceWriteRule,
  type WorkspaceWriteMode,
} from './loop/index.js'

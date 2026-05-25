/**
 * @meta-agent/runtime — public API
 */
export { MetaAgentSession } from './core/MetaAgentSession.js';
export { CampaignSession } from './modes/CampaignSession.js';
/** @deprecated Use CampaignSession instead */
export { CampaignSession as KernelBridge } from './modes/CampaignSession.js';
export { EMPTY_USAGE, accumulateUsage } from './core/types.js';
export { makeJobId, TERMINAL_STATUSES, ACTIVE_STATUSES, JobStore, LocalExecutor, JobManager, } from './jobs/index.js';
export { defaultAction, requiresAbort, requiresPause, failures, maxSeverity, VVHookChain, OOMChecker, BUILT_IN_OOM_DB, PhysicsConstraintChecker, DimensionChecker, createDefaultVVChain, } from './validation/index.js';
export { makeProvenanceId, ProvenanceTracker } from './provenance/index.js';
export { BASE_DIMENSIONS, DIMENSIONLESS, DIMENSIONS, formatDimension, dimensionsMatch, multiplyDimensions, invertDimension, identifyDimension, UnitRegistry, defaultRegistry, DimensionalConsistencyChecker, defaultChecker, } from './units/index.js';
// ── Session routing ───────────────────────────────────────────────────────────
// SessionRouter is the recommended entry point — it auto-selects between
// DIRECT (single-turn Q&A), AGENTIC (tool-use loop), and CAMPAIGN (full DOE
// coordination) based on prompt signals and environment.
export { SessionRouter, ModeDetector, MODE_WEIGHT } from './routing/index.js';
// ── Runtime integration (Phase 1 wiring) ──────────────────────────────────────
export { createRuntimeContext, instrumentTool } from './runtime/index.js';
export { GENERIC_SCHEMA_VERSION, campaignRegistry, GenericCampaignStore, listGenericCampaigns } from './campaign/index.js';
export { VALID_TRANSITIONS, PHASE_LABELS, MACHINE_PHASES, USER_CHECKPOINT_PHASES, CampaignStateStore, CampaignMonitor, MetaAgentContextStore, SESSION_DIR, ACTIVE_CONTEXT_FILE, buildCapsule, ParetoAnalyzer, 
// Phase 4: DOE sampling + fidelity ladder + parallel evaluation
DOESampler, makeDesignPoint, FidelityLadder, DEFAULT_FIDELITY_LADDER, WorkerCoordinator, } from './campaign/index.js';
export { saveRunStateSnapshot, loadRunStateSnapshot, cleanupRunStateSnapshot, getRunStateSnapshotPath, } from './core/compact/runStateSnapshot.js';
export { makeContractId, createTaskContract, } from './core/contract/types.js';
export { TaskContractStore } from './core/contract/TaskContractStore.js';
// ── Built-in tools ────────────────────────────────────────────────────────────
// Each tool lives in src/tools/<name>/ with a prompt.md description file.
export { createEchoTool, loadToolPrompt, 
// Provenance query tools (路径②)
createProvenanceTools, createGetProvenanceTool, createListRecentTool, createFindDuplicateTool, createGetLineageTool, 
// Engineering tool registry
EngineeringToolRegistry, defaultToolRegistry, FIDELITY_LABELS, } from './tools/index.js';
// ── Standard tools (file system, shell, network, MCP, UI, system, agent) ────
export { createFsTools, createReadFileTool, createWriteFileTool, createEditFileTool, createGlobTool, createGrepTool, createNotebookEditTool, createShellTools, createBashTool, createPowerShellTool, createNetworkTools, createWebFetchTool, createWebSearchTool, createMcpTools, registerMcpClient, unregisterMcpClient, getRegisteredMcpServers, createMcpCallTool, createListMcpResourcesTool, createReadMcpResourceTool, createUiTools, createAskUserTool, createTodoWriteTool, getTodosForSession, deleteTodosForSession, createSendMessageTool, createSystemTools, createSleepTool, createCronCreateTool, createCronDeleteTool, createCronListTool, createEnterPlanModeTool, createExitPlanModeTool, createSkillTool, createConfigTool, listCronJobs, deleteCronJob, createCronJob, deleteJobsForSession, createAgentTools, createRunAgentTool, createStandardTools, } from './tools/index.js';
// ── Workflow system ───────────────────────────────────────────────────────────
export { WorkflowLoader } from './workflow/WorkflowLoader.js';
export { WorkflowParser } from './workflow/WorkflowParser.js';
export { WorkflowStateStore } from './workflow/WorkflowStateStore.js';
export { buildW1Section } from './workflow/dynamicSection.js';
export { createWorkflowStatusTool, createWorkflowCompleteGateTool, createWorkflowAdvanceTool, createWorkflowListPhasesTool, createWorkflowTools, } from './workflow/tools/index.js';
// ── Robotics mode ─────────────────────────────────────────────────────────────
export { RoboticsSession } from './robotics/RoboticsSession.js';
export { ExperienceStore } from './robotics/ExperienceStore.js';
export { HardwareProfile } from './robotics/HardwareProfile.js';
export { GitWorkspaceManager } from './robotics/git/GitWorkspaceManager.js';
export { RoboticsProjectStore } from './robotics/persistence/RoboticsProjectStore.js';
export { createRoboticsTools, createExperienceSearchTool, createExperienceWriteTool, createExperienceLoadTool, createHardwareProfileReadTool, createHardwareProfileWriteTool, createExperimentDispatchTool, createPaperSearchTool, createProgressNoteTool, createGitSyncToSubAgentTool, createGitMergeSubAgentTool, createGitDiffSubAgentTool, createGitDiscardSubAgentTool, } from './robotics/tools/index.js';
export { buildR1Section, buildR2Section, buildR3Section, buildR4Section, buildR5Section, } from './robotics/dynamicSections.js';
export { makeExperienceId } from './robotics/types.js';
//# sourceMappingURL=index.js.map
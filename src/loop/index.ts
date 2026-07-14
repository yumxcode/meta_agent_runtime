/**
 * loop — auto_orch v2: charter-driven long-horizon loop runtime.
 * See docs/auto-orch-v2-design.md (concepts) and docs/auto-orch-v2-spec.md
 * (component contracts, milestones).
 */
export * from './types.js'
export * from './expr/Expr.js'
export * from './charter/CharterTypes.js'
export { validateCharter, freezeCharter } from './charter/CharterValidate.js'
export { CharterStore, type CharterRef } from './charter/CharterStore.js'
export { Ledger, withBuiltinSchemas, type LedgerView, type ProgressView } from './ledger/LedgerApi.js'
export { WakeStore, type WakeRecord, type WakeKind } from './wake/WakeStore.js'
export { buildCapsule, renderCapsule, type Capsule } from './capsule/CapsuleBuilder.js'
export { createInstance, loadInstance, setInstanceStatus, type LoopInstance } from './instance/InstanceStore.js'
export { runRound, type RoundOutcome } from './kernel/LoopKernel.js'
export { tickOnce, runUntilQuiescent, type TickDeps, type TickResult } from './runner.js'
export { runLoopCli, type LoopCliDeps } from './cli.js'
export { EffectLedger, type EffectRecord, type EffectStatus } from './effects/EffectLedger.js'
export {
  EffectAdapterRegistry, EffectConfigurationError, EVENT_EFFECT_ADAPTER_ID, defaultEffectAdapterRegistry,
  type EffectAdapter, type EffectAdapterContext, type EffectInspection,
  type EffectCancellation, type EffectSubmitResult, type EffectAdmissionPolicy,
} from './effects/EffectAdapter.js'
export { submitEffect, advanceEffect, cancelEffect, type SubmitEffectInput } from './effects/EffectRuntime.js'
export { evaluateEffectRules, type EffectRuleDecision } from './effects/EffectRules.js'
export {
  signEffectEvent, verifyEffectEvent, writeAuthenticatedEffectEvent,
  type AuthenticatedEffectEvent,
} from './effects/EventAuth.js'
export { ingestEvents, reconcileWaiting, readPendingRound } from './effects/WaitOps.js'
export {
  runLoopScheduler, acquireDaemonLock, releaseDaemonLock,
  type DaemonOptions, type DaemonResult,
} from './daemon.js'
export {
  ensureWorkspaceIdentity, readWorkspaceIdentity, forkWorkspaceIdentity,
  canonicalWorkspaceRoot, workspaceIdentityPath, workspaceScopedLineage,
  withWorkspaceOperationLock,
  type WorkspaceIdentity, type ExecutionScope,
} from './workspace/WorkspaceIdentity.js'
export {
  HostSchedulerCoordinator, WorkspaceIdentityConflictError, adapterResourceId,
  type HostCoordinatorOptions, type HostCoordinatorSnapshot,
  type HostAdmissionHandle, type HostAdmissionLease, type HostResourceRequirement,
  type WorkspaceSchedulerLease,
} from './host/HostSchedulerCoordinator.js'
export {
  distillCharter, DISTILLER_SYSTEM, buildDistillerSystem, parseDistillOutput,
  type DistillResult, type DistillDeps, type DistillerPromptCatalog,
} from './distill/Distiller.js'
export { migrateInstance, type MigrationEntry } from './instance/Migrate.js'
export { spawnAndWait, type SpawnWaitOptions } from './seatSpawn.js'
export type { LoopEvent } from './kernel/LoopKernel.js'
export {
  scenarioRuntimeFor,
  registeredScenarioIds,
  DEFAULT_SCENARIO_ID,
  GENERIC_SCENARIO_ID,
  RELEASE_SCENARIO_ID,
  COMPLIANCE_SCENARIO_ID,
  type ScenarioRuntime,
} from './scenarios/ScenarioRuntime.js'
export {
  ScenarioRegistry,
  ScenarioPluginError,
} from './scenarios/ScenarioRegistry.js'
export {
  SCENARIO_PLUGIN_API_VERSION,
  type ScenarioPluginV1,
  type ScenarioPluginManifest,
  type FrozenScenarioPluginRef,
  type ScenarioCapsuleView,
  type ScenarioCapsuleSection,
  type ScenarioJson,
} from './scenarios/ScenarioPlugin.js'
export {
  builtinScenarioPlugins,
  createBuiltinScenarioRegistry,
  defaultScenarioRegistry,
} from './scenarios/BuiltinScenarioPlugins.js'
export { loadScenarioPlugins } from './scenarios/ScenarioLoader.js'
export {
  executeArtifactTransaction,
  materializeArtifactStreams,
  type ArtifactLedgerEvent,
  type ArtifactTransactionResult,
} from './artifacts/ArtifactExecutor.js'
export {
  commitRoundArtifacts,
  readArtifactDrafts,
  type ArtifactPipelineResult,
} from './artifacts/ArtifactPipeline.js'
export {
  readArtifactJournal,
  sealArtifactJournalIfNeeded,
  loadArtifactSegmentManifest,
  ArtifactJournalCorruptionError,
  type ArtifactSegment,
  type ArtifactSegmentManifest,
  type ArtifactJournalCursor,
} from './artifacts/ArtifactSegmentStore.js'
export {
  indexCommittedArtifactEvents,
  findCommittedArtifactTransaction,
  ensureVersionedContentIndex,
  ArtifactIndexCorruptionError,
} from './artifacts/ArtifactIndexes.js'
export {
  refreshArtifactCheckpoint,
  type ArtifactCheckpoint,
  type ArtifactProjectionView,
  type ArtifactStreamState,
} from './projection/ArtifactCheckpoint.js'

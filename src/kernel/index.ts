/**
 * @meta-agent/cc-kernel — public API surface
 *
 * The library is intentionally thin: consumers get KernelSession as their
 * primary entry point, plus all the types they need to configure it and
 * consume its events.
 */

// ── Primary entry point ───────────────────────────────────────────────────────
export { KernelSession } from './KernelSession.js'
export type { ManualCompactResult } from './KernelSession.js'

// ── Configuration types ───────────────────────────────────────────────────────
export type {
  KernelConfig,
  CompactConfig,
  ThinkingConfig,
  AutoGateFailurePolicy,
  CanUseToolFn,
  CanUseToolResult,
} from './types/KernelConfig.js'

// ── Event types ───────────────────────────────────────────────────────────────
export type {
  KernelEvent,
  TextDeltaEvent,
  ToolUseEvent,
  ToolResultEvent,
  CompactBoundaryEvent,
  ApiRetryEvent,
  ToolUseSummaryEvent,
  SystemMessageEvent,
  ResultEvent,
  ResultSubtype,
  PermissionDenial,
} from './types/KernelEvent.js'

// ── Event schema (the frozen wire contract) ──────────────────────────────────
export {
  EVENT_SCHEMA_VERSION,
  KERNEL_EVENT_TYPES,
  kernelEventSchema,
  kernelEventJsonSchema,
  kernelEventSchemaFingerprint,
  validateKernelEvent,
  validateEventOfType,
} from './events/schema.js'
export type {
  KernelEventType,
  EventValidationResult,
  KernelEventJsonSchema,
} from './events/schema.js'

// ── Telemetry ─────────────────────────────────────────────────────────────────
export {
  TelemetryRecorder,
  createTelemetryRecorder,
  defaultTelemetryDir,
} from './telemetry/recorder.js'
export { TelemetryAggregator, rollupSummaries } from './telemetry/aggregate.js'
export { JsonlTelemetrySink, OtlpTelemetrySink, MultiSink } from './telemetry/sinks.js'
export type {
  TelemetryConfig,
  TelemetryRecord,
  TelemetrySummary,
  TelemetrySink,
} from './telemetry/types.js'
export type { TelemetryRollup } from './telemetry/aggregate.js'

// ── External lifecycle hooks ─────────────────────────────────────────────────
export { HookRunner, createHookRunner, hookMatchesTool, parseHookDecision } from './hooks/HookRunner.js'
export { HOOK_EVENT_NAMES, DECIDING_HOOK_EVENTS, INJECTING_HOOK_EVENTS } from './hooks/types.js'
export type {
  HookEventName,
  HookDefinition,
  HookDecision,
  HookPayload,
  HookOutcome,
  HooksConfig,
} from './hooks/types.js'

// ── Declarative command rules ────────────────────────────────────────────────
export {
  builtinCommandRules,
  mergeCommandRules,
  compileCommandRules,
  loadCommandRules,
} from './permissions/CommandRules.js'
export type {
  CommandRule,
  CommandRuleAction,
  CommandRulesConfig,
  CompiledCommandRules,
} from './permissions/CommandRules.js'

// ── Tool interface ────────────────────────────────────────────────────────────
export type {
  KernelTool,
  KernelToolContext,
  KernelToolResult,
  ToolInputJSONSchema,
  ZodCompatSchema,
  ToolPermissionContext,
} from './types/KernelTool.js'

// ── Message types ─────────────────────────────────────────────────────────────
export type {
  KernelMessage,
  ContentBlock,
  MessageRole,
} from './types/KernelMessage.js'

export {
  makeUserMessage,
  makeAssistantMessage,
  makeTextUserMessage,
  makeToolResultMessage,
  makeInterruptionMessage,
  makeSystemMessage,
} from './messages/MessageFactory.js'

/**
 * Boundary slicing used by the kernel query path on every turn. Exported so
 * persistence callers (loop lineage seats) can store exactly what will still
 * be sent, instead of re-writing a prefix that is provably dead.
 */
export { getMessagesAfterCompactBoundary } from './messages/MessageNormalizer.js'

// ── Token usage / cost ────────────────────────────────────────────────────────
export type { TokenUsage } from './types/TokenUsage.js'
export { emptyUsage, addUsage } from './types/TokenUsage.js'
export { calcCostUsd } from './utils/CostTracker.js'

// ── File state cache ─────────────────────────────────────────────────────────
export { FileStateCache, cloneFileStateCache, createFileStateCacheWithSizeLimit } from './session/FileStateCache.js'

// ── Compact utilities ─────────────────────────────────────────────────────────
export { compactConversation } from './compact/CompactConversation.js'
export { buildCompactPrompt, formatCompactSummary } from './compact/CompactPrompt.js'

// ── Context window utils ─────────────────────────────────────────────────────
export { getContextWindowSize, calculateTokenWarningState } from './utils/Context.js'

// ── Permission helpers ────────────────────────────────────────────────────────
export { defaultCanUseTool } from './permissions/CanUseTool.js'
export { createPermissionPolicy } from './permissions/PermissionPolicy.js'
export type {
  PermissionConfig,
  PermissionPolicyOptions,
  ToolPermissionOverride,
} from './permissions/PermissionPolicy.js'
